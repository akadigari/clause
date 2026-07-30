import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { splitAt, splitByRanges, splitEvery, type SplitPart } from "./split";
import { blankPdf, loadPdf, pageBoxOf, pdfLib, PdfOpError, savePdf } from "./common";

/**
 * The fixtures stamp "PAGE n" on every page so a test can prove which source
 * page ended up in which output file, not just how many pages came along.
 */
async function stampedPdf(pages: number): Promise<Uint8Array> {
  const { StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle("Lease agreement");
  doc.setAuthor("Ada Lovelace");
  doc.setSubject("Tenancy");
  doc.setKeywords(["lease"]);
  doc.setCreator("Clause tests");
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`PAGE ${i + 1}`, { x: 30, y: 150, size: 18, font });
  }
  return savePdf(doc);
}

/**
 * A document whose first page links to a later one. This is the ordinary case
 * that makes a split leak: following the link while copying pulls the page it
 * names into the part, where nothing shows it and anything can read it.
 */
async function linkedPdf(pages: number, from: number, to: number): Promise<Uint8Array> {
  const { PDFArray, PDFDict, PDFName, PDFNumber, StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const made = [];
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`PAGE ${i + 1}`, { x: 30, y: 150, size: 18, font });
    made.push(page);
  }

  const dest = PDFArray.withContext(doc.context);
  dest.push(made[to]!.ref);
  dest.push(PDFName.of("Fit"));

  const rect = PDFArray.withContext(doc.context);
  for (const n of [30, 140, 200, 180]) rect.push(PDFNumber.of(n));

  const annot = PDFDict.withContext(doc.context);
  annot.set(PDFName.of("Type"), PDFName.of("Annot"));
  annot.set(PDFName.of("Subtype"), PDFName.of("Link"));
  annot.set(PDFName.of("Rect"), rect);
  annot.set(PDFName.of("Dest"), dest);

  const annots = PDFArray.withContext(doc.context);
  annots.push(doc.context.register(annot));
  made[from]!.node.set(PDFName.of("Annots"), annots);

  return savePdf(doc);
}

/** Three pages, a filled text field on page 2 and a ticked box on page 3. */
async function formPdf(): Promise<Uint8Array> {
  const { PDFName, PDFString, StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const pages = [doc.addPage([300, 300]), doc.addPage([300, 300]), doc.addPage([300, 300])];
  const form = doc.getForm();

  const name = form.createTextField("tenant.name");
  name.setText("Ada Lovelace");
  name.addToPage(pages[1]!, { x: 20, y: 200, width: 200, height: 24 });

  const agreed = form.createCheckBox("agreed");
  agreed.check();
  agreed.addToPage(pages[2]!, { x: 20, y: 200, width: 20, height: 20 });

  // pdf-lib does not write a default appearance or default resources, and a
  // real form always has them, so the fixture puts them on by hand. Without
  // this the test that they survive would be asserting nothing.
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const acro = doc.catalog.getOrCreateAcroForm();
  acro.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
  acro.dict.set(
    PDFName.of("DR"),
    doc.context.obj({ Font: doc.context.obj({ Helv: helvetica.ref }) }),
  );

  return savePdf(doc);
}

/** How many page objects are in the file, whether or not they are on show. */
async function pageObjects(bytes: Uint8Array): Promise<number> {
  const { PDFPageLeaf } = await pdfLib();
  const doc = await loadPdf(bytes);
  let found = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFPageLeaf) found++;
  }
  return found;
}

/**
 * Is this text anywhere in the file at all, reachable or not? Page text is
 * written as hex inside the content stream, so both spellings are checked.
 */
async function insideTheFile(bytes: Uint8Array, text: string): Promise<boolean> {
  const { decodePDFRawStream, PDFRawStream } = await pdfLib();
  const doc = await loadPdf(bytes);
  const hex = [...text].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    let body: string;
    try {
      body = new TextDecoder().decode(decodePDFRawStream(object).decode());
    } catch {
      continue;
    }
    if (body.includes(text)) return true;
    if (body.toLowerCase().includes(hex.toLowerCase())) return true;
  }
  return false;
}

