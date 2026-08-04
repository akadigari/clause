/**
 * The test that decides whether editing text is honest.
 *
 * Everything else about the edit path can be right and this can still be
 * wrong: the page looks changed, the person believes the old figure is gone,
 * and `pdftotext` hands it straight back. So this goes through the real
 * `replaceText`, saves the file, runs text extraction on the saved bytes, and
 * demands the original string is nowhere in the output.
 *
 * It also checks the other half, which is easier to forget: when the cut is
 * refused, the result has to SAY it was refused. A quiet fallback to painting
 * over is exactly the bug this whole change exists to remove.
 *
 * There was a byte-level test here that searched the saved file for the old
 * number. It was deleted rather than fixed, because it could not fail: pdf-lib
 * writes strings hex encoded, so the plain digits were never in those bytes
 * whether the words had been cut out or not. The same check lives in
 * excise.test.ts at the layer that knows how the encoding works.
 *
 * pdf.js is mocked onto its legacy build here for the same reason excise.test
 * does it: the modern build needs DOMMatrix and dies in node. Same library,
 * same logic, different build.
 */

import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";

const STANDARD_FONTS = fileURLToPath(
  new URL("../../../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url),
);

vi.mock("../viewer", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return {
    openForViewing: async (data: Uint8Array) => {
      const task = pdfjs.getDocument({
        data: new Uint8Array(data),
        password: "",
        standardFontDataUrl: STANDARD_FONTS,
      });
      const doc = await task.promise;
      return {
        doc,
        close: async () => {
          try {
            await task.destroy();
          } catch {
            /* already torn down */
          }
        },
      };
    },
    pageText: async (page: PDFPageProxy) => {
      const content = await page.getTextContent();
      let out = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        out += item.str;
        if (item.hasEOL) out += "\n";
      }
      return out;
    },
  };
});

const { openForViewing, pageText } = await import("../viewer");
const { blankPdf, pdfLib, savePdf } = await import("./common");
const { replaceText } = await import("./edit");

const SECRET = "Salary: 250000 USD";

/**
 * One line of real text at a known spot. Drawn at user y 538, which is where a
 * line box at view (100, 50) 12 points tall with its baseline 12 down sits on a
 * 600 point page.
 */
async function pageSaying(text: string): Promise<Uint8Array> {
  const { StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const page = doc.addPage([400, 600]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 100, y: 538, size: 12, font });
  return savePdf(doc);
}

/** What a text extractor reads out of the saved file, page by page. */
async function extractAll(bytes: Uint8Array): Promise<string> {
  const opened = await openForViewing(bytes);
  const parts: string[] = [];
  for (let n = 1; n <= opened.doc.numPages; n++) {
    parts.push(await pageText(await opened.doc.getPage(n)));
  }
  await opened.close();
  return parts.join("\n");
}

const RUN = { x: 100, y: 50, width: 110, height: 14.64 };

describe("editing text really removes the old words", () => {
  it("the original string does not appear anywhere in the extracted text", async () => {
    const before = await pageSaying(SECRET);
    expect(await extractAll(before)).toContain(SECRET);

    const out = await replaceText(before, [
      {
        page: 0,
        rect: RUN,
        baseline: 12,
        original: SECRET,
        text: "Salary: withheld",
      },
    ]);

    const after = await extractAll(out.bytes);
    expect(after).toContain("Salary: withheld");
    // The assertion this file exists for.
    expect(after).not.toContain(SECRET);
    expect(after).not.toContain("250000");
    expect(out.removed).toBe(1);
    expect(out.covered).toBe(0);
  });

  it("erasing with an empty replacement removes the words too", async () => {
    const out = await replaceText(await pageSaying(SECRET), [
      { page: 0, rect: RUN, baseline: 12, original: SECRET, text: "" },
    ]);
    expect(await extractAll(out.bytes)).not.toContain("250000");
    expect(out.removed).toBe(1);
  });
});

describe("when the cut is refused, the result says so", () => {
  it("falls back to covering and reports it, rather than failing", async () => {
    // No `original`, so there is nothing to confirm a match against and the
    // cut is never attempted. This is the old behaviour, and it has to keep
    // working and keep being declared.
    const out = await replaceText(await pageSaying(SECRET), [
      { page: 0, rect: RUN, baseline: 12, text: "Salary: withheld" },
    ]);
    expect(out.applied).toBe(1);
    expect(out.removed).toBe(0);
    expect(out.covered).toBe(1);
    // The page reads as changed, and the file still says the old thing. That
    // is the case the interface has to warn about.
    const after = await extractAll(out.bytes);
    expect(after).toContain("Salary: withheld");
    expect(after).toContain(SECRET);
  });

  it("covers when the original given does not match what is on the page", async () => {
    const out = await replaceText(await pageSaying(SECRET), [
      {
        page: 0,
        rect: RUN,
        baseline: 12,
        original: "Something the page never said",
        text: "Salary: withheld",
      },
    ]);
    expect(out.removed).toBe(0);
    expect(out.covered).toBe(1);
  });

  it("counts each run separately across a mixed batch", async () => {
    const { StandardFonts } = await pdfLib();
    const doc = await blankPdf();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 600]);
    page.drawText(SECRET, { x: 100, y: 538, size: 12, font });
    page.drawText("Second line here", { x: 100, y: 500, size: 12, font });

    const out = await replaceText(await savePdf(doc), [
      { page: 0, rect: RUN, baseline: 12, original: SECRET, text: "cut" },
      // No original on this one, so it can only be covered.
      { page: 0, rect: { ...RUN, y: 88 }, baseline: 12, text: "covered" },
    ]);
    expect(out.removed).toBe(1);
    expect(out.covered).toBe(1);
    expect(out.applied).toBe(2);
  });
});
