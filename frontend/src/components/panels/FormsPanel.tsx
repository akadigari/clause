/**
 * The Fields panel: fill in a form, and lock the answers if you are sending it.
 *
 * The fields are read back out of the current bytes every time the document
 * changes, because an edit made with another tool can add or remove them. What
 * someone types lives in this panel until they press a button, so the file is
 * never half filled in the middle of a keystroke.
 *
 * Only fields whose value actually changed are handed to fillForm. Writing the
 * whole form back would touch fields nobody edited, and on forms built by other
 * tools that is how a field that merely looked empty ends up genuinely empty.
 *
 * A failed fill leaves the typing alone: session.apply only bumps the document
 * on success, so the effect below does not re-run and nothing is lost when the
 * op rejects a value.
 */

import { useEffect, useId, useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { FieldType, FormField } from "../../lib/pdf/ops/forms";
import { plural } from "../../lib/format";
import { IconCheck, IconSpinner } from "../Icons";

/** What one control holds. Matches what fillForm takes for that field type. */
type Value = string | boolean | string[];

/** The types with something a person can put a value into. */
const FILLABLE: FieldType[] = ["text", "checkbox", "radio", "dropdown", "optionlist"];

const LOCKED = "The document marks this field read only, so it cannot be changed here.";

const WAIT = "Wait for the job that is running to finish.";

function canFill(field: FormField): boolean {
  return field.name !== "" && FILLABLE.includes(field.type);
}

/**
 * The field's stored value in the shape its control needs.
 *
 * Dropdowns and option lists come back from pdf-lib as arrays even when only
 * one choice is allowed, so the single choice controls take the first entry.
 */
function seedOf(field: FormField): Value {
  switch (field.type) {
    case "checkbox":
      return field.value === true;
    case "text":
    case "radio":
      return typeof field.value === "string" ? field.value : "";
    case "dropdown":
      if (Array.isArray(field.value)) return field.value[0] ?? "";
      return typeof field.value === "string" ? field.value : "";
    case "optionlist":
      if (Array.isArray(field.value)) return field.value;
      return typeof field.value === "string" && field.value !== "" ? [field.value] : [];
    default:
      return "";
  }
}

function same(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => entry === b[i]);
  }
  return a === b;
}

function isBlank(value: Value): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value === "" || value === false;
}

/** A thrown value as a sentence. The hint is the half that says what to do. */
function reason(err: unknown): string {
  if (err instanceof Error) {
    const hint = (err as { hint?: string }).hint;
    return hint ? `${err.message} ${hint}` : err.message;
  }
  return String(err);
}

/** What a field with no value of its own is for, said plainly. */
function describe(type: FieldType): string {
  if (type === "signature") return "A signature field. Draw and place a signature with the Sign tool.";
  if (type === "button") return "A button. It runs something in a reader, it does not hold a value.";
  return "This app cannot tell what kind of field this is, so it leaves it alone.";
}

