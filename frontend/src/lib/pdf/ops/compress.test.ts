import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PdfOpError, blankPdf, loadPdf, pdfLib, savePdf } from "./common";
import { BARELY_WORTH_IT, estimateFlatten, flatten, keepSmaller, tidy } from "./compress";

/**
 * What these tests can and cannot reach.
 *
 * tidy is pure pdf-lib, so it runs here for real and every assertion below is
 * about a file that was actually written and read back.
 *
 * flatten cannot draw here. It rasterizes with pdf.js onto a canvas, and vitest
 * runs in node where there is no canvas and no document. So lib/pdf/viewer is
 * replaced with a stand-in that hands back the same shapes the real one does,
 * and everything flatten itself is responsible for still runs for real: the
 * page count it reads, the guards, the clamps, the page sizing, the progress
 * calls, the teardown, and the pdf-lib document it builds, which is written and
 * read back like every other file in here.
 *
 * That stand-in exists because of what it caught. An earlier version of this
 * file tested nothing past flatten's header check and said so in a comment, and
 * while that comment was true viewer.ts changed openForViewing to return a
 * { doc, close } handle instead of the document itself. flatten kept reading
 * .numPages off the handle, got undefined, skipped its own page limit, ran its
 * render loop zero times, and returned a valid empty PDF as an enormous saving.
 * A test that only checks the front door cannot see any of that.
 */

/**
 * A baseline JPEG with real markers and no image data: SOI, JFIF, SOF0 saying
 * 4 by 3 in three channels, an empty scan, EOI. pdf-lib reads a JPEG's markers
 * for its size and never decodes the pixels, so this is enough to get a real
 * embedded image object into a real PDF, which is the part being tested.
 */
const JPEG_STUB = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
  0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x04, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  0xff, 0xd9,
]);

/** Everything the stand-in viewer was asked to do, and what it was told to be. */
const fake = vi.hoisted(() => ({
  /** Sizes pdf.js would report at scale 1, so /Rotate is already folded in. */
  pages: [] as { n: number; width: number; height: number; cleaned: boolean }[],
  opened: 0,
  closed: 0,
  renders: [] as Array<{ page: number; dpi?: number; quality?: number; type?: string }>,
  /** Set to a page number to make that page fail to draw. */
  failOnPage: 0,
}));

vi.mock("../viewer", () => ({
  openForViewing: async () => {
    fake.opened++;
    return {
      doc: {
        numPages: fake.pages.length,
        async getPage(n: number) {
          const page = fake.pages[n - 1];
          if (!page) throw new Error(`asked for page ${n}, which does not exist`);
          return {
            n: page.n,
            width: page.width,
            height: page.height,
            cleanup() {
              page.cleaned = true;
            },
          };
        },
      },
      async close() {
        fake.closed++;
      },
    };
  },
  pageViewSize: (page: { width: number; height: number }) => ({
    width: page.width,
    height: page.height,
  }),
  renderPageToBlob: async (
    page: { n: number },
    options: { dpi?: number; quality?: number; type?: string },
  ) => {
    fake.renders.push({ page: page.n, ...options });
    if (fake.failOnPage === page.n) throw new Error("the canvas gave up");
    return new Blob([JPEG_STUB], { type: "image/jpeg" });
  },
}));

/** Tell the stand-in what document to pretend to be holding. */
function pretendPages(sizes: Array<{ width: number; height: number }>): void {
  fake.pages = sizes.map((s, i) => ({ n: i + 1, width: s.width, height: s.height, cleaned: false }));
}

const SAMPLES = new URL("../../../../../backend/samples/", import.meta.url).pathname;

