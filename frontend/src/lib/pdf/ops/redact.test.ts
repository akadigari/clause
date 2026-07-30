/**
 * What these tests cover, and what they cannot.
 *
 * Covered here, in node, for real: all the geometry, the page plan, the cost
 * warning, the phrase matching, what gets pulled out of an annotation, and the
 * two rules that decide whether the user is told they are safe. Plus one thing
 * about the output that needs no canvas at all: a form field on a page nobody
 * marked carries its value into the file, which is why the receipt has to read
 * annotations and not just page text.
 *
 * NOT covered here: the raster step itself. Painting black onto the canvas
 * needs a real canvas, and node does not have one. There is no fake canvas in
 * this file on purpose. A stub that records fillRect calls would pass whether
 * or not a single pixel was ever destroyed, which is precisely the false
 * comfort this module exists to stop. That step gets checked in a browser, by
 * opening the output and trying to select the words.
 *
 * Because of that, nothing here ever produces a redacted PDF. Every test that
 * calls `redact` is a test of a path that refuses before drawing. So do not
 * read a green run as "redaction works". It means the decisions around
 * redaction are right, and the drawing is still owed a browser.
 *
 * The three that go through `redact` itself are: the two refusals, and the one
 * that proves a failure inside pdf.js comes back as a PdfOpError rather than a
 * raw library error. That last one only works because node has no DOMMatrix,
 * which makes opening for viewing fail the same way a locked file does.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { viewSize } from "../geometry";
import { blankPdf, loadPdf, pageBoxOf, pdfLib, savePdf, PdfOpError, LIMITS } from "./common";
import {
  DEFAULT_REDACT_DPI,
  affectedPages,
  annotationText,
  clipBoxToPage,
  clipBoxesToPage,
  containsPhrase,
  groupBoxesByPage,
  isVerdictClean,
  normalizeForSearch,
  normalizeRedactBox,
  pageStillHasText,
  phrasesMissingFromSource,
  planRedaction,
  redact,
  redactionCost,
  toCanvasRects,
  type RedactBox,
} from "./redact";

// Characters that are the whole point of the matching tests, built from their
// code points so this file stays plain ASCII and every one of them is nameable.
const RIGHT_QUOTE = String.fromCharCode(0x2019);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const LIGATURE_FI = String.fromCharCode(0xfb01);
const NBSP = String.fromCharCode(0x00a0);

const SAMPLE_LEASE = "/Users/kadigari/Documents/ARKPrograms/clause/backend/samples/sample-apartment-lease.pdf";

function box(page: number, x = 10, y = 10, width = 100, height = 20): RedactBox {
  return { page, x, y, width, height };
}

/** A plain multi page document with a line of real text on each page. */
async function fixture(pages: number): Promise<Uint8Array> {
  const doc = await blankPdf();
  const { StandardFonts } = await pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Page ${i + 1}: the tenant is Jane Roe`, {
      x: 72,
      y: 700,
      size: 12,
      font,
    });
  }
  return savePdf(doc);
}

describe("normalizeRedactBox", () => {
  it("folds a drag made up and to the left into a positive rectangle", () => {
    expect(normalizeRedactBox({ page: 0, x: 100, y: 200, width: -40, height: -60 })).toEqual({
      page: 0,
      x: 60,
      y: 140,
      width: 40,
      height: 60,
    });
  });

  it("leaves a normal box alone", () => {
    const b = box(2, 5, 6, 7, 8);
    expect(normalizeRedactBox(b)).toEqual(b);
  });
});

describe("groupBoxesByPage", () => {
  it("sorts boxes into their pages and keeps all of them", () => {
    const grouped = groupBoxesByPage([box(2), box(0), box(2, 50)], 5);
    expect([...grouped.keys()].sort((a, b) => a - b)).toEqual([0, 2]);
    expect(grouped.get(2)).toHaveLength(2);
    expect(grouped.get(0)).toHaveLength(1);
  });

  it("drops a box with no size but keeps the real one on the same page", () => {
    const grouped = groupBoxesByPage([box(1, 10, 10, 0, 0), box(1)], 3);
    expect(grouped.get(1)).toHaveLength(1);
  });

  it("refuses an empty selection", () => {
    expect(() => groupBoxesByPage([], 3)).toThrow(PdfOpError);
    expect(() => groupBoxesByPage([], 3)).toThrow(/Nothing is marked/);
  });

  it("refuses a selection where every box has no size", () => {
    expect(() => groupBoxesByPage([box(0, 5, 5, 0, 30), box(1, 5, 5, 30, 0)], 2)).toThrow(
      /no size/,
    );
  });

  it("refuses a box on a page the document does not have, rather than dropping it", () => {
    expect(() => groupBoxesByPage([box(0), box(7)], 3)).toThrow(PdfOpError);
    expect(() => groupBoxesByPage([box(7)], 3)).toThrow(/page 8, and this document has 3/);
  });

  it("refuses a box with a bad number in it", () => {
    expect(() => groupBoxesByPage([box(0, Number.NaN)], 2)).toThrow(/bad position or size/);
  });
});

describe("affectedPages", () => {
  it("gives the pages that become pictures, in order and once each", () => {
    expect(affectedPages([box(4), box(1), box(4, 80), box(0)], 6)).toEqual([0, 1, 4]);
  });
});

describe("clipBoxToPage", () => {
  const view = { width: 612, height: 792 };

  it("leaves a box that is fully on the page alone", () => {
    expect(clipBoxToPage(box(0, 100, 100, 200, 50), view)).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 50,
    });
  });

  it("cuts a box off at the edge of the paper", () => {
    expect(clipBoxToPage(box(0, 500, 700, 400, 300), view)).toEqual({
      x: 500,
      y: 700,
      width: 112,
      height: 92,
    });
  });

  it("cuts a box that hangs off the top left corner", () => {
    expect(clipBoxToPage(box(0, -50, -20, 100, 60), view)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 40,
    });
  });

  it("returns null for a box that misses the page, so the page keeps its text", () => {
    expect(clipBoxToPage(box(0, 900, 900, 50, 50), view)).toBeNull();
    expect(clipBoxesToPage([box(0, 900, 900, 50, 50)], view)).toEqual([]);
  });
});

describe("toCanvasRects", () => {
  const canvas = { width: 1700, height: 2200 }; // Letter at 200 dpi

  it("scales points into canvas pixels", () => {
    const scale = DEFAULT_REDACT_DPI / 72;
    const [rect] = toCanvasRects([{ x: 72, y: 144, width: 72, height: 36 }], scale, canvas);
    expect(rect).toEqual({ x: 200, y: 400, width: 200, height: 100 });
  });

  it("rounds every edge outwards so no sliver of a letter survives", () => {
    const [rect] = toCanvasRects([{ x: 10.4, y: 10.4, width: 10.2, height: 10.2 }], 1, {
      width: 100,
      height: 100,
    });
    // Left and top floor down to 10, right and bottom ceil up to 21.
    expect(rect).toEqual({ x: 10, y: 10, width: 11, height: 11 });
  });

  it("stops at the edge of the canvas", () => {
    const [rect] = toCanvasRects([{ x: 0, y: 0, width: 10_000, height: 10_000 }], 1, canvas);
    expect(rect).toEqual({ x: 0, y: 0, width: 1700, height: 2200 });
  });

  it("drops a rectangle that lands entirely off the canvas", () => {
    expect(toCanvasRects([{ x: 5000, y: 5000, width: 10, height: 10 }], 1, canvas)).toEqual([]);
  });
});

describe("redactionCost", () => {
  it("says the numbers and names every loss before the user commits", () => {
    const cost = redactionCost(2, 90, DEFAULT_REDACT_DPI);
    expect(cost.pagesRasterized).toBe(2);
    expect(cost.pagesKept).toBe(88);
    expect(cost.slow).toBe(false);
    expect(cost.note).toContain("2 of 90");
    expect(cost.note).toContain("88 pages keep their real text");
    expect(cost.note).toContain("screen reader");
    expect(cost.note).toContain("select");
    expect(cost.note).toContain("zoom");
    expect(cost.note).toContain("KB");
    // The kept pages are not free either: the output is a fresh document, so
    // there is no form left for a field to belong to.
    expect(cost.note).toContain("stop being fillable");
    expect(cost.roughBytes).toBeGreaterThan(0);
  });

  it("says nothing about kept pages when every page is being redrawn", () => {
    expect(redactionCost(3, 3).note).not.toContain("keep their real text");
  });

  it("warns when the job is big enough to tie up the tab", () => {
    const cost = redactionCost(LIMITS.warnRasterPages + 1, 500);
    expect(cost.slow).toBe(true);
    expect(cost.note).toContain("takes a while");
  });

  it("grows the size estimate with the dpi", () => {
    expect(redactionCost(1, 10, 400).roughBytes).toBeGreaterThan(
      redactionCost(1, 10, 100).roughBytes,
    );
  });
});

describe("normalizeForSearch", () => {
  it("throws away the spacing that a PDF puts wherever it likes", () => {
    expect(normalizeForSearch(`Jane${NBSP}Roe`)).toBe("janeroe");
    expect(normalizeForSearch("Jane\nRoe")).toBe("janeroe");
    expect(normalizeForSearch("  JANE   roe ")).toBe("janeroe");
  });

  it("folds the characters a typist and a typesetter disagree about", () => {
    expect(normalizeForSearch(`O${RIGHT_QUOTE}Brien`)).toBe("o'brien");
    expect(normalizeForSearch(`con${LIGATURE_FI}dential`)).toBe("confidential");
    expect(normalizeForSearch(`soft${SOFT_HYPHEN}hyphen`)).toBe("softhyphen");
  });
});

describe("containsPhrase", () => {
  const page = `The tenant of record is Jane\nRoe, also known as O${RIGHT_QUOTE}Brien.`;

  it("finds a phrase that the page broke across a line", () => {
    expect(containsPhrase(page, "Jane Roe")).toBe(true);
  });

  it("finds a phrase typed with a straight apostrophe", () => {
    expect(containsPhrase(page, "O'Brien")).toBe(true);
  });

  it("finds a word the page hyphenated at a line break", () => {
    expect(containsPhrase("this is confid-\nential material", "confidential")).toBe(true);
  });

  it("says no to a phrase that is genuinely not there", () => {
    expect(containsPhrase(page, "John Smith")).toBe(false);
    expect(containsPhrase(page, "")).toBe(false);
  });
});

describe("phrasesMissingFromSource", () => {
  it("names the phrases that were never in the document to begin with", () => {
    const original = ["The tenant is Jane Roe.", "Signed at 12 Elm Street."];
    expect(phrasesMissingFromSource(original, ["Jane Roe", "Elm Street", "John Smith"])).toEqual(
      ["John Smith"],
    );
  });
});

describe("isVerdictClean", () => {
  it("is true only when every phrase was really there and is really gone", () => {
    expect(isVerdictClean(["Jane Roe"], [], [])).toBe(true);
  });

  it("is false when a phrase is still readable in the output", () => {
    expect(isVerdictClean(["Jane Roe"], ["Jane Roe"], [])).toBe(false);
  });

  it("is false when a phrase was never in the original, because that proves nothing", () => {
    expect(isVerdictClean(["Jane Roe"], [], ["Jane Roe"])).toBe(false);
  });

  it("is false when nothing was checked", () => {
    expect(isVerdictClean([], [], [])).toBe(false);
  });
});

describe("redact, the cases that must fail before anything is drawn", () => {
  it("refuses an empty selection and leaves the bytes untouched", async () => {
    const bytes = await fixture(2);
    const before = bytes.slice();
    await expect(redact(bytes, { boxes: [] })).rejects.toThrow(PdfOpError);
    expect(bytes).toEqual(before);
  });

  it("refuses a box on a page past the end of a real document", async () => {
    const bytes = readFileSync(SAMPLE_LEASE);
    const pages = (await loadPdf(bytes)).getPageCount();
    await expect(redact(bytes, { boxes: [box(pages + 3)] })).rejects.toThrow(
      new RegExp(`this document has ${pages}`),
    );
  });

  it("refuses a document whose every box has no size", async () => {
    const bytes = await fixture(1);
    await expect(redact(bytes, { boxes: [box(0, 4, 4, 0, 0)] })).rejects.toThrow(/no size/);
  });

  it("turns a failure inside pdf.js into a sentence instead of a raw library error", async () => {
    // Node has no DOMMatrix, so opening for viewing throws here the same way it
    // throws in a browser for a file with a real user password, for a worker
    // script that will not load, and for a file pdf-lib accepts and pdf.js
    // refuses. Opening used to sit outside the guard, so what came back was a
    // bare ReferenceError. common.ts says anything that is not a PdfOpError is
    // a bug in this app, so that error had the UI blaming itself for a locked
    // file. This is the regression lock: whatever pdf.js does, the caller gets
    // a PdfOpError.
    const bytes = await fixture(1);
    const failure = await redact(bytes, { boxes: [box(0)] }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(PdfOpError);
    expect((failure as Error).message).not.toMatch(/DOMMatrix|undefined is not/);
  });
});

describe("a turned page with an offset MediaBox", () => {
  // Worth being straight about what this proves and what it does not. redact
  // measures pages with pdf.js getViewport, which is built on the CropBox and
  // folds in /Rotate and the box origin for us. pageBoxOf reads the MediaBox.
  // The two agree on any file where CropBox is absent or equal to MediaBox,
  // which is the case here and in most files, but they are not the same code
  // path. So this checks the geometry contract that view space carries no
  // origin and swaps sides on a quarter turn, and then feeds the result through
  // the module's own planner. Whether pdf.js agrees on a file with a smaller
  // CropBox is a browser question, listed with the rest of them at the top.
  it("is measured in view space, so the MediaBox origin never reaches a box", async () => {
    const doc = await blankPdf();
    const { degrees } = await pdfLib();
    const page = doc.addPage([400, 600]);
    // Both traps at once: the paper does not start at (0, 0) and the page is
    // displayed on its side.
    page.setMediaBox(20, 30, 400, 600);
    page.setRotation(degrees(90));
    const bytes = await savePdf(doc);

    const reloaded = await loadPdf(bytes);
    const first = reloaded.getPage(0);
    const pageBox = pageBoxOf(first);
    expect(pageBox).toEqual({
      originX: 20,
      originY: 30,
      width: 400,
      height: 600,
      rotation: 90,
    });

    // A quarter turn swaps the sides the reader sees, and the offset origin is
    // not part of that. Boxes are drawn on what the reader sees, so this is the
    // rectangle they get clipped against.
    const view = viewSize(pageBox);
    expect(view).toEqual({ width: 600, height: 400 });

    expect(clipBoxToPage(box(0, 550, 380, 200, 200), view)).toEqual({
      x: 550,
      y: 380,
      width: 50,
      height: 20,
    });
    // Past the short side of the turned page, which would still be on the paper
    // if anyone had used the unrotated height by mistake.
    expect(clipBoxToPage(box(0, 100, 450, 50, 50), view)).toBeNull();

    // And through the planner, so the turned size is what the plan is built on.
    const grouped = groupBoxesByPage([box(0, 100, 450, 50, 50)], 1);
    expect(planRedaction(grouped, new Map([[0, view]])).missed).toEqual([0]);
    expect(
      [...planRedaction(groupBoxesByPage([box(0, 550, 380, 200, 200)], 1), new Map([[0, view]]))
        .paint.keys()],
    ).toEqual([0]);
  });
});

describe("planRedaction", () => {
  const letter = { width: 612, height: 792 };

  function views(...pages: number[]): Map<number, { width: number; height: number }> {
    return new Map(pages.map((p) => [p, letter]));
  }

  it("paints only the pages whose marks land, and leaves the rest alone", () => {
    const grouped = groupBoxesByPage([box(1), box(3)], 4);
    const plan = planRedaction(grouped, views(0, 1, 2, 3));
    expect([...plan.paint.keys()]).toEqual([1, 3]);
    expect(plan.missed).toEqual([]);
  });

  it("reports a marked page whose boxes all fall off the paper instead of skipping it", () => {
    // Page 0 is marked at x=900 on a 612 wide page, so nothing lands. Page 1 is
    // fine. The old code dropped page 0 from the plan and carried on, which is
    // how a page counted as redacted came out with all of its text.
    const grouped = groupBoxesByPage([box(0, 900, 900, 50, 50), box(1)], 3);
    const plan = planRedaction(grouped, views(0, 1, 2));
    expect(plan.missed).toEqual([0]);
    expect([...plan.paint.keys()]).toEqual([1]);
  });

  it("counts a page it was given no size for as missed rather than skipping it", () => {
    const grouped = groupBoxesByPage([box(2)], 4);
    expect(planRedaction(grouped, views(0, 1)).missed).toEqual([2]);
  });

  it("agrees with affectedPages when every mark lands, and is the honest one when they do not", () => {
    const boxes = [box(0, 900, 900, 50, 50), box(1)];
    // affectedPages is a pre-flight guess with no page sizes in hand, so it
    // still counts page 0. planRedaction is the one that has measured.
    expect(affectedPages(boxes, 3)).toEqual([0, 1]);
    expect([...planRedaction(groupBoxesByPage(boxes, 3), views(0, 1, 2)).paint.keys()]).toEqual([
      1,
    ]);
  });
});

describe("pageStillHasText", () => {
  it("is false for the nothing a picture only page extracts to", () => {
    expect(pageStillHasText("")).toBe(false);
    expect(pageStillHasText(" \n\t")).toBe(false);
  });

  it("is true for a single letter or digit that should not be there", () => {
    expect(pageStillHasText("a")).toBe(true);
    expect(pageStillHasText("   7  ")).toBe(true);
  });
});

describe("annotationText", () => {
  it("pulls out the form field value that page text never returns", () => {
    const text = annotationText([
      { fieldName: "tenant.name", fieldValue: "Jane Roe", fieldType: "Tx" },
    ]);
    expect(containsPhrase(text, "Jane Roe")).toBe(true);
    expect(containsPhrase(text, "tenant.name")).toBe(true);
  });

  it("reads a comment, a callout title and a link target", () => {
    const text = annotationText([
      { contentsObj: { str: "check this against Jane Roe" } },
      { titleObj: { str: "note from J. Roe" } },
      { url: "https://example.test/janeroe", unsafeUrl: "https://example.test/janeroe" },
      { richText: { str: "styled Jane Roe" } },
      { alternativeText: "signature of Jane Roe" },
    ]);
    expect(containsPhrase(text, "Jane Roe")).toBe(true);
    expect(containsPhrase(text, "janeroe")).toBe(true);
    expect(containsPhrase(text, "signature of Jane Roe")).toBe(true);
  });

  it("reads a multi select value and the choices in a dropdown", () => {
    const text = annotationText([
      { fieldValue: ["Jane Roe", "John Doe"] },
      { options: [{ exportValue: "R1", displayValue: "Roe, Jane" }] },
      { defaultFieldValue: "unset tenant", buttonValue: "Roe" },
    ]);
    expect(containsPhrase(text, "John Doe")).toBe(true);
    expect(containsPhrase(text, "Roe, Jane")).toBe(true);
    expect(containsPhrase(text, "unset tenant")).toBe(true);
  });

  it("shrugs off the shapes pdf.js actually hands back for a plain annotation", () => {
    expect(annotationText([])).toBe("");
    expect(annotationText([null, undefined, 7, "not a dict"])).toBe("");
    expect(annotationText([{ subtype: "Square", rect: [0, 0, 1, 1] }])).toBe("");
  });
});

describe("a form field on a page nobody marked", () => {
  it("carries its value into the output, which is why the receipt reads annotations", async () => {
    // This is the false clean, reproduced with pdf-lib and nothing else. The
    // field is on page 0, page 0 is never marked, so redact copies it through.
    // getTextContent will not return the value, so a receipt built only on page
    // text would call this file clean with the name still in it.
    const doc = await blankPdf();
    const { StandardFonts } = await pdfLib();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const kept = doc.addPage([612, 792]);
    kept.drawText("Lease, page 1", { x: 72, y: 700, size: 12, font });
    doc.addPage([612, 792]).drawText("Lease, page 2", { x: 72, y: 700, size: 12, font });
    const field = doc.getForm().createTextField("tenant.name");
    field.setText("Jane Roe");
    field.addToPage(kept, { x: 72, y: 600, width: 200, height: 20 });
    const bytes = await savePdf(doc);

    // Exactly what redact does with an untouched page.
    const src = await loadPdf(bytes);
    const out = await blankPdf();
    for (const page of await out.copyPages(src, [0])) out.addPage(page);
    // Object streams compress the strings, so read it back uncompressed to see
    // what is really in there. pdf-lib writes text values as UTF-16BE hex.
    const outBytes = await out.save({ useObjectStreams: false, addDefaultPage: false });
    const utf16 =
      "FEFF" +
      [..."Jane Roe"].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    const raw = Buffer.from(outBytes).toString("latin1").toUpperCase();
    expect(raw).toContain(utf16.toUpperCase());

    // And the widget really does come across, still pointing at its field.
    const reloaded = await loadPdf(outBytes);
    expect(reloaded.getPage(0).node.Annots()?.size()).toBe(1);
    // The form dictionary does not, which is the cost redactionCost now names.
    expect(reloaded.getForm().getFields()).toHaveLength(0);
  });
});
