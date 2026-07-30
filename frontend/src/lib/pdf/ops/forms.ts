/**
 * AcroForm fields: read them, fill them, flatten them.
 *
 * The rule this file is built around is that filling a form must never fail
 * quietly. pdf-lib will happily let you set a value on nothing at all, and its
 * dropdown setter silently turns the field into a free text box when you hand
 * it an option the field does not offer. Both of those end with somebody
 * emailing a form they believe is filled in and is not, so both are turned
 * into errors here that name the field.
 *
 * Flattening has the same problem pointed the other way. pdf-lib draws every
 * widget it can find, including the ones the file marks hidden, so a field the
 * reader never showed anybody gets printed onto the page. Those are thrown
 * away here instead of drawn.
 *
 * XFA forms (the LiveCycle kind, usually from older government sites) are not
 * AcroForms. pdf-lib strips the XFA data on open and what is left is whatever
 * AcroForm skeleton the file carried, which is often empty. Those files read
 * back as having no fields, which is honest: this tool cannot fill them.
 */

import type {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFForm,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFTextField,
} from "pdf-lib";
import { PdfOpError, breathe, copyBytes, loadPdf, pdfLib, savePdf } from "./common";

type PdfLibModule = Awaited<ReturnType<typeof pdfLib>>;

/** One clickable box belonging to a field. pdf-lib does not export the type. */
type Widget = ReturnType<PDFField["acroField"]["getWidgets"]>[number];

export type FieldType =
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "optionlist"
  | "button"
  | "signature"
  | "unknown";

export type FormField = {
  /** The fully qualified name, which is what fillForm matches on. */
  name: string;
  type: FieldType;
  /** Text for text and radio, a flag for checkboxes, a list for the pickers. */
  value: string | boolean | string[];
  /** Only the three picker types have these. */
  options?: string[];
  /** Dropdowns and option lists only. True when the file itself allows more
   *  than one choice, which is what fillForm enforces. A control that offers
   *  a tick box per option on a field where this is false builds a value the
   *  fill has to refuse. */
  multiple?: boolean;
  /** Dropdowns only. True when the author allowed typing a value that is not
   *  on the list, which is the "Other, please specify" box. */
  editable?: boolean;
  readOnly: boolean;
  required: boolean;
  /** Zero based, same as everywhere else in this app. Missing if the field has
   *  no widget on any page, which happens with hidden calculation fields. */
  page?: number;
};

/** Fields are read one at a time, and a batch this size yields to the browser. */
const FIELDS_PER_BREATH = 64;

/**
 * The form, but only if the file actually has one.
 *
 * doc.getForm() creates an empty AcroForm when the document has none, so
 * anything that must not change the file asks the catalog first.
 */
function existingForm(doc: PDFDocument): PDFForm | undefined {
  try {
    if (!doc.catalog.getAcroForm()) return undefined;
    return doc.getForm();
  } catch {
    return undefined;
  }
}

/** getFields() walks the field tree and a damaged tree throws part way. */
function fieldsOf(form: PDFForm): PDFField[] {
  try {
    return form.getFields();
  } catch {
    return [];
  }
}

function nameOf(field: PDFField): string {
  try {
    return field.getName();
  } catch {
    return "";
  }
}

function classify(field: PDFField, lib: PdfLibModule): FieldType {
  if (field instanceof lib.PDFTextField) return "text";
  if (field instanceof lib.PDFCheckBox) return "checkbox";
  if (field instanceof lib.PDFRadioGroup) return "radio";
  if (field instanceof lib.PDFDropdown) return "dropdown";
  if (field instanceof lib.PDFOptionList) return "optionlist";
  if (field instanceof lib.PDFButton) return "button";
  if (field instanceof lib.PDFSignature) return "signature";
  return "unknown";
}

/**
 * Every object reference that identifies a page, mapped to that page's index.
 *
 * Both the page itself and each of its annotations go in, because a widget
 * points back at its page with /P on well made files and is only reachable
 * through the page's /Annots array on the rest. One pass over the document
 * beats searching the page list once per field on a 500 field tax form.
 */