/** Same numbers every run, so a size assertion cannot pass by luck. */
function pseudoRandomBytes(count: number, seed = 7): Uint8Array {
  const out = new Uint8Array(count);
  let state = seed >>> 0;
  for (let i = 0; i < count; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/** A plain document with real text on every page. */
async function makeDoc(pages = 1, words = "Rent is due on the first of each month."): Promise<Uint8Array> {
  const { StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${words} Page ${i + 1}.`, { x: 72, y: 700, size: 12, font });
  }
  return savePdf(doc);
}

describe("tidy", () => {
  it("keeps every page, its size, its rotation and its MediaBox origin", async () => {
    const { degrees, StandardFonts } = await pdfLib();
    const doc = await blankPdf();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    doc.addPage([612, 792]).drawText("First", { x: 50, y: 700, size: 14, font });

    // The awkward page: turned a quarter, and its box does not start at 0, 0.
    const odd = doc.addPage([400, 500]);
    odd.setMediaBox(20, 30, 400, 500);
    odd.setRotation(degrees(90));

    doc.addPage([419.53, 595.28]);
    const before = await savePdf(doc);

    const result = await tidy(before);
    const back = await loadPdf(result.bytes);

    expect(back.getPageCount()).toBe(3);

    const second = back.getPage(1);
    expect(second.getMediaBox()).toMatchObject({ x: 20, y: 30, width: 400, height: 500 });
    expect(second.getRotation().angle).toBe(90);

    const third = back.getPage(2);
    expect(Math.round(third.getSize().width)).toBe(420);
    expect(Math.round(third.getSize().height)).toBe(595);
  });

  it("carries the title, author and keywords across the rebuild", async () => {
    const doc = await blankPdf();
    doc.addPage([612, 792]);
    doc.setTitle("Apartment Lease");
    doc.setAuthor("Ridge Property Group");
    doc.setKeywords(["force majeure"]);
    const before = await savePdf(doc);

    const result = await tidy(before);
    const back = await loadPdf(result.bytes);

    expect(back.getTitle()).toBe("Apartment Lease");
    expect(back.getAuthor()).toBe("Ridge Property Group");
    expect(back.getKeywords()).toBe("force majeure");
  });

  it("drops an object nothing points at, and reports the saving", async () => {
    const doc = await blankPdf();
    doc.addPage([612, 792]);
    // 40KB of incompressible bytes that no page references. This is what an
    // editor leaves behind when it deletes something badly.
    doc.context.register(doc.context.stream(pseudoRandomBytes(40000)));
    const before = await savePdf(doc);

    const result = await tidy(before);

    expect(result.before).toBe(before.byteLength);
    expect(result.after).toBe(result.bytes.byteLength);
    expect(result.before - result.after).toBeGreaterThan(35000);
    expect(result.warning).toBeUndefined();
    expect((await loadPdf(result.bytes)).getPageCount()).toBe(1);
  });

  it("never returns more bytes than it was given", async () => {
    for (const pages of [1, 2, 10]) {
      const before = await makeDoc(pages);
      const result = await tidy(before);
      expect(result.after).toBeLessThanOrEqual(result.before);
      if (result.after === result.before) {
        expect(result.bytes).toEqual(before);
        expect(result.warning).toBeTruthy();
      }
      expect((await loadPdf(result.bytes)).getPageCount()).toBe(pages);
    }
  });

  it("does not throw away form fields", async () => {
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField("tenant.name");
    field.setText("Ayush");
    field.addToPage(page, { x: 72, y: 600, width: 200, height: 20 });
    const before = await savePdf(doc);

    const result = await tidy(before);
    const back = await loadPdf(result.bytes);
    const names = back.getForm().getFields().map((f) => f.getName());

    expect(names).toEqual(["tenant.name"]);
    expect(result.after).toBeLessThanOrEqual(result.before);
    // The rebuild is skipped for these files, and the result says so out loud.
    expect(result.warning).toContain("form fields");
  });

  it("does not throw away an attached file", async () => {
    const { PDFName } = await pdfLib();
    const doc = await blankPdf();
    doc.addPage([612, 792]);
    await doc.attach(new Uint8Array([1, 2, 3, 4, 5]), "addendum.txt", {
      mimeType: "text/plain",
    });
    const before = await savePdf(doc);

    const result = await tidy(before);
    const back = await loadPdf(result.bytes);

    // A rebuild copies pages and nothing above them, so the name tree holding
    // the attachment would go, and a lease would come back without its
    // addendum. That is a smaller file the same way a shorter lease is.
    expect(back.catalog.lookup(PDFName.of("Names"))).toBeDefined();
    expect(result.warning).toContain("file attachments");
  });

  it("does not throw away page numbering, layers or accessibility tags", async () => {
    const { PDFName } = await pdfLib();
    const cases: Array<[string, string]> = [
      ["PageLabels", "page numbering"],
      ["OCProperties", "layers"],
      ["StructTreeRoot", "accessibility tags"],
    ];

    for (const [key, words] of cases) {
      const doc = await blankPdf();
      doc.addPage([612, 792]);
      doc.catalog.set(PDFName.of(key), doc.context.obj({ Type: PDFName.of(key) }));
      const before = await savePdf(doc);

      const result = await tidy(before);
      const back = await loadPdf(result.bytes);

      expect(back.catalog.lookup(PDFName.of(key))).toBeDefined();
      expect(result.warning).toContain(words);
    }
  });

  it("names everything at risk, not just the first thing it found", async () => {
    const { PDFName } = await pdfLib();
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField("tenant.name").addToPage(page, { x: 72, y: 600 });
    doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({}));

    const result = await tidy(await savePdf(doc));

    expect(result.warning).toContain("form fields");
    expect(result.warning).toContain("page numbering");
    expect(result.warning).toContain(" and ");
  });

  it("admits that it breaks a digital signature, because every re-save does", async () => {
    const { PDFName } = await pdfLib();
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    // pdf-lib cannot author a real signed file, so this is a signature field
    // with nothing signed into it. The detection reads /FT, which is the same
    // thing it would read on a real one.
    const field = doc.getForm().createTextField("landlord.signature");
    field.addToPage(page, { x: 72, y: 500, width: 200, height: 40 });
    field.acroField.dict.set(PDFName.of("FT"), PDFName.of("Sig"));
    // Written without object streams so the re-save genuinely comes out
    // smaller. A signed file that does not shrink keeps its original bytes and
    // has nothing to warn about, which is a different test, below.
    const before = await doc.save({ useObjectStreams: false, addDefaultPage: false });

    const result = await tidy(before);

    expect(result.warning).toMatch(/digitally signed/i);
    expect(result.warning).toMatch(/unsigned/i);
    // Still smaller or equal. The warning is the honesty, not a refusal.
    expect(result.after).toBeLessThanOrEqual(result.before);
  });

  it("does not claim it broke a signature when it kept the original", () => {
    // The worse branch replaced nothing, so there is nothing to have broken.
    const signed = keepSmaller(new Uint8Array(500), new Uint8Array(900), "tidy", {
      worse: "Tidying came out bigger than the original, so the original was kept.",
      better: "This file is digitally signed, and saving a PDF again always breaks it.",
    });
    expect(signed.bytes.byteLength).toBe(500);
    expect(signed.warning).not.toMatch(/signed/i);
  });

  it("says nothing about signatures on a file that has none", async () => {
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField("tenant.name").addToPage(page, { x: 72, y: 600 });

    const result = await tidy(await savePdf(doc));

    expect(result.warning).toContain("form fields");
    expect(result.warning).not.toMatch(/signed/i);
  });

  it("handles the two real sample files without losing a page", async () => {
    for (const name of ["sample-apartment-lease.pdf", "sample-terms-of-service.pdf"]) {
      const before = new Uint8Array(readFileSync(SAMPLES + name));
      const pages = (await loadPdf(before)).getPageCount();

      const result = await tidy(before);

      expect(result.after).toBeLessThanOrEqual(result.before);
      expect((await loadPdf(result.bytes)).getPageCount()).toBe(pages);
      console.log(
        `${name}: ${result.before} -> ${result.after} bytes` +
          (result.warning ? ` (${result.warning})` : ""),
      );
    }
  });

  it("refuses a document with no pages", async () => {
    const empty = await savePdf(await blankPdf());
    await expect(tidy(empty)).rejects.toBeInstanceOf(PdfOpError);
    await expect(tidy(empty)).rejects.toThrow(/no pages/i);
  });

  it("refuses something that is not a PDF", async () => {
    const notPdf = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    await expect(tidy(notPdf)).rejects.toBeInstanceOf(PdfOpError);
  });

  it("does not mutate the bytes it was given", async () => {
    const before = await makeDoc(2);
    const copy = before.slice();
    await tidy(before);
    expect(before).toEqual(copy);
  });
});

describe("keepSmaller", () => {
  const big = new Uint8Array(1000);
  const notes = { worse: "bigger", barely: "hardly worth it", better: "text is gone" };

  it("keeps a candidate that is genuinely smaller", () => {
    const result = keepSmaller(big, new Uint8Array(400), "flatten", notes);
    expect(result.after).toBe(400);
    expect(result.before).toBe(1000);
    expect(result.bytes.byteLength).toBe(400);
    expect(result.warning).toBe("text is gone");
    expect(result.method).toBe("flatten");
  });

  it("leaves the warning off when there is nothing to warn about", () => {
    const result = keepSmaller(big, new Uint8Array(400), "tidy", { worse: "bigger" });
    expect(result.warning).toBeUndefined();
  });

  it("keeps a barely smaller candidate but says it saved nothing", () => {
    // A half percent saving, under the one percent worth mentioning.
    const result = keepSmaller(big, new Uint8Array(995), "tidy", notes);
    expect(result.after).toBe(995);
    expect(result.warning).toBe("hardly worth it");
    expect((1000 - 995) / 1000).toBeLessThan(BARELY_WORTH_IT);
  });

  it("returns the original when the candidate came out bigger", () => {
    const result = keepSmaller(big, new Uint8Array(1400), "flatten", notes);
    expect(result.after).toBe(1000);
    expect(result.before).toBe(1000);
    expect(result.bytes.byteLength).toBe(1000);
    expect(result.warning).toBe("bigger");
  });

  it("returns the original when the candidate is exactly the same size", () => {
    const result = keepSmaller(big, new Uint8Array(1000), "tidy", notes);
    expect(result.after).toBe(1000);
    expect(result.warning).toBe("bigger");
  });

  it("hands back a copy, not the caller's own array", () => {
    const original = new Uint8Array([1, 2, 3, 4]);
    const result = keepSmaller(original, new Uint8Array(9), "tidy", { worse: "bigger" });
    result.bytes[0] = 99;
    expect(original[0]).toBe(1);
  });
});

describe("estimateFlatten", () => {
  it("counts the pixels in a Letter page at 72 dpi exactly", () => {
    const one = estimateFlatten(1, 72);
    expect(one.pixels).toBe(612 * 792);
    expect(one.slow).toBe(false);
  });

  it("scales with the square of the dpi", () => {
    const low = estimateFlatten(4, 100);
    const high = estimateFlatten(4, 200);
    expect(high.pixels).toBe(low.pixels * 4);
  });

  it("guesses an output size in the right ballpark", () => {
    // 10 pages at 120 dpi is about 13.5 megapixels, so a couple of megabytes.
    const guess = estimateFlatten(10, 120);
    expect(guess.roughBytes).toBeGreaterThan(1_000_000);
    expect(guess.roughBytes).toBeLessThan(3_000_000);
  });

  it("calls a long page count slow even at a low dpi", () => {
    expect(estimateFlatten(200, 72).slow).toBe(true);
  });

  it("calls a big pixel count slow even at a short page count", () => {
    expect(estimateFlatten(100, 150).slow).toBe(true);
    expect(estimateFlatten(100, 150).pixels).toBeGreaterThan(100_000_000);
  });

  it("answers zero for zero pages instead of dividing by something", () => {
    expect(estimateFlatten(0, 120)).toEqual({ pixels: 0, roughBytes: 0, slow: false });
  });

  it("falls back to the default dpi when handed a useless one", () => {
    const good = estimateFlatten(3, 120);
    expect(estimateFlatten(3, 0)).toEqual(good);
    expect(estimateFlatten(3, Number.NaN)).toEqual(good);
    expect(estimateFlatten(Number.NaN, 120).pixels).toBe(0);
  });
});

describe("flatten", () => {
  /**
   * A real PDF, deliberately fat. The stand-in viewer never reads this, but
   * flatten's own header check does, and padding it means the flattened
   * candidate is always the smaller of the two so keepSmaller keeps it. A test
   * about the render loop should not be able to fail on a coin flip about
   * which file came out shorter.
   */
  async function bulkyDoc(pages: number): Promise<Uint8Array> {
    const doc = await blankPdf();
    for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
    doc.context.register(doc.context.stream(pseudoRandomBytes(80000, 11)));
    return savePdf(doc);
  }

  beforeEach(() => {
    fake.pages = [];
    fake.opened = 0;
    fake.closed = 0;
    fake.renders = [];
    fake.failOnPage = 0;
  });

  it("rejects a file that is not a PDF before it tries to draw anything", async () => {
    const notPdf = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await expect(flatten(notPdf, {})).rejects.toBeInstanceOf(PdfOpError);
    expect(fake.opened).toBe(0);
  });

  it("builds one page per page, at the size the reader was looking at", async () => {
    // Page two is a /Rotate 90 page. pdf.js reports the turned size, so the new
    // page is landscape and carries no rotation of its own.
    pretendPages([
      { width: 612, height: 792 },
      { width: 792, height: 612 },
      { width: 419.53, height: 595.28 },
    ]);
    const before = await bulkyDoc(3);

    const result = await flatten(before, {});

    expect(result.method).toBe("flatten");
    expect(result.after).toBeLessThan(result.before);
    expect(result.warning).toMatch(/no longer be selected/i);

    const back = await loadPdf(result.bytes);
    expect(back.getPageCount()).toBe(3);
    expect(back.getPage(0).getSize()).toMatchObject({ width: 612, height: 792 });
    expect(back.getPage(1).getSize()).toMatchObject({ width: 792, height: 612 });
    expect(Math.round(back.getPage(2).getSize().width)).toBe(420);
    for (const i of [0, 1, 2]) expect(back.getPage(i).getRotation().angle).toBe(0);
  });

  it("draws every page once, cleans it up, and closes the document", async () => {
    pretendPages([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    const steps: Array<[number, number, string | undefined]> = [];

    await flatten(await bulkyDoc(2), { onProgress: (d, t, label) => steps.push([d, t, label]) });

    expect(fake.renders.map((r) => r.page)).toEqual([1, 2]);
    expect(fake.pages.every((p) => p.cleaned)).toBe(true);
    expect(steps).toEqual([
      [1, 2, "Page 1 of 2"],
      [2, 2, "Page 2 of 2"],
    ]);
    expect(fake.opened).toBe(1);
    expect(fake.closed).toBe(1);
  });

  it("refuses a document with no pages instead of returning an empty one", async () => {
    pretendPages([]);
    await expect(flatten(await bulkyDoc(1), {})).rejects.toThrow(/no pages/i);
    expect(fake.renders).toHaveLength(0);
    expect(fake.closed).toBe(1);
  });

  it("refuses more pages than it will take on", async () => {
    pretendPages(Array.from({ length: 5001 }, () => ({ width: 612, height: 792 })));
    await expect(flatten(await bulkyDoc(1), {})).rejects.toThrow(/5001 pages/);
    // The guard has to fire before the first page is drawn, not after 5000.
    expect(fake.renders).toHaveLength(0);
  });

  it("refuses a page too big for a browser to draw, and says which one", async () => {
    pretendPages([
      { width: 612, height: 792 },
      { width: 612, height: 20000 },
    ]);
    await expect(flatten(await bulkyDoc(2), { dpi: 200 })).rejects.toThrow(/Page 2/);
    expect(fake.closed).toBe(1);
  });

  it("closes the document when a page will not draw, and blames the drawing", async () => {
    pretendPages([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    fake.failOnPage = 2;

    await expect(flatten(await bulkyDoc(2), {})).rejects.toThrow(/could not be flattened/i);
    expect(fake.closed).toBe(1);
  });

  it("holds dpi and quality inside their range", async () => {
    pretendPages([{ width: 612, height: 792 }]);
    await flatten(await bulkyDoc(1), { dpi: 5000, quality: 9 });
    expect(fake.renders[0]).toMatchObject({ dpi: 400, quality: 1, type: "image/jpeg" });
  });

  it("falls back to the same dpi the estimate promised when handed a useless one", async () => {
    pretendPages([{ width: 612, height: 792 }]);
    // An empty number box in the UI arrives as NaN. Rendering that at the
    // bottom of the range would produce a fax, and the estimate the user was
    // shown was computed at 120.
    await flatten(await bulkyDoc(1), { dpi: Number.NaN, quality: Number.NaN });
    expect(fake.renders[0]).toMatchObject({ dpi: 120, quality: 0.7 });
  });

  it("does not mutate the bytes it was given", async () => {
    pretendPages([{ width: 612, height: 792 }]);
    const before = await bulkyDoc(1);
    const copy = before.slice();
    await flatten(before, {});
    expect(before).toEqual(copy);
  });
});
