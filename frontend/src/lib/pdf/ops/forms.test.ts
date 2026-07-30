import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDict, PDFName, PDFNumber, PDFString, degrees } from "pdf-lib";
import { PdfOpError, blankPdf, loadPdf, savePdf } from "./common";
import { fillForm, flattenForm, hasForm, readForm } from "./forms";
import type { FormField } from "./forms";

/**
 * Is this text anywhere in the file, drawn or stored?
 *
 * Text in a content stream is written as hex and the stream is compressed, so
 * a plain search of the bytes finds nothing and proves nothing. This walks
 * every object, inflates what it can, and looks for both spellings.
 */
async function drawnSomewhere(bytes: Uint8Array, text: string): Promise<boolean> {
  const hex = [...text]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const doc = await loadPdf(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const stream = object as { getContents?: () => Uint8Array };
    let raw: string;
    if (typeof stream.getContents === "function") {
      const contents = stream.getContents();
      try {
        raw = inflateSync(Buffer.from(contents)).toString("latin1");
      } catch {
        raw = new TextDecoder("latin1").decode(contents);
      }
    } else {
      raw = String(object);
    }
    if (raw.includes(text) || raw.toUpperCase().includes(hex)) return true;
  }
  return false;
}

/**
 * A real AcroForm, built with pdf-lib so the test carries its own fixture.
 * Two pages, one field of every type this app claims to handle, and a read
 * only field with a value already in it.
 */
async function formFixture(): Promise<Uint8Array> {
  const doc = await blankPdf();
  const one = doc.addPage([612, 792]);
  const two = doc.addPage([612, 792]);
  const form = doc.getForm();

  const name = form.createTextField("applicant.name");
  name.enableRequired();
  name.addToPage(one, { x: 50, y: 700, width: 220, height: 20 });

  const agree = form.createCheckBox("agree");
  agree.addToPage(one, { x: 50, y: 660, width: 14, height: 14 });

  const colour = form.createDropdown("colour");
  colour.setOptions(["Red", "Green", "Blue"]);
  colour.select("Red");
  colour.addToPage(one, { x: 50, y: 620, width: 120, height: 20 });

  const plan = form.createRadioGroup("plan");
  plan.addOptionToPage("Monthly", two, { x: 50, y: 700, width: 14, height: 14 });
  plan.addOptionToPage("Yearly", two, { x: 50, y: 670, width: 14, height: 14 });

  const languages = form.createOptionList("languages");
  languages.setOptions(["EN", "FR", "DE"]);
  // A real multi choice list says so in the file. Without the flag, filling
  // two values would be rewriting the form rather than filling it in.
  languages.enableMultiselect();
  languages.addToPage(two, { x: 50, y: 560, width: 120, height: 60 });

  const reference = form.createTextField("reference");
  reference.setText("REF-001");
  reference.enableReadOnly();
  reference.addToPage(two, { x: 300, y: 700, width: 120, height: 20 });

  return savePdf(doc);
}

/** A plain document with no AcroForm at all. */
async function plainFixture(pages = 1): Promise<Uint8Array> {
  const doc = await blankPdf();
  for (let i = 0; i < pages; i++) doc.addPage([400, 500]);
  return savePdf(doc);
}

/** Run something that should fail and hand back the PdfOpError it threw. */
async function caught(run: () => Promise<unknown>): Promise<PdfOpError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PdfOpError) return err;
    throw err;
  }
  throw new Error("expected that to throw and it did not");
}

function byName(fields: FormField[], name: string): FormField {
  const found = fields.find((f) => f.name === name);
  if (!found) throw new Error(`fixture is missing the field "${name}"`);
  return found;
}