function pageLookup(doc: PDFDocument, lib: PdfLibModule): Map<string, number> {
  const map = new Map<string, number>();
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page) continue;
    map.set(page.ref.tag, i);
    let annots;
    try {
      annots = page.node.Annots();
    } catch {
      continue;
    }
    if (!annots) continue;
    for (const entry of annots.asArray()) {
      if (entry instanceof lib.PDFRef) map.set(entry.tag, i);
    }
  }
  return map;
}

function pageOf(
  field: PDFField,
  doc: PDFDocument,
  lookup: Map<string, number>,
): number | undefined {
  let widgets;
  try {
    widgets = field.acroField.getWidgets();
  } catch {
    return undefined;
  }
  for (const widget of widgets) {
    const parent = widget.P();
    if (parent) {
      const viaParent = lookup.get(parent.tag);
      if (viaParent !== undefined) return viaParent;
    }
    const own = doc.context.getObjectRef(widget.dict);
    if (own) {
      const viaAnnots = lookup.get(own.tag);
      if (viaAnnots !== undefined) return viaAnnots;
    }
  }
  return undefined;
}

/**
 * Current value and choices for one field.
 *
 * Any single field can throw: rich text fields refuse getText() outright, and
 * a truncated file can leave a picker without its option array. One bad field
 * out of forty should not stop you seeing the other thirty nine, so a failed
 * read comes back empty instead of taking the whole document down.
 */
function readOne(
  field: PDFField,
  type: FieldType,
): {
  value: string | boolean | string[];
  options?: string[];
  multiple?: boolean;
  editable?: boolean;
} {
  try {
    switch (type) {
      case "text":
        return { value: (field as PDFTextField).getText() ?? "" };
      case "checkbox":
        return { value: (field as PDFCheckBox).isChecked() };
      case "radio": {
        const radio = field as PDFRadioGroup;
        return { value: radio.getSelected() ?? "", options: radio.getOptions() };
      }
      case "dropdown": {
        const drop = field as PDFDropdown;
        return {
          value: drop.getSelected(),
          options: drop.getOptions(),
          multiple: safeFlag(() => drop.isMultiselect()),
          editable: safeFlag(() => drop.isEditable()),
        };
      }
      case "optionlist": {
        const list = field as PDFOptionList;
        return {
          value: list.getSelected(),
          options: list.getOptions(),
          multiple: safeFlag(() => list.isMultiselect()),
        };
      }
      default:
        // Buttons and signatures hold no value anyone can type.
        return { value: "" };
    }
  } catch {
    return { value: type === "checkbox" ? false : "" };
  }
}

/** Every fillable field in the document, in the order the file lists them. */
export async function readForm(bytes: Uint8Array): Promise<FormField[]> {
  const doc = await loadPdf(bytes);
  const form = existingForm(doc);
  if (!form) return [];

  const lib = await pdfLib();
  const fields = fieldsOf(form);
  if (fields.length === 0) return [];

  const lookup = pageLookup(doc, lib);
  const out: FormField[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const type = classify(field, lib);
    const read = readOne(field, type);
    const entry: FormField = {
      name: nameOf(field),
      type,
      value: read.value,
      readOnly: safeFlag(() => field.isReadOnly()),
      required: safeFlag(() => field.isRequired()),
    };
    if (read.options) entry.options = read.options;
    if (read.multiple !== undefined) entry.multiple = read.multiple;
    if (read.editable !== undefined) entry.editable = read.editable;
    const page = pageOf(field, doc, lookup);
    if (page !== undefined) entry.page = page;
    out.push(entry);
    if (i % FIELDS_PER_BREATH === FIELDS_PER_BREATH - 1) await breathe();
  }

  return out;
}