/** Where the link on the first page ends up pointing, once the part is written. */
async function linkTarget(bytes: Uint8Array): Promise<{ target: string; pages: string[] }> {
  const { PDFArray, PDFDict, PDFName, PDFRef } = await pdfLib();
  const doc = await loadPdf(bytes);
  const annots = doc.getPage(0).node.Annots();
  if (!annots) throw new Error("The link annotation did not survive the copy.");
  const annot = doc.context.lookup(annots.get(0));
  if (!(annot instanceof PDFDict)) throw new Error("That annotation is not a dictionary.");
  const dest = annot.get(PDFName.of("Dest"));
  const array = dest instanceof PDFRef ? doc.context.lookup(dest) : dest;
  if (!(array instanceof PDFArray)) throw new Error("That link has no destination array.");
  return {
    target: String(array.get(0)),
    pages: doc.getPages().map((page) => String(page.ref)),
  };
}

// pdf.js is only used to read text back. The legacy build is the one that runs
// under plain node, and the font directory keeps it from warning on every open.
const require = createRequire(import.meta.url);
const pdfjsRoot = require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "");

type TextItem = { str?: string };

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import(`${pdfjsRoot}legacy/build/pdf.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${pdfjsRoot}legacy/build/pdf.worker.mjs`;
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: `${pdfjsRoot}standard_fonts/`,
    useSystemFonts: false,
  });
  const doc = await task.promise;

  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    out.push(
      (content.items as TextItem[])
        .map((item) => item.str ?? "")
        .join("")
        .trim(),
    );
  }
  await task.destroy();
  return out;
}

async function firstPageText(bytes: Uint8Array): Promise<string> {
  return (await pageTexts(bytes))[0] ?? "";
}

async function countOf(bytes: Uint8Array): Promise<number> {
  return (await loadPdf(bytes)).getPageCount();
}

/** Reach into a result list and fail loudly instead of returning undefined. */
function part(parts: SplitPart[], index: number): SplitPart {
  const found = parts[index];
  if (!found) throw new Error(`Wanted part ${index + 1}, got ${parts.length} parts.`);
  return found;
}

describe("splitAt", () => {
  it("cuts a 10 page document after pages 3 and 6", async () => {
    const src = await stampedPdf(10);
    const parts = await splitAt(src, [2, 5], "lease");

    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.pages)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8, 9],
    ]);
    expect(await Promise.all(parts.map((p) => countOf(p.bytes)))).toEqual([3, 3, 4]);
  });

  it("puts the right pages in the right file", async () => {
    const src = await stampedPdf(10);
    const parts = await splitAt(src, [2, 5], "lease");

    const firstPageOfEachPart = await Promise.all(
      parts.map((p) => firstPageText(p.bytes)),
    );
    // Part one starts at page 1, part two at page 4, part three at page 7.
    expect(firstPageOfEachPart).toEqual(["PAGE 1", "PAGE 4", "PAGE 7"]);

    expect(await pageTexts(part(parts, 1).bytes)).toEqual([
      "PAGE 4",
      "PAGE 5",
      "PAGE 6",
    ]);
    expect(await pageTexts(part(parts, 2).bytes)).toEqual([
      "PAGE 7",
      "PAGE 8",
      "PAGE 9",
      "PAGE 10",
    ]);
  });

  it("drops a cut after the last page instead of making an empty part", async () => {
    const src = await stampedPdf(4);
    const parts = await splitAt(src, [1, 3], "doc");

    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.pages)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("tolerates duplicate, out of order, and out of range cut points", async () => {
    const src = await stampedPdf(6);
    const messy = await splitAt(src, [3, 0, 3, 99, -1, 0], "doc");
    const tidy = await splitAt(src, [0, 3], "doc");

    expect(messy.map((p) => p.pages)).toEqual(tidy.map((p) => p.pages));
    expect(messy.map((p) => p.pages)).toEqual([[0], [1, 2, 3], [4, 5]]);
  });

  it("returns the whole document as one part when there are no cuts", async () => {
    const src = await stampedPdf(3);
    const parts = await splitAt(src, [], "doc");

    expect(parts).toHaveLength(1);
    expect(part(parts, 0).name).toBe("doc-1.pdf");
    expect(await countOf(part(parts, 0).bytes)).toBe(3);
    expect(await pageTexts(part(parts, 0).bytes)).toEqual(["PAGE 1", "PAGE 2", "PAGE 3"]);
  });

  it("handles a one page document", async () => {
    const src = await stampedPdf(1);
    const parts = await splitAt(src, [0], "solo");

    expect(parts).toHaveLength(1);
    expect(part(parts, 0).pages).toEqual([0]);
    expect(await firstPageText(part(parts, 0).bytes)).toBe("PAGE 1");
  });

  it("reports progress once per part and never mutates the input", async () => {
    const src = await stampedPdf(6);
    const before = src.slice();
    const seen: Array<[number, number]> = [];

    const parts = await splitAt(src, [1, 3], "doc", (done, total) => {
      seen.push([done, total]);
    });

    expect(parts).toHaveLength(3);
    expect(seen).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(src).toEqual(before);
  });
});