describe("readForm", () => {
  it("reports every field with its type, value, options and page", async () => {
    const fields = await readForm(await formFixture());
    expect(fields.map((f) => f.name).sort()).toEqual([
      "agree",
      "applicant.name",
      "colour",
      "languages",
      "plan",
      "reference",
    ]);

    const name = byName(fields, "applicant.name");
    expect(name.type).toBe("text");
    expect(name.value).toBe("");
    expect(name.required).toBe(true);
    expect(name.readOnly).toBe(false);
    expect(name.page).toBe(0);

    const agree = byName(fields, "agree");
    expect(agree.type).toBe("checkbox");
    expect(agree.value).toBe(false);
    expect(agree.page).toBe(0);

    const colour = byName(fields, "colour");
    expect(colour.type).toBe("dropdown");
    expect(colour.options).toEqual(["Red", "Green", "Blue"]);
    expect(colour.value).toEqual(["Red"]);
    // A control that offers two choices on a field that takes one builds a
    // value fillForm has to refuse, so the shape of the field is reported.
    expect(colour.multiple).toBe(false);
    expect(colour.editable).toBe(false);
    expect(byName(fields, "languages").multiple).toBe(true);
    expect(byName(fields, "applicant.name").multiple).toBeUndefined();

    const plan = byName(fields, "plan");
    expect(plan.type).toBe("radio");
    expect(plan.options).toEqual(["Monthly", "Yearly"]);
    expect(plan.value).toBe("");
    expect(plan.page).toBe(1);

    const languages = byName(fields, "languages");
    expect(languages.type).toBe("optionlist");
    expect(languages.options).toEqual(["EN", "FR", "DE"]);
    expect(languages.value).toEqual([]);
    expect(languages.page).toBe(1);

    const reference = byName(fields, "reference");
    expect(reference.value).toBe("REF-001");
    expect(reference.readOnly).toBe(true);
    expect(reference.page).toBe(1);
  });

  it("returns nothing for a document with no form", async () => {
    expect(await readForm(await plainFixture())).toEqual([]);
  });

  it("leaves the caller's bytes alone", async () => {
    const bytes = await formFixture();
    const before = bytes.slice();
    await readForm(bytes);
    expect(bytes).toEqual(before);
  });
});

describe("hasForm", () => {
  it("is true for a form and false for a plain document", async () => {
    expect(await hasForm(await formFixture())).toBe(true);
    expect(await hasForm(await plainFixture(3))).toBe(false);
  });

  it("is false for the real sample PDFs, which are not forms", async () => {
    const lease = new Uint8Array(
      readFileSync(new URL("../../../../../backend/samples/sample-apartment-lease.pdf", import.meta.url)),
    );
    expect(await hasForm(lease)).toBe(false);
    expect(await readForm(lease)).toEqual([]);
  });
});

