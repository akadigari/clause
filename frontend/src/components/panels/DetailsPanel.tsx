/**
 * The Details panel: what the file says about itself, and the button that
 * takes it all back out.
 *
 * The form is a copy of the file's properties, not a live view of them. It is
 * filled on open and again after every edit, because most operations rebuild
 * the document and pdf-lib puts its own name in the producer line when they
 * do. Reading again after each version keeps the boxes honest instead of
 * showing what was in the file two edits ago.
 */

import { useEffect, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { Metadata } from "../../lib/pdf/ops/meta";
import { bytes, plural } from "../../lib/format";
import { IconTrash } from "../Icons";

/** The six editable properties, all as strings, because that is what a text
 *  box holds. Keywords are one comma separated line here and a list in the
 *  file. */
type Form = {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
};

const EMPTY: Form = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
};

function toForm(meta: Metadata): Form {
  return {
    title: meta.title,
    author: meta.author,
    subject: meta.subject,
    keywords: meta.keywords.join(", "),
    creator: meta.creator,
    producer: meta.producer,
  };
}

function splitKeywords(text: string): string[] {
  return text
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/** Dates are shown the way this machine writes a date, not in the PDF's own
 *  format, which is a run of digits nobody can read. */
function showDate(when: Date | null): string {
  if (!when) return "not set";
  return when.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A thrown value as a sentence. Operations raise an error carrying a hint, and
 * the hint is the half that says what to do about it. Read off the object
 * rather than imported, because importing the error class would pull the whole
 * pdf layer in before anyone opened this panel.
 */
function reason(err: unknown): string {
  if (err instanceof Error) {
    const hint = (err as { hint?: string }).hint;
    return hint ? `${err.message} ${hint}` : err.message;
  }
  return String(err);
}

export default function DetailsPanel({ doc, session }: PanelProps) {
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { readMetadata } = await import("../../lib/pdf/ops/meta");
        const read = await readMetadata(doc.bytes);
        // The panel may have been closed, or a later edit may have landed,
        // while the file was being read.
        if (!live) return;
        setMeta(read);
        setForm(toForm(read));
      } catch (err) {
        if (live) session.say(reason(err), "bad");
      }
    })();
    return () => {
      live = false;
    };
    // The version is the only dependency on purpose. The bytes change with it,
    // and the session is a fresh object on every render, so listing it here
    // would re-read the file every time a toast appears.
  }, [doc.version]);

  const ready = meta !== null;
  const busy = session.busy !== null;

  function set(key: keyof Form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // Only the boxes that were actually changed get sent. writeMetadata leaves
  // anything it was not passed alone, so an untouched file keeps whatever odd
  // entries it came with.
  const was = meta ? toForm(meta) : EMPTY;
  const patch: Partial<Metadata> = {};
  if (ready) {
    if (form.title !== was.title) patch.title = form.title;
    if (form.author !== was.author) patch.author = form.author;
    if (form.subject !== was.subject) patch.subject = form.subject;
    if (form.keywords !== was.keywords) patch.keywords = splitKeywords(form.keywords);
    if (form.creator !== was.creator) patch.creator = form.creator;
    if (form.producer !== was.producer) patch.producer = form.producer;
  }
  const edits = Object.keys(patch).length;

  function save() {
    if (edits === 0) return;
    const label = `Saved ${edits} ${plural(edits, "detail")}`;
    void session.apply(label, async (current) => {
      const { writeMetadata } = await import("../../lib/pdf/ops/meta");
      return writeMetadata(current, patch);
    });
  }

  function clearAll() {
    void session.apply("Cleared the document details", async (current) => {
      const { stripMetadata } = await import("../../lib/pdf/ops/meta");
      return stripMetadata(current);
    });
  }

  const held = busy ? "Wait for the job that is running to finish." : undefined;
  const reading = ready ? undefined : "Still reading the details out of the file.";
  const blocked = held ?? reading;
  const noEdits = edits === 0 ? "Change one of the boxes above first." : undefined;

  return (
    <>
      <div className="inspector-body">
        <div className="panel-section">
          <span className="label">What the file says</span>

          <div className="field">
            <label className="label" htmlFor="meta-title">
              Title
            </label>
            <input
              id="meta-title"
              className="input"
              type="text"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              disabled={!ready}
              title={reading}
              placeholder="Not set"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="meta-author">
              Author
            </label>
            <input
              id="meta-author"
              className="input"
              type="text"
              value={form.author}
              onChange={(e) => set("author", e.target.value)}
              disabled={!ready}
              title={reading}
              placeholder="Not set"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="meta-subject">
              Subject
            </label>
            <input
              id="meta-subject"
              className="input"
              type="text"
              value={form.subject}
              onChange={(e) => set("subject", e.target.value)}
              disabled={!ready}
              title={reading}
              placeholder="Not set"
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="meta-keywords">
              Keywords, separated by commas
            </label>
            <input
              id="meta-keywords"
              className="input"
              type="text"
              value={form.keywords}
              onChange={(e) => set("keywords", e.target.value)}
              disabled={!ready}
              title={reading}
              placeholder="lease, 2026, draft"
            />
          </div>

          <div className="row">
            <div className="field">
              <label className="label" htmlFor="meta-creator">
                Made with
              </label>
              <input
                id="meta-creator"
                className="input"
                type="text"
                value={form.creator}
                onChange={(e) => set("creator", e.target.value)}
                disabled={!ready}
                title={reading ?? "The app the document was written in, such as Word."}
                placeholder="Not set"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="meta-producer">
                Written by
              </label>
              <input
                id="meta-producer"
                className="input"
                type="text"
                value={form.producer}
                onChange={(e) => set("producer", e.target.value)}
                disabled={!ready}
                title={reading ?? "The tool that wrote the PDF itself, such as Distiller."}
                placeholder="Not set"
              />
            </div>
          </div>
        </div>

        <div className="panel-section">
          <span className="label">Set by the file, not by you</span>
          <div className="results">
            <div className="result">
              <span className="rname">Created</span>
              <span className="rsize num">{showDate(meta?.created ?? null)}</span>
            </div>
            <div className="result">
              <span className="rname">Last changed</span>
              <span className="rsize num">{showDate(meta?.modified ?? null)}</span>
            </div>
            <div className="result">
              <span className="rname">Pages</span>
              <span className="rsize num">{doc.pageCount}</span>
            </div>
            <div className="result">
              <span className="rname">Marked encrypted</span>
              <span className="rsize">{meta?.encrypted ? "Yes" : "No"}</span>
            </div>
            <div className="result">
              <span className="rname">Size on disk</span>
              <span className="rsize num">{bytes(doc.bytes.byteLength)}</span>
            </div>
          </div>
        </div>

        <div className="panel-section">
          <span className="label">Clear everything</span>
          <p className="tradeoff">
            Clearing wipes the title, author, subject, keywords, creator and producer, and resets
            both dates, so the file <b>no longer says who made it or when</b>. What it does not
            touch is anything printed into the pages themselves: a scanner's watermark, a
            letterhead, or a name inside an image somebody dropped onto the page. Those are part of
            the picture, not part of the details, and they stay. Use the Redact tool to take them
            out.
          </p>
          <button
            type="button"
            className="btn danger wide"
            onClick={clearAll}
            disabled={busy}
            title={held ?? "Undo puts the details back."}
          >
            <IconTrash size={16} />
            Clear all details
          </button>
        </div>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={save}
          disabled={Boolean(blocked) || edits === 0}
          title={blocked ?? noEdits ?? `Writes ${edits} ${plural(edits, "change")} into the file.`}
        >
          Save these details
        </button>
      </div>
    </>
  );
}