describe("part names", () => {
  it("zero pads to the number of parts so they sort in order", async () => {
    const src = await stampedPdf(10);
    const parts = await splitEvery(src, 1, "notes");

    expect(parts).toHaveLength(10);
    expect(parts.map((p) => p.name)).toEqual([
      "notes-01.pdf",
      "notes-02.pdf",
      "notes-03.pdf",
      "notes-04.pdf",
      "notes-05.pdf",
      "notes-06.pdf",
      "notes-07.pdf",
      "notes-08.pdf",
      "notes-09.pdf",
      "notes-10.pdf",
    ]);
    expect([...parts.map((p) => p.name)].sort()).toEqual(parts.map((p) => p.name));
  });

  it("does not pad when there are fewer than ten parts", async () => {
    const src = await stampedPdf(3);
    const parts = await splitEvery(src, 1, "notes");
    expect(parts.map((p) => p.name)).toEqual([
      "notes-1.pdf",
      "notes-2.pdf",
      "notes-3.pdf",
    ]);
  });

  it("strips characters a file system will not take", async () => {
    const src = await stampedPdf(2);
    const parts = await splitEvery(src, 1, 'my/lease: "final"?');
    // Every unusable character becomes a dash, and the runs of dashes that
    // leaves behind are collapsed rather than shipped.
    expect(parts.map((p) => p.name)).toEqual(["my-lease-final-1.pdf", "my-lease-final-2.pdf"]);
  });

  it("does not put .pdf in the middle of the name", async () => {
    const src = await stampedPdf(2);
    expect((await splitEvery(src, 1, "lease.pdf")).map((p) => p.name)).toEqual([
      "lease-1.pdf",
      "lease-2.pdf",
    ]);
  });

  it("falls back to a real name when there is nothing usable left", async () => {
    const src = await stampedPdf(1);
    expect(part(await splitEvery(src, 1, "///"), 0).name).toBe("document-1.pdf");
    expect(part(await splitEvery(src, 1, ""), 0).name).toBe("document-1.pdf");
  });
});

describe("splitEvery", () => {
  it("makes one file per page", async () => {
    const src = await stampedPdf(4);
    const parts = await splitEvery(src, 1, "page");

    expect(parts).toHaveLength(4);
    expect(await Promise.all(parts.map((p) => countOf(p.bytes)))).toEqual([1, 1, 1, 1]);
    expect(await Promise.all(parts.map((p) => firstPageText(p.bytes)))).toEqual([
      "PAGE 1",
      "PAGE 2",
      "PAGE 3",
      "PAGE 4",
    ]);
  });

  it("leaves the last part short when the count does not divide evenly", async () => {
    const src = await stampedPdf(10);
    const parts = await splitEvery(src, 4, "chunk");

    expect(parts.map((p) => p.pages)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ]);
    expect(await firstPageText(part(parts, 2).bytes)).toBe("PAGE 9");
  });

  it("gives back one part when the size is bigger than the document", async () => {
    const src = await stampedPdf(3);
    const parts = await splitEvery(src, 50, "whole");
    expect(parts).toHaveLength(1);
    expect(part(parts, 0).pages).toEqual([0, 1, 2]);
  });

  it("refuses a size that is not a whole number of pages", async () => {
    const src = await stampedPdf(3);
    await expect(splitEvery(src, 0, "doc")).rejects.toBeInstanceOf(PdfOpError);
    await expect(splitEvery(src, -2, "doc")).rejects.toBeInstanceOf(PdfOpError);
    await expect(splitEvery(src, 1.5, "doc")).rejects.toThrow(
      "A part cannot be 1.5 pages long.",
    );
  });
});