describe("fillForm", () => {
  it("round trips a value into every fillable type", async () => {
    const filled = await fillForm(await formFixture(), {
      "applicant.name": "Ada Lovelace",
      agree: true,
      colour: "Blue",
      plan: "Yearly",
      languages: ["EN", "DE"],
    });

    const fields = await readForm(filled);
    expect(byName(fields, "applicant.name").value).toBe("Ada Lovelace");
    expect(byName(fields, "agree").value).toBe(true);
    expect(byName(fields, "colour").value).toEqual(["Blue"]);
    expect(byName(fields, "plan").value).toBe("Yearly");
    expect(byName(fields, "languages").value).toEqual(["EN", "DE"]);
    // The fields nobody touched keep what they had.
    expect(byName(fields, "reference").value).toBe("REF-001");
  });

  it("clears a picker when given an empty value", async () => {
    const filled = await fillForm(await formFixture(), { colour: "", plan: "Monthly" });
    const cleared = await fillForm(filled, { plan: "" });
    const fields = await readForm(cleared);
    expect(byName(fields, "colour").value).toEqual([]);
    expect(byName(fields, "plan").value).toBe("");
  });

  it("refuses a field name the document does not have", async () => {
    const bytes = await formFixture();
    await expect(fillForm(bytes, { "applicant.name": "Ada", Signature1: "x" })).rejects.toThrow(
      PdfOpError,
    );
    await expect(fillForm(bytes, { Signature1: "x" })).rejects.toThrow(/Signature1/);
  });

  it("changes nothing when a name is wrong, rather than filling the rest", async () => {
    const bytes = await formFixture();
    await expect(fillForm(bytes, { "applicant.name": "Ada", nope: "x" })).rejects.toThrow();
    // The original is untouched, so a half filled form can never be saved.
    expect(byName(await readForm(bytes), "applicant.name").value).toBe("");
  });

  it("refuses a dropdown option the field does not offer", async () => {
    const bytes = await formFixture();
    await expect(fillForm(bytes, { colour: "Purple" })).rejects.toThrow(PdfOpError);
    await expect(fillForm(bytes, { colour: "Purple" })).rejects.toThrow(/Purple/);
    await expect(fillForm(bytes, { languages: ["EN", "ZZ"] })).rejects.toThrow(/ZZ/);
    await expect(fillForm(bytes, { plan: "Weekly" })).rejects.toThrow(/Weekly/);

    // The choices the field does offer go in the hint, so the user can fix it.
    const failure = await caught(() => fillForm(bytes, { colour: "Purple" }));
    expect(failure.hint).toContain("Red");
    expect(failure.hint).toContain("Blue");
  });

  it("refuses a value of the wrong shape for the field type", async () => {
    const bytes = await formFixture();
    await expect(fillForm(bytes, { agree: "yes" })).rejects.toThrow(/checkbox/);
    await expect(fillForm(bytes, { "applicant.name": true })).rejects.toThrow(/text/);
  });

  it("explains itself when the document has no form", async () => {
    await expect(fillForm(await plainFixture(), { name: "Ada" })).rejects.toThrow(
      /no form fields/,
    );
  });

  it("is a no-op when given nothing to fill", async () => {
    const bytes = await formFixture();
    const out = await fillForm(bytes, {});
    expect(out).toEqual(bytes);
    expect(out).not.toBe(bytes);
  });

  it("refuses two values for a field the file says takes one", async () => {
    // pdf-lib turns the multi choice flag on instead of refusing, which hands
    // back a form that is not the one the author wrote, and readers show only
    // one of the two values anyway.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const one = form.createOptionList("pick.one");
    one.setOptions(["A", "B", "C"]);
    one.addToPage(page, { x: 50, y: 700, width: 120, height: 60 });
    const bytes = await savePdf(doc);

    const failure = await caught(() => fillForm(bytes, { "pick.one": ["A", "B"] }));
    expect(failure.message).toMatch(/takes one choice/);

    // One value still goes in, and the flag is left as the author set it.
    const filled = await fillForm(bytes, { "pick.one": ["B"] });
    expect(byName(await readForm(filled), "pick.one").value).toEqual(["B"]);
    const back = await loadPdf(filled);
    expect(back.getForm().getOptionList("pick.one").isMultiselect()).toBe(false);
  });

  it("lets an editable dropdown take a value that is not on its list", async () => {
    // The "Other, please specify" combo box. The author turned editing on, so
    // a value off the list is the point of the field, not a typo.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const how = form.createDropdown("contact.how");
    how.setOptions(["Email", "Phone", "Other"]);
    how.enableEditing();
    how.addToPage(page, { x: 50, y: 700, width: 160, height: 20 });
    const fixed = form.createDropdown("contact.when");
    fixed.setOptions(["Morning", "Evening"]);
    fixed.addToPage(page, { x: 50, y: 660, width: 160, height: 20 });
    const bytes = await savePdf(doc);

    expect(byName(await readForm(bytes), "contact.how").editable).toBe(true);
    expect(byName(await readForm(bytes), "contact.when").editable).toBe(false);

    const filled = await fillForm(bytes, { "contact.how": "Carrier pigeon" });
    expect(byName(await readForm(filled), "contact.how").value).toEqual(["Carrier pigeon"]);

    // The one next to it was not made editable, so it still refuses.
    await expect(fillForm(bytes, { "contact.when": "Midnight" })).rejects.toThrow(/Midnight/);
  });

  it("explains a value that is longer than the field allows", async () => {
    // MaxLen is on most government forms. pdf-lib throws its own error for
    // this, which the app would report as a bug in the app.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const zip = form.createTextField("zip");
    zip.setMaxLength(5);
    zip.addToPage(page, { x: 50, y: 700, width: 80, height: 20 });
    const bytes = await savePdf(doc);

    const failure = await caught(() => fillForm(bytes, { zip: "20742-1234" }));
    expect(failure).toBeInstanceOf(PdfOpError);
    expect(failure.message).toMatch(/at most 5 characters/);
    // Right at the limit is fine.
    expect(byName(await readForm(await fillForm(bytes, { zip: "20742" })), "zip").value).toBe(
      "20742",
    );
  });

  it("fills every field that carries the name, not just the last one", async () => {
    // Generated forms repeat a name across pages. Filling only the last copy
    // leaves a blank box in a form the user was told is filled in.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    const first = form.createTextField("initials");
    first.addToPage(page, { x: 50, y: 700, width: 80, height: 20 });
    const second = form.createTextField("initialsAgain");
    second.addToPage(page, { x: 50, y: 100, width: 80, height: 20 });
    // Same name, two separate fields, which is what a generator leaves behind.
    second.acroField.setPartialName("initials");
    const bytes = await savePdf(doc);

    expect((await readForm(bytes)).map((f) => f.name)).toEqual(["initials", "initials"]);
    const filled = await fillForm(bytes, { initials: "AK" });
    const values = (await readForm(filled))
      .filter((f) => f.name === "initials")
      .map((f) => f.value);
    expect(values).toEqual(["AK", "AK"]);
  });

  it("gives a readable error for text the built in font cannot draw", async () => {
    const bytes = await formFixture();
    await expect(fillForm(bytes, { "applicant.name": "田中太郎" })).rejects.toThrow(PdfOpError);
    await expect(fillForm(bytes, { "applicant.name": "田中太郎" })).rejects.toThrow(
      /cannot draw/,
    );
  });
});