function safeFlag(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

/** True when there is at least one field somebody could fill in. */
export async function hasForm(bytes: Uint8Array): Promise<boolean> {
  const doc = await loadPdf(bytes);
  const form = existingForm(doc);
  if (!form) return false;
  return fieldsOf(form).length > 0;
}

function quoteList(names: string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

/** The same wording for every "you picked something not on the list" case. */
function notAnOption(name: string, bad: string[], allowed: string[]): PdfOpError {
  return new PdfOpError(
    `${quoteList(bad)} is not one of the choices "${name}" offers.`,
    allowed.length > 0
      ? `That field accepts: ${quoteList(allowed)}.`
      : "That field lists no choices at all, so nothing can be selected in it.",
  );
}

function wrongShape(name: string, type: FieldType, wanted: string): PdfOpError {
  return new PdfOpError(
    `"${name}" is a ${type} field, so it needs ${wanted}.`,
    "Read the form first to see what type each field is.",
  );
}

/** Reading a number off a field can throw the same way reading a value can. */
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function setOne(
  field: PDFField,
  type: FieldType,
  name: string,
  value: string | boolean | string[],
): void {
  switch (type) {
    case "text": {
      if (typeof value !== "string") throw wrongShape(name, type, "a string");
      const text = field as PDFTextField;
      // Government forms print into boxes and cap the field at the number of
      // boxes. pdf-lib throws its own error for this, which reads like a bug
      // report, so the limit is checked here and explained instead.
      const limit = safeNumber(() => text.getMaxLength());
      if (limit !== undefined && value.length > limit) {
        throw new PdfOpError(
          `"${name}" holds at most ${limit} characters and you gave it ${value.length}.`,
          "The form itself sets that limit, usually because the value is printed into a row of boxes. Shorten it to fit.",
        );
      }
      text.setText(value);
      return;
    }
    case "checkbox": {
      if (typeof value !== "boolean") throw wrongShape(name, type, "true or false");
      const box = field as PDFCheckBox;
      if (value) box.check();
      else box.uncheck();
      return;
    }
    case "radio": {
      if (typeof value !== "string") throw wrongShape(name, type, "a single string");
      const radio = field as PDFRadioGroup;
      if (value === "") {
        radio.clear();
        return;
      }
      const allowed = radio.getOptions();
      if (!allowed.includes(value)) throw notAnOption(name, [value], allowed);
      radio.select(value);
      return;
    }
    case "dropdown":
    case "optionlist": {
      if (typeof value === "boolean") {
        throw wrongShape(name, type, "a string or a list of strings");
      }
      const picker = field as PDFDropdown | PDFOptionList;
      const wanted = typeof value === "string" ? (value === "" ? [] : [value]) : value;
      if (wanted.length === 0) {
        picker.clear();
        return;
      }
      // Handing pdf-lib two values for a single choice field turns the flag on
      // instead of complaining, and the form is then a different form from the
      // one the author wrote. Readers only ever show one of the two anyway.
      if (wanted.length > 1 && !safeFlag(() => picker.isMultiselect())) {
        throw new PdfOpError(
          `"${name}" takes one choice and ${wanted.length} were given.`,
          "The file marks this field as single choice. Filling two would rewrite that part of the form, so pick one.",
        );
      }
      // pdf-lib's dropdown quietly turns itself into a free text box when it
      // is handed an unknown option, which is how a typo becomes a value no
      // reader will ever show in the list. Check before calling it. A dropdown
      // the author already made editable is the one case where a value off the
      // list is the point of the field, so that one is allowed through.
      const allowed = picker.getOptions();
      const bad = wanted.filter((w) => !allowed.includes(w));
      const editable =
        type === "dropdown" && safeFlag(() => (field as PDFDropdown).isEditable());
      if (bad.length > 0 && !editable) throw notAnOption(name, bad, allowed);
      picker.select(wanted);
      return;
    }
    default:
      throw new PdfOpError(
        `"${name}" is a ${type} field, which holds no value to fill in.`,
        "Signature and button fields have to be handled by a signing tool, not a text value.",
      );
  }
}

/**
 * Put values into named fields.
 *
 * A name that is not in the document is an error, not a shrug. Read only
 * fields are filled anyway: the flag is the form author's advice to a reader,
 * not a lock, and refusing would block the common case of a form that marks
 * everything read only after it was generated.
 */
export async function fillForm(
  bytes: Uint8Array,
  values: Record<string, string | boolean | string[]>,
): Promise<Uint8Array> {
  const wanted = Object.keys(values);
  if (wanted.length === 0) return copyBytes(bytes);

  const doc = await loadPdf(bytes);
  const form = existingForm(doc);
  const fields = form ? fieldsOf(form) : [];

  if (!form || fields.length === 0) {
    throw new PdfOpError(
      "This PDF has no form fields, so there is nothing to fill in.",
      "Scanned forms are pictures of a form, not a form. Use the text and stamp tools on those.",
    );
  }

  // A name can appear twice. It is not supposed to, but generated forms do it,
  // and keeping only the last one means the first copy stays empty while the
  // caller is told the value went in. Every field with the name gets it.
  const byName = new Map<string, PDFField[]>();
  for (const field of fields) {
    const key = nameOf(field);
    const same = byName.get(key);
    if (same) same.push(field);
    else byName.set(key, [field]);
  }

  const missing = wanted.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new PdfOpError(
      `This PDF has no field named ${quoteList(missing)}.`,
      "Names are case sensitive and often have a prefix like \"topmostSubform[0]\". Read the form first to get them exactly.",
    );
  }

  const lib = await pdfLib();
  let done = 0;
  for (const name of wanted) {
    const value = values[name] as string | boolean | string[];
    for (const field of byName.get(name) ?? []) {
      try {
        setOne(field, classify(field, lib), name, value);
      } catch (err) {
        // Anything pdf-lib throws from here names the field in its own words,
        // which read like a stack trace. The UI treats an error that is not a
        // PdfOpError as a bug in this app, so nothing raw gets past this line.
        throw err instanceof PdfOpError ? err : setValueError(name, err);
      }
      done++;
      if (done % FIELDS_PER_BREATH === 0) await breathe();
    }
  }

  try {
    return await savePdf(doc);
  } catch (err) {
    throw fillSaveError(err);
  }
}

/** Last resort wording for a field that refused a value for its own reasons. */
function setValueError(name: string, err: unknown): PdfOpError {
  const message = err instanceof Error ? err.message : String(err);
  return new PdfOpError(
    `The value for "${name}" is not one this field will take.`,
    `The form said: ${message}`,
  );
}

/**
 * Saving draws the new values, and that is where a font problem shows up.
 *
 * The built in fonts only cover Western European characters, so a name with
 * Chinese, Arabic, Cyrillic or Greek in it throws at draw time rather than at
 * set time. The message pdf-lib gives is accurate but unreadable, so it gets
 * translated here.
 */
function fillSaveError(err: unknown): PdfOpError {
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot encode/i.test(message)) {
    return new PdfOpError(
      "The text you entered uses characters the form's built in font cannot draw.",
      "Form fields are drawn with a basic Western European font. Accented Latin is fine, but Chinese, Arabic, Cyrillic and Greek are not.",
    );
  }
  return new PdfOpError(
    "The filled values could not be written back into this PDF.",
    "The form is built in a way this tool cannot redraw. Filling it in a desktop reader will work.",
  );
}