describe("splitByRanges", () => {
  it("takes explicit groups and lets them overlap", async () => {
    const src = await stampedPdf(6);
    const parts = await splitByRanges(
      src,
      [
        [0, 1],
        [1, 2, 5],
      ],
      "pick",
    );

    expect(parts.map((p) => p.pages)).toEqual([
      [0, 1],
      [1, 2, 5],
    ]);
    expect(await pageTexts(part(parts, 0).bytes)).toEqual(["PAGE 1", "PAGE 2"]);
    expect(await pageTexts(part(parts, 1).bytes)).toEqual(["PAGE 2", "PAGE 3", "PAGE 6"]);
  });

  it("sorts and dedupes inside a group", async () => {
    const src = await stampedPdf(5);
    const parts = await splitByRanges(src, [[4, 0, 4, 2]], "pick");
    expect(part(parts, 0).pages).toEqual([0, 2, 4]);
    expect(await pageTexts(part(parts, 0).bytes)).toEqual(["PAGE 1", "PAGE 3", "PAGE 5"]);
  });

  it("refuses an empty group and a group with nothing in range", async () => {
    const src = await stampedPdf(3);
    await expect(splitByRanges(src, [[0], []], "doc")).rejects.toThrow(/Part 2/);
    await expect(splitByRanges(src, [[9, 10]], "doc")).rejects.toBeInstanceOf(PdfOpError);
    await expect(splitByRanges(src, [], "doc")).rejects.toBeInstanceOf(PdfOpError);
  });

  it("refuses a group that is only partly in range instead of shrinking it", async () => {
    const src = await stampedPdf(3);
    // Quietly handing back a one page part here would hide a caller that
    // counted wrong, and the part would look finished.
    await expect(splitByRanges(src, [[0], [1, 99]], "doc")).rejects.toThrow(/Part 2/);
    await expect(splitByRanges(src, [[0, 1.5]], "doc")).rejects.toThrow(/Part 1/);
    await expect(splitByRanges(src, [[0, -1]], "doc")).rejects.toThrow(/Part 1/);
  });
});

describe("pages that were cut away", () => {
  it("leaves them out of the file, not just out of the page tree", async () => {
    const src = await linkedPdf(6, 0, 5);
    const parts = await splitAt(src, [0], "lease");
    const first = part(parts, 0);

    expect(await countOf(first.bytes)).toBe(1);
    expect(await pageTexts(first.bytes)).toEqual(["PAGE 1"]);
    // The part reads as one page either way. These two are the difference
    // between page 6 being gone and page 6 being hidden.
    expect(await pageObjects(first.bytes)).toBe(1);
    expect(await insideTheFile(first.bytes, "PAGE 6")).toBe(false);
  });

  it("makes a link to a page in another part do nothing", async () => {
    const parts = await splitAt(await linkedPdf(6, 0, 5), [0], "lease");
    const { target } = await linkTarget(part(parts, 0).bytes);
    expect(target).toBe("null");
  });

  it("keeps a link working when its page is in the same part", async () => {
    const parts = await splitAt(await linkedPdf(6, 0, 5), [], "whole");
    const { target, pages } = await linkTarget(part(parts, 0).bytes);
    // Page 6 of the source is page 6 of this part, and the link still names it.
    expect(pages.indexOf(target)).toBe(5);
  });

  it("does not leave a spare copy of a page that carries a form field", async () => {
    const parts = await splitEvery(await formPdf(), 1, "form");
    expect(await Promise.all(parts.map((p) => pageObjects(p.bytes)))).toEqual([1, 1, 1]);
  });
});