describe("flattenForm", () => {
  it("turns the fields into page content and leaves no form behind", async () => {
    const filled = await fillForm(await formFixture(), {
      "applicant.name": "Ada Lovelace",
      agree: true,
    });
    const flat = await flattenForm(filled);

    expect(await hasForm(flat)).toBe(false);
    expect(await readForm(flat)).toEqual([]);

    const doc = await loadPdf(flat);
    expect(doc.getPageCount()).toBe(2);

    // The widgets are gone from the page and their drawings took their place.
    const page = doc.getPage(0);
    expect(page.node.Annots()?.size() ?? 0).toBe(0);
    const xObjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const drawn = (xObjects?.keys() ?? []).filter((k) => k.asString().includes("FlatWidget"));
    expect(drawn.length).toBeGreaterThan(0);
  });

  it("leaves no dead annotation on any page, and keeps the live ones", async () => {
    const doc = await blankPdf();
    const one = doc.addPage([612, 792]);
    const two = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createTextField("a").addToPage(one, { x: 10, y: 10, width: 80, height: 20 });
    const plan = form.createRadioGroup("plan");
    plan.addOptionToPage("M", two, { x: 10, y: 700, width: 14, height: 14 });
    plan.addOptionToPage("Y", two, { x: 10, y: 670, width: 14, height: 14 });
    // A link is a real annotation and has to survive the sweep.
    const link = doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 400, 200, 420],
        A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com") },
      }),
    );
    two.node.addAnnot(link);
    const flat = await flattenForm(await savePdf(doc));

    const back = await loadPdf(flat);
    expect(back.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    const left = back.getPage(1).node.Annots();
    expect(left?.size() ?? 0).toBe(1);
    const kind = back.context
      .lookup(left?.get(0), PDFDict)
      .get(PDFName.of("Subtype"));
    expect(String(kind)).toBe("/Link");
  });

  it("does not print a hidden field onto the page", async () => {
    // A field the reader never showed must not become ink. pdf-lib's flatten
    // draws every widget it can find, hidden flag and all.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createTextField("shown").addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    const secret = form.createTextField("ssn");
    secret.addToPage(page, { x: 50, y: 600, width: 200, height: 20 });
    for (const widget of secret.acroField.getWidgets()) {
      widget.dict.set(PDFName.of("F"), PDFNumber.of(2));
    }
    const bytes = await savePdf(doc);

    const filled = await fillForm(bytes, { shown: "on the form", ssn: "123-45-6789" });
    expect(await drawnSomewhere(filled, "123-45-6789")).toBe(true);

    const flat = await flattenForm(filled);
    expect(await hasForm(flat)).toBe(false);
    // The visible one was drawn, the hidden one is gone from the file entirely.
    expect(await drawnSomewhere(flat, "on the form")).toBe(true);
    expect(await drawnSomewhere(flat, "123-45-6789")).toBe(false);

    const back = await loadPdf(flat);
    const first = back.getPage(0);
    expect(first.node.Annots()?.size() ?? 0).toBe(0);
    const xObjects = first.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    const drawn = (xObjects?.keys() ?? []).filter((k) => k.asString().includes("FlatWidget"));
    expect(drawn.length).toBe(1);
  });

  it("does not print a hidden field that is its own widget either", async () => {
    // Acrobat writes the field and its box as one dictionary rather than two,
    // which is the shape most real forms have and a different code path.
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const merged = doc.context.obj({
      Type: "Annot",
      Subtype: "Widget",
      FT: "Tx",
      T: PDFString.of("hiddenNote"),
      V: PDFString.of("employee ref 88213"),
      Rect: [50, 600, 250, 620],
      F: PDFNumber.of(2),
      DA: PDFString.of("/Helv 12 Tf 0 g"),
    });
    const ref = doc.context.register(merged);
    page.node.addAnnot(ref);
    doc.catalog.set(
      PDFName.of("AcroForm"),
      doc.context.obj({ Fields: [ref], DA: PDFString.of("/Helv 12 Tf 0 g") }),
    );
    const bytes = await savePdf(doc);

    expect((await readForm(bytes)).map((f) => f.name)).toEqual(["hiddenNote"]);
    const flat = await flattenForm(bytes);

    expect(await hasForm(flat)).toBe(false);
    expect(await drawnSomewhere(flat, "employee ref 88213")).toBe(false);
    const back = await loadPdf(flat);
    expect(back.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it("passes a document with no form straight through", async () => {
    const bytes = await plainFixture(3);
    const out = await flattenForm(bytes);
    expect(out).toEqual(bytes);

    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(3);
    const first = doc.getPage(0);
    expect(first.getMediaBox().width).toBe(400);
    expect(first.getMediaBox().height).toBe(500);
  });
});

describe("the ugly page", () => {
  /**
   * One page, turned a quarter turn, with a MediaBox that does not start at
   * (0, 0). This is the shape that breaks naive coordinate code, and it is
   * also the shape where a widget's page has to be found through /Annots.
   */
  async function crookedFixture(): Promise<Uint8Array> {
    const doc = await blankPdf();
    const page = doc.addPage();
    page.setMediaBox(20, 30, 400, 500);
    page.setRotation(degrees(90));
    const form = doc.getForm();
    const field = form.createTextField("note");
    field.addToPage(page, { x: 60, y: 90, width: 200, height: 24 });
    return savePdf(doc);
  }

  it("finds the field, fills it, and keeps the box and the turn", async () => {
    const bytes = await crookedFixture();

    const fields = await readForm(bytes);
    expect(fields.length).toBe(1);
    expect(byName(fields, "note").page).toBe(0);

    const filled = await fillForm(bytes, { note: "top of the page" });
    expect(byName(await readForm(filled), "note").value).toBe("top of the page");

    const flat = await flattenForm(filled);
    expect(await hasForm(flat)).toBe(false);

    const doc = await loadPdf(flat);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    const box = page.getMediaBox();
    expect([box.x, box.y, box.width, box.height]).toEqual([20, 30, 400, 500]);
    expect(page.getRotation().angle).toBe(90);
  });
});