export default function FormsPanel({ doc, session }: PanelProps) {
  const [fields, setFields] = useState<FormField[] | null>(null);
  const [values, setValues] = useState<Record<string, Value>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const uid = useId();

  useEffect(() => {
    let alive = true;
    setFields(null);
    setProblem(null);
    void (async () => {
      try {
        const { readForm } = await import("../../lib/pdf/ops/forms");
        const found = await readForm(doc.bytes);
        if (!alive) return;
        const seeded: Record<string, Value> = {};
        for (const field of found) {
          if (canFill(field)) seeded[field.name] = seedOf(field);
        }
        setFields(found);
        setValues(seeded);
      } catch (err) {
        if (!alive) return;
        setProblem(reason(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [doc.bytes, doc.version]);

  /** Only what someone actually edited, which is all fillForm should see. */
  const changes = useMemo(() => {
    const out: Record<string, Value> = {};
    if (!fields) return out;
    for (const field of fields) {
      if (!canFill(field) || field.readOnly) continue;
      const now = values[field.name];
      if (now === undefined) continue;
      if (!same(now, seedOf(field))) out[field.name] = now;
    }
    return out;
  }, [fields, values]);

  /** Fields the form itself marks as needed and that still hold nothing. */
  const stillNeeded = useMemo(() => {
    if (!fields) return 0;
    let count = 0;
    for (const field of fields) {
      if (!field.required || !canFill(field)) continue;
      const now = values[field.name] ?? seedOf(field);
      if (isBlank(now)) count++;
    }
    return count;
  }, [fields, values]);

  const busy = session.busy !== null;
  const edited = Object.keys(changes).length;

  function set(name: string, value: Value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function putBack() {
    if (!fields) return;
    const seeded: Record<string, Value> = {};
    for (const field of fields) {
      if (canFill(field)) seeded[field.name] = seedOf(field);
    }
    setValues(seeded);
  }

  function fillIn() {
    void session.apply(`Filled in ${edited} ${plural(edited, "field")}`, async (bytes) => {
      const { fillForm } = await import("../../lib/pdf/ops/forms");
      return fillForm(bytes, changes);
    });
  }

  function fillAndLock() {
    const total = fields?.length ?? 0;
    const label =
      edited > 0
        ? `Filled in ${edited} ${plural(edited, "field")} and locked the form`
        : `Locked ${total} ${plural(total, "field")} onto the page`;
    void session.apply(label, async (bytes) => {
      const { fillForm, flattenForm } = await import("../../lib/pdf/ops/forms");
      const filled = edited > 0 ? await fillForm(bytes, changes) : bytes;
      return flattenForm(filled);
    });
  }

  if (problem) {
    return (
      <div className="inspector-body">
        <p className="note cut">{problem}</p>
      </div>
    );
  }

  if (fields === null) {
    return (
      <div className="inspector-body">
        <p className="note">
          <IconSpinner size={14} /> Reading the fields in this document.
        </p>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="inspector-body">
        <p className="note">
          <strong>This PDF has no fillable fields.</strong> Nothing in it was built as a form, so
          there are no boxes to type into. A form that was scanned or printed flat is a picture of
          a form, and it reads this way too.
        </p>
        <p className="tradeoff">
          You can still write on it. The <b>Mark</b> tool puts text wherever you click, which is how
          you fill in a page that has no fields of its own.
        </p>
      </div>
    );
  }

  /** The name the document author gave the field, plus where it is and its flags. */
  function caption(field: FormField) {
    return (
      <>
        {field.name || "(this field has no name)"}
        {field.page !== undefined && (
          <>
            {" · page "}
            <span className="num">{field.page + 1}</span>
          </>
        )}
        {field.required && " · required"}
        {field.readOnly && " · locked"}
      </>
    );
  }

  function control(field: FormField, index: number) {
    const key = `${field.name}#${index}`;
    const id = `${uid}-${index}`;
    const now = values[field.name] ?? seedOf(field);
    const lock = field.readOnly ? LOCKED : undefined;

    if (field.type === "checkbox") {
      return (
        <div className="field" key={key}>
          <label className="switch">
            <input
              type="checkbox"
              checked={now === true}
              onChange={(e) => set(field.name, e.target.checked)}
              disabled={field.readOnly}
              title={lock}
            />
            <span className="track" />
            {caption(field)}
          </label>
        </div>
      );
    }

    if (field.type === "optionlist") {
      const chosen = Array.isArray(now) ? now : [];
      const options = field.options ?? [];
      return (
        <div className="field" key={key} role="group" aria-label={field.name}>
          <span className="label" title={field.name}>
            {caption(field)}
          </span>
          {options.length === 0 && (
            <p className="note">This list offers no choices, so there is nothing to pick.</p>
          )}
          {options.map((option) => (
            <label className="switch" key={option}>
              <input
                type="checkbox"
                checked={chosen.includes(option)}
                onChange={(e) =>
                  set(
                    field.name,
                    e.target.checked
                      ? [...chosen, option]
                      : chosen.filter((entry) => entry !== option),
                  )
                }
                disabled={field.readOnly}
                title={lock}
              />
              <span className="track" />
              {option}
            </label>
          ))}
        </div>
      );
    }

    if (field.type === "radio" || field.type === "dropdown") {
      const picked = typeof now === "string" ? now : Array.isArray(now) ? (now[0] ?? "") : "";
      const options = field.options ?? [];
      // A dropdown the author made editable can already hold something that is
      // not on the list. Showing the list without it would quietly change it.
      const shown = picked !== "" && !options.includes(picked) ? [picked, ...options] : options;
      return (
        <div className="field" key={key}>
          <label className="label" htmlFor={id} title={field.name}>
            {caption(field)}
          </label>
          <select
            id={id}
            className="select"
            value={picked}
            onChange={(e) => set(field.name, e.target.value)}
            disabled={field.readOnly}
            title={lock}
          >
            <option value="">Nothing picked</option>
            {shown.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (field.type === "text") {
      return (
        <div className="field" key={key}>
          <label className="label" htmlFor={id} title={field.name}>
            {caption(field)}
          </label>
          <input
            id={id}
            className="input"
            type="text"
            value={typeof now === "string" ? now : ""}
            onChange={(e) => set(field.name, e.target.value)}
            disabled={field.readOnly}
            title={lock}
          />
        </div>
      );
    }

    return (
      <div className="field" key={key}>
        <span className="label" title={field.name}>
          {caption(field)}
        </span>
        <p className="note">{describe(field.type)}</p>
      </div>
    );
  }

  const fillTitle = busy
    ? WAIT
    : edited === 0
      ? "Change at least one field first."
      : "The values stay editable in the file afterwards.";

  return (
    <>
      <div className="inspector-body">
        <div className={edited > 0 ? "selection" : "selection empty"}>
          <span>
            <b className="num">{edited}</b> of <span className="num">{fields.length}</span>{" "}
            {plural(fields.length, "field")} changed
          </span>
          <button
            type="button"
            className="btn sm"
            onClick={putBack}
            disabled={edited === 0}
            title={edited === 0 ? "Nothing has been changed yet." : "Back to what the file holds."}
          >
            Put values back
          </button>
        </div>

        {stillNeeded > 0 && (
          <p className="note warn">
            <span className="num">{stillNeeded}</span> {plural(stillNeeded, "field")} the form marks
            as required {plural(stillNeeded, "is", "are")} still empty.
          </p>
        )}

        <div className="panel-section">{fields.map(control)}</div>

        <p className="tradeoff">
          <b>Locking draws the answers onto the page and takes the boxes away.</b> That is what you
          want before sending a form to someone else, because nobody can click a value back to
          empty. Once the file is saved that way it cannot be unlocked from inside the file, though
          Undo here still works for as long as this tab is open.
        </p>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={fillIn}
          disabled={busy || edited === 0}
          title={fillTitle}
        >
          <IconCheck size={16} />
          Fill in <span className="num">{edited}</span> {plural(edited, "field")}
        </button>
        <button
          type="button"
          className="btn wide"
          onClick={fillAndLock}
          disabled={busy}
          title={busy ? WAIT : "Writes the answers onto the page and removes the fields."}
        >
          Fill in and lock
        </button>
      </div>
    </>
  );
}