describe("forms", () => {
  it("keeps a field fillable in the part that holds it", async () => {
    const src = await formPdf();
    const parts = await splitEvery(src, 1, "form");
    expect(parts).toHaveLength(3);

    const cover = await loadPdf(part(parts, 0).bytes);
    expect(cover.getForm().getFields()).toHaveLength(0);

    // Without the rescue these are empty, the boxes still draw, and nothing
    // says the file is broken until somebody tries to type in it.
    const second = await loadPdf(part(parts, 1).bytes);
    expect(second.getForm().getFields().map((f) => f.getName())).toEqual(["tenant.name"]);
    expect(second.getForm().getTextField("tenant.name").getText()).toBe("Ada Lovelace");

    const third = await loadPdf(part(parts, 2).bytes);
    expect(third.getForm().getFields().map((f) => f.getName())).toEqual(["agreed"]);
    expect(third.getForm().getCheckBox("agreed").isChecked()).toBe(true);
  });

  it("carries the form's own defaults across with the fields", async () => {
    const { PDFName } = await pdfLib();
    const src = await formPdf();
    const before = (await loadPdf(src)).catalog.getAcroForm();
    const parts = await splitEvery(src, 1, "form");
    const after = (await loadPdf(part(parts, 1).bytes)).catalog.getAcroForm();

    expect(after).toBeDefined();
    // /DA and /DR live on the form, not the page, so they need carrying by
    // hand. Whatever the source had, the part has.
    for (const key of ["DA", "DR"] as const) {
      expect(!!after?.dict.get(PDFName.of(key))).toBe(!!before?.dict.get(PDFName.of(key)));
    }
  });

  it("leaves a document with no form alone", async () => {
    const parts = await splitAt(await stampedPdf(2), [0], "plain");
    const { PDFName } = await pdfLib();
    const first = await loadPdf(part(parts, 0).bytes);
    expect(first.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
  });
});

describe("what each part carries", () => {
  it("keeps the source details and says which part it is", async () => {
    const src = await stampedPdf(4);
    const parts = await splitAt(src, [1], "lease");

    const second = await loadPdf(part(parts, 1).bytes);
    expect(second.getTitle()).toBe("Lease agreement (part 2 of 2)");
    expect(second.getAuthor()).toBe("Ada Lovelace");
    expect(second.getSubject()).toBe("Tenancy");
    expect(second.getKeywords()).toBe("lease");
    // Creator is the program the document was written in, which the part still
    // came from. Producer is the program that wrote this file, which is us.
    expect(second.getCreator()).toBe("Clause tests");
    expect(second.getProducer()).toMatch(/^Clause/);
  });

  it("falls back to the base name when the source has no title", async () => {
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    doc.addPage([200, 200]);
    const parts = await splitAt(await savePdf(doc), [0], "untitled");
    const first = await loadPdf(part(parts, 0).bytes);
    expect(first.getTitle()).toBe("untitled (part 1 of 2)");
  });

  it("keeps page size, rotation, and a media box that does not start at zero", async () => {
    const { degrees } = await pdfLib();
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    const odd = doc.addPage([400, 500]);
    odd.setMediaBox(15, 25, 400, 500);
    odd.setRotation(degrees(90));

    const parts = await splitAt(await savePdf(doc), [0], "odd");
    expect(parts).toHaveLength(2);

    const second = await loadPdf(part(parts, 1).bytes);
    const page = second.getPage(0);
    expect(pageBoxOf(page)).toEqual({
      originX: 15,
      originY: 25,
      width: 400,
      height: 500,
      rotation: 90,
    });
  });
});

describe("bad input", () => {
  it("says so when the bytes are not a PDF", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(splitAt(junk, [0], "doc")).rejects.toBeInstanceOf(PdfOpError);
    await expect(splitEvery(junk, 1, "doc")).rejects.toThrow(/not a PDF/);
  });

  it("says so when the document has no pages", async () => {
    const empty = await savePdf(await blankPdf());
    await expect(splitAt(empty, [], "doc")).rejects.toThrow(/no pages/);
  });
});

describe("a real file", () => {
  it("splits the sample lease and keeps the text on the right side of the cut", async () => {
    const path = new URL(
      "../../../../../backend/samples/sample-apartment-lease.pdf",
      import.meta.url,
    );
    const src = new Uint8Array(readFileSync(path));
    const total = await countOf(src);
    expect(total).toBeGreaterThan(1);

    const wholeText = await pageTexts(src);
    const parts = await splitAt(src, [0], "lease");

    expect(parts).toHaveLength(2);
    expect(await countOf(part(parts, 0).bytes)).toBe(1);
    expect(await countOf(part(parts, 1).bytes)).toBe(total - 1);
    expect(await firstPageText(part(parts, 0).bytes)).toBe(wholeText[0]);
    expect(await firstPageText(part(parts, 1).bytes)).toBe(wholeText[1]);
  });
});