/**
 * Turn the filled form into plain page content.
 *
 * This is what you do before sending a form out: after flattening the values
 * are part of the page and nobody can click them back to empty. It is one way,
 * so the caller keeps the unflattened copy in the undo stack.
 *
 * Hidden fields are dropped rather than drawn. See dropHiddenWidgets.
 */
export async function flattenForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const form = existingForm(doc);
  if (!form || fieldsOf(form).length === 0) {
    // Nothing to flatten is not a failure. Flatten runs as the last step of
    // an export chain, and a document with no form has to pass straight
    // through instead of stopping the chain with an error.
    return copyBytes(bytes);
  }

  const lib = await pdfLib();
  dropHiddenWidgets(doc, form, lib);

  try {
    form.flatten();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cannot encode/i.test(message)) {
      throw new PdfOpError(
        "The values in this form use characters the built in font cannot draw, so they cannot be flattened.",
        "Save it without flattening. The values stay in the file, they just stay editable.",
      );
    }
    throw new PdfOpError(
      "Some of this form's fields could not be drawn onto the page, so it cannot be flattened.",
      "This happens with fields that have no stored appearance, which pdf-lib cannot rebuild. Save it without flattening instead: the values are kept, they just stay editable.",
    );
  }

  dropDeadAnnotations(doc, lib);

  try {
    return await savePdf(doc);
  } catch (err) {
    throw fillSaveError(err);
  }
}

/** /F bit 2: do not show this on screen and do not print it either. */
const ANNOT_HIDDEN = 2;

/** Every appearance stream a widget points at, so one can be deleted with it. */
function appearanceRefs(widget: Widget, doc: PDFDocument, lib: PdfLibModule): PDFRef[] {
  const out: PDFRef[] = [];
  const ap = doc.context.lookup(widget.dict.get(lib.PDFName.of("AP")));
  if (!(ap instanceof lib.PDFDict)) return out;
  for (const key of ap.keys()) {
    const entry = ap.get(key);
    if (entry instanceof lib.PDFRef) {
      out.push(entry);
      continue;
    }
    // Checkboxes and radios keep one stream per state under /N.
    const states = doc.context.lookup(entry);
    if (!(states instanceof lib.PDFDict)) continue;
    for (const state of states.keys()) {
      const value = states.get(state);
      if (value instanceof lib.PDFRef) out.push(value);
    }
  }
  return out;
}

/**
 * Throw hidden fields away instead of printing them onto the page.
 *
 * pdf-lib's flatten draws every widget it finds, and it does not look at the
 * annotation's hidden flag. A form with a conditional section, or with a
 * working field that is only there to feed a calculation, carries values the
 * reader never showed anyone. Flatten as pdf-lib ships it stamps those onto
 * the visible page, so a field that said 123-45-6789 and was never on screen
 * becomes ink. Acrobat does not do that, and neither does printing.
 *
 * A hidden widget is unlinked from its field before flatten runs, which is
 * enough to keep it from being drawn, and its object and its appearance
 * streams are deleted so the value does not survive in the saved bytes either.
 * An appearance stream is only deleted when no widget that is staying shares
 * it. A field whose own dictionary is the widget ends up with an empty Kids
 * list, and pdf-lib's flatten then removes the field itself; dropDeadAnnotations
 * clears whatever /Annots entry is left pointing at it.
 */
function dropHiddenWidgets(doc: PDFDocument, form: PDFForm, lib: PdfLibModule): void {
  const doomed: { field: PDFField; widget: Widget; ref: PDFRef }[] = [];
  const staying: Widget[] = [];

  for (const field of fieldsOf(form)) {
    let widgets: Widget[];
    try {
      widgets = field.acroField.getWidgets();
    } catch {
      continue;
    }
    for (const widget of widgets) {
      const ref = doc.context.getObjectRef(widget.dict);
      const flags = safeNumber(() => widget.getFlags()) ?? 0;
      if (ref && (flags & ANNOT_HIDDEN) !== 0) doomed.push({ field, widget, ref });
      else staying.push(widget);
    }
  }
  if (doomed.length === 0) return;

  const keep = new Set<string>();
  for (const widget of staying) {
    for (const ref of appearanceRefs(widget, doc, lib)) keep.add(ref.tag);
  }

  for (const { field, widget, ref } of doomed) {
    let kids;
    try {
      kids = field.acroField.normalizedEntries().Kids;
    } catch {
      continue;
    }
    const at = kids.indexOf(ref);
    if (at === undefined || at < 0) continue;
    kids.remove(at);
    for (const apRef of appearanceRefs(widget, doc, lib)) {
      if (!keep.has(apRef.tag)) doc.context.delete(apRef);
    }
    if (ref.tag !== field.ref.tag) doc.context.delete(ref);
  }
}

/**
 * Clean up after pdf-lib's flatten.
 *
 * pdf-lib 1.17.1 removes a flattened field's object but hands the wrong
 * reference to the page when it tries to unlink the widget, so every page is
 * left pointing at an annotation that is no longer in the file. Most readers
 * ignore a pointer that goes nowhere, but "flattened" should mean the fields
 * are actually gone, so the dead entries are dropped here. Only entries that
 * no longer resolve are touched, which leaves real annotations such as links
 * alone.
 */
function dropDeadAnnotations(doc: PDFDocument, lib: PdfLibModule): void {
  for (const page of doc.getPages()) {
    let annots;
    try {
      annots = page.node.Annots();
    } catch {
      continue;
    }
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i);
      if (entry instanceof lib.PDFRef && doc.context.lookup(entry) === undefined) {
        annots.remove(i);
      }
    }
  }
}
