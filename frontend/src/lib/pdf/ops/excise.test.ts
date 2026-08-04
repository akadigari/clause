/**
 * What these tests are actually checking.
 *
 * The whole promise of excise.ts is about the file, not about the picture, so
 * almost every test here ends the same way: save the result, read the text back
 * out of it with pdf.js, and look for the words that were supposed to go. A
 * test that only inspected the content stream would pass on a file no reader
 * could open, which is the exact failure this module exists to avoid.
 *
 * About the stand-in for lib/pdf/viewer.
 *
 * viewer.ts imports the modern pdf.js build and the worker as a Vite asset URL.
 * Neither survives node: the modern build uses JavaScript this node does not
 * have yet, and pdf.js itself prints "Please use the legacy build in Node.js
 * environments" when you try. So the mock below is viewer.ts's two text
 * functions written again on top of pdf.js's own legacy build, byte for byte
 * the same logic reading the same library. It is the build that changes, not
 * the behaviour, so what excise.ts sees here is what it sees in a browser.
 *
 * The fixtures write their content streams by hand rather than through
 * page.drawText, because most of what can go wrong here lives in shapes
 * pdf-lib never produces: TJ arrays with kerning, several streams per page,
 * inline images, two runs on top of each other. The tests for rotation and for
 * an offset MediaBox do use drawText, since there the point is that a normal
 * file from a normal writer lands in the right place.
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api";

/**
 * Where pdf.js finds the metrics for the fourteen built-in fonts.
 *
 * The browser fetches these over HTTP from the app's own assets. In node there
 * is nothing to fetch from, so this points straight at the copy inside the
 * package. Without it every page drawn in Helvetica loads with warnings and
 * guessed widths.
 */
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

import { userToView, type PageBox, type Point } from "../geometry";
import { blankPdf, loadPdf, pdfLib, savePdf } from "./common";
import { exciseTextRun, type ExciseTarget } from "./excise";

// ---------------------------------------------------------------------------
// Building documents to cut up
// ---------------------------------------------------------------------------

type PageSpec = {
  /** Content streams, in drawing order. More than one means an array Contents. */
  streams: string[];
  /** Width and height in points. */
  size?: [number, number];
  /** MediaBox lower left corner, which is not always at zero. */
  origin?: [number, number];
  rotation?: number;
  /** Write the streams Flate compressed, which is what real files do. */
  compress?: boolean;
};

const PAGE: [number, number] = [400, 300];

function boxOf(spec: PageSpec): PageBox {
  const [width, height] = spec.size ?? PAGE;
  const [originX, originY] = spec.origin ?? [0, 0];
  return {
    originX,
    originY,
    width,
    height,
    rotation: ((spec.rotation ?? 0) % 360) as 0 | 90 | 180 | 270,
  };
}

/** A document whose pages carry exactly the instructions the test wrote. */
async function handWritten(specs: PageSpec[]): Promise<Uint8Array> {
  const doc = await blankPdf();
  const { StandardFonts, PDFName, PDFArray, degrees } = await pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of specs) {
    const [width, height] = spec.size ?? PAGE;
    const [originX, originY] = spec.origin ?? [0, 0];
    const page = doc.addPage([width, height]);
    page.setMediaBox(originX, originY, width, height);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    // Every hand written stream below says /F1, so the resource has to exist
    // under that name or pdf.js draws nothing and reports no text.
    page.node.setFontDictionary(PDFName.of("F1"), font.ref);

    const refs = spec.streams.map((text) =>
      doc.context.register(
        spec.compress ? doc.context.flateStream(text) : doc.context.stream(text),
      ),
    );
    const only = refs[0];
    if (refs.length === 1 && only) {
      page.node.set(PDFName.of("Contents"), only);
    } else {
      const array = PDFArray.withContext(doc.context);
      for (const ref of refs) array.push(ref);
      page.node.set(PDFName.of("Contents"), array);
    }
  }

  return savePdf(doc);
}

/**
 * The same thing, but the stream body is bytes.
 *
 * Inline image data is binary by definition, and the interesting cases are the
 * ones where those bytes look like something they are not, which a string
 * literal in a test file cannot express.
 */
async function handWrittenRaw(streams: Uint8Array[]): Promise<Uint8Array> {
  const doc = await blankPdf();
  const { StandardFonts, PDFName, PDFArray } = await pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  page.node.setFontDictionary(PDFName.of("F1"), font.ref);

  const refs = streams.map((data) => doc.context.register(doc.context.stream(data)));
  const only = refs[0];
  if (refs.length === 1 && only) {
    page.node.set(PDFName.of("Contents"), only);
  } else {
    const array = PDFArray.withContext(doc.context);
    for (const ref of refs) array.push(ref);
    page.node.set(PDFName.of("Contents"), array);
  }
  return savePdf(doc);
}

/** Glue several pieces of a content stream, text and binary alike, into one. */
function joinBytes(parts: Array<string | Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks = parts.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A document written the ordinary way, by asking pdf-lib to draw the words. */
async function drawn(
  lines: Array<{ text: string; x: number; y: number; size?: number }>,
  options: { size?: [number, number]; origin?: [number, number]; rotation?: number } = {},
): Promise<Uint8Array> {
  const doc = await blankPdf();
  const { StandardFonts, degrees } = await pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [width, height] = options.size ?? PAGE;
  const [originX, originY] = options.origin ?? [0, 0];
  const page = doc.addPage([width, height]);
  page.setMediaBox(originX, originY, width, height);
  if (options.rotation) page.setRotation(degrees(options.rotation));
  for (const line of lines) {
    page.drawText(line.text, { x: line.x, y: line.y, size: line.size ?? 12, font });
  }
  return savePdf(doc);
}

// ---------------------------------------------------------------------------
// Reading documents back
// ---------------------------------------------------------------------------

type Piece = { str: string; x: number; y: number; width: number; size: number };

async function openLegacy(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password: "",
    standardFontDataUrl: STANDARD_FONTS,
  });
  return { doc: await task.promise, close: () => task.destroy() };
}

/** Every run on a page, positioned in view space the way pageTextPieces does it. */
async function piecesOn(bytes: Uint8Array, index: number): Promise<Piece[]> {
  const open = await openLegacy(bytes);
  try {
    const page = await open.doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const out: Piece[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str === "") continue;
      const transform = item.transform as number[];
      const [vx, vy] = viewport.convertToViewportPoint(
        transform[4] ?? 0,
        transform[5] ?? 0,
      ) as [number, number];
      const size = Math.hypot(transform[1] ?? 0, transform[3] ?? 0) || item.height || 0;
      out.push({ str: item.str, x: vx, y: vy - size, width: item.width, size });
    }
    return out;
  } finally {
    await open.close();
  }
}

/** The strings on a page, in order, which is what has to survive a cut. */
async function stringsOn(bytes: Uint8Array, index: number): Promise<string[]> {
  return (await piecesOn(bytes, index)).map((piece) => piece.str);
}

/** A whole document's text, for asking whether some words are anywhere at all. */
async function wholeText(bytes: Uint8Array): Promise<string> {
  const open = await openLegacy(bytes);
  try {
    let out = "";
    for (let n = 1; n <= open.doc.numPages; n += 1) {
      const page = await open.doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!("str" in item)) continue;
        out += item.str;
        if (item.hasEOL) out += "\n";
      }
      out += "\n";
    }
    return out;
  } finally {
    await open.close();
  }
}

/** The page's instructions, decoded, so a test can look at what was written. */
async function contentOn(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await loadPdf(bytes);
  const { PDFArray, PDFRawStream, decodePDFRawStream } = await pdfLib();
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  let out = "";
  for (const entry of entries) {
    const stream = doc.context.lookup(entry);
    if (!(stream instanceof PDFRawStream)) continue;
    out += new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
    out += "\n";
  }
  return out;
}

/** The saved bytes as characters, for proving the old words are not still in there. */
function asCharacters(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

// ---------------------------------------------------------------------------
// Pointing at a run
// ---------------------------------------------------------------------------

/**
 * A target built from a point in user space, for the pages whose geometry the
 * test wrote itself and therefore already knows.
 */
function targetAt(page: number, baseline: Point, box: PageBox, text: string, size = 12): ExciseTarget {
  const view = userToView(baseline, box);
  return {
    page,
    rect: { x: view.x, y: view.y - size, width: 40, height: size },
    baseline: size,
    text,
  };
}

/**
 * A target built the way the editor builds one: from what pdf.js says is on the
 * page. This is the path that matters for rotation and for an offset MediaBox,
 * because nothing in the test does the geometry by hand.
 */
async function targetFor(bytes: Uint8Array, page: number, text: string): Promise<ExciseTarget> {
  const pieces = await piecesOn(bytes, page);
  const piece = pieces.find((one) => one.str.includes(text));
  if (!piece) {
    throw new Error(`no run on page ${page + 1} says "${text}", only ${JSON.stringify(pieces)}`);
  }
  return {
    page,
    rect: { x: piece.x, y: piece.y, width: piece.width, height: piece.size },
    baseline: piece.size,
    text: piece.str,
  };
}

/** Shorthand for a text object placed with Tm, which is how most writers place one. */
function block(x: number, y: number, body: string, size = 12): string {
  return `BT\n/F1 ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n${body}\nET\n`;
}

// ---------------------------------------------------------------------------

describe("exciseTextRun, the headline promise", () => {
  it("takes the words out of the file, not just out of sight", async () => {
    const bytes = await handWritten([
      {
        streams: [
          block(40, 220, "(Heading here) Tj") +
            block(40, 180, "(Salary 250000 pounds) Tj") +
            block(40, 140, "(Signed by the parties) Tj"),
        ],
      },
    ]);

    expect(await wholeText(bytes)).toContain("Salary 250000 pounds");

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 180 }, boxOf({ streams: [] }), "Salary 250000 pounds"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const after = await wholeText(outcome.bytes);
    expect(after).not.toContain("Salary 250000 pounds");
    expect(after).not.toContain("250000");
    expect(outcome.removed).toBe("Salary 250000 pounds");
  });

  it("leaves the old words nowhere in the saved bytes either", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 220, "(Keep me) Tj") + block(40, 180, "(Zzyzx) Tj")] },
    ]);
    expect(asCharacters(bytes)).toContain("Zzyzx");

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 180 }, boxOf({ streams: [] }), "Zzyzx"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The stream that held those letters is not just unused, it is gone. An
    // unreferenced object is still written into the saved file.
    expect(asCharacters(outcome.bytes)).not.toContain("Zzyzx");
    expect(asCharacters(outcome.bytes)).toContain("Keep me");
  });
});

describe("exciseTextRun, what has to survive", () => {
  it("leaves every other run saying exactly what it said, in the same order", async () => {
    const bytes = await handWritten([
      {
        streams: [
          block(40, 240, "(One) Tj") +
            block(40, 200, "(Two) Tj") +
            block(40, 160, "(Three) Tj") +
            block(40, 120, "(Four) Tj"),
        ],
      },
    ]);
    const before = await stringsOn(bytes, 0);
    expect(before).toEqual(["One", "Two", "Three", "Four"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 160 }, boxOf({ streams: [] }), "Three"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await stringsOn(outcome.bytes, 0)).toEqual(["One", "Two", "Four"]);
  });

  it("leaves the runs around the cut at exactly the coordinates they had", async () => {
    // Three lines inside ONE text object, so the cut lands in the middle of a
    // block rather than between two of them. Every line is positioned by its
    // own Td, so none of them depends on how wide the line above it was.
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 240 Tm\n(First line here) Tj\n" +
            "0 -20 Td\n(Second line here) Tj\n" +
            "0 -20 Td\n(Third line here) Tj\nET\n",
        ],
      },
    ]);
    const before = await piecesOn(bytes, 0);
    expect(before.map((piece) => piece.str)).toEqual([
      "First line here",
      "Second line here",
      "Third line here",
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 220 }, boxOf({ streams: [] }), "Second line here"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const after = await piecesOn(outcome.bytes, 0);
    expect(after.map((piece) => piece.str)).toEqual(["First line here", "Third line here"]);

    // The point of this test is the numbers, not the strings. Text extraction
    // reports what a page says and not where, so a page whose bottom half slid
    // sideways reads exactly the same and only the coordinates give it away.
    for (const piece of after) {
      const was = before.find((one) => one.str === piece.str);
      expect(was).toBeTruthy();
      if (!was) continue;
      expect(piece.x).toBeCloseTo(was.x, 6);
      expect(piece.y).toBeCloseTo(was.y, 6);
      expect(piece.width).toBeCloseTo(was.width, 6);
    }
  });

  it("leaves the other pages alone", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(Page one word) Tj")] },
      { streams: [block(40, 200, "(Page two word) Tj")] },
      { streams: [block(40, 200, "(Page three word) Tj")] },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(1, { x: 40, y: 200 }, boxOf({ streams: [] }), "Page two word"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Page one word"]);
    expect(await stringsOn(outcome.bytes, 1)).toEqual([]);
    expect(await stringsOn(outcome.bytes, 2)).toEqual(["Page three word"]);
  });

  it("never touches the bytes it was given", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(Alpha) Tj") + block(40, 160, "(Bravo) Tj")] },
    ]);
    const untouched = bytes.slice();

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Alpha"),
    );
    expect(outcome.ok).toBe(true);
    expect(bytes).toEqual(untouched);

    // And the same call twice on the same array gives the same answer, which is
    // only true if the first one really did leave it alone.
    const again = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Alpha"),
    );
    expect(again.ok).toBe(true);
  });
});

describe("exciseTextRun, pages that are not the easy shape", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    it(`finds the right run on a page turned ${rotation} degrees`, async () => {
      const bytes = await drawn(
        [
          { text: "Top line", x: 40, y: 220 },
          { text: "Middle line", x: 40, y: 180 },
          { text: "Bottom line", x: 40, y: 140 },
        ],
        { rotation },
      );

      const target = await targetFor(bytes, 0, "Middle line");
      const outcome = await exciseTextRun(bytes, target);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(await stringsOn(outcome.bytes, 0)).toEqual(["Top line", "Bottom line"]);
    });
  }

  it("works when the MediaBox does not start at zero", async () => {
    const bytes = await drawn(
      [
        { text: "First offset line", x: 60, y: 250 },
        { text: "Second offset line", x: 60, y: 210 },
      ],
      { origin: [20, 30] },
    );

    const target = await targetFor(bytes, 0, "Second offset line");
    const outcome = await exciseTextRun(bytes, target);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["First offset line"]);
  });

  it("works when the MediaBox is offset and the page is turned as well", async () => {
    const bytes = await drawn(
      [
        { text: "Turned first", x: 60, y: 250 },
        { text: "Turned second", x: 60, y: 210 },
      ],
      { origin: [20, 30], rotation: 270 },
    );

    const target = await targetFor(bytes, 0, "Turned first");
    const outcome = await exciseTextRun(bytes, target);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Turned second"]);
  });
});

describe("exciseTextRun, streams that are not the easy shape", () => {
  it("reads an array of streams as one, even when a text object straddles two", async () => {
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n",
          "(Split across streams) Tj\nET\n",
          block(40, 160, "(Second stream run) Tj"),
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Split across streams", "Second stream run"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Split across streams"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Second stream run"]);
    // Whatever the page had before, it comes back as one plain stream.
    expect(await contentOn(outcome.bytes, 0)).toContain("() Tj");
  });

  it("reads compressed streams and writes back a plain one", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(Compressed one) Tj") + block(40, 160, "(Compressed two) Tj")], compress: true },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 160 }, boxOf({ streams: [] }), "Compressed two"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Compressed one"]);
    const content = await contentOn(outcome.bytes, 0);
    expect(content).toContain("(Compressed one) Tj");
    expect(content).toContain("() Tj");
  });

  it("keeps the kerning in a TJ array and only empties its strings", async () => {
    const bytes = await handWritten([
      {
        streams: [
          block(40, 200, "[(Se) -20 (cr) -20 (et)] TJ") + block(40, 160, "(Plain neighbour) Tj"),
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Secret", "Plain neighbour"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Secret"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const content = await contentOn(outcome.bytes, 0);
    expect(content).toContain("[() -20 () -20 ()] TJ");
    expect(content).toContain("(Plain neighbour) Tj");
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Plain neighbour"]);
  });

  it("skips an inline image instead of reading its bytes as instructions", async () => {
    // The image data is written to look exactly like a text object at the same
    // spot as the real one. A tokenizer that walked into it would see two runs
    // there and give up, so this passing is the proof that it skipped.
    const image =
      "q\n60 0 0 20 40 40 cm\n" +
      "BI /W 34 /H 1 /CS /G /BPC 8 ID BT 1 0 0 1 40 200 Tm (Ghost) Tj ET\nEI\nQ\n";
    const bytes = await handWritten([
      { streams: [image + block(40, 200, "(Real run) Tj") + block(40, 160, "(Other run) Tj")] },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Real run"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Other run"]);
  });

  it("reads past an EI that is really two bytes of picture", async () => {
    // /W 40 /H 1 /BPC 8 /CS /G means exactly 40 bytes of data, and those 40
    // bytes happen to contain a blank, E, I, a blank. That is precisely the
    // pattern that closes an inline image, so a scan that takes the first one
    // it finds stops here, four bytes in, and reads the remaining 36 bytes of
    // picture as drawing instructions. One of them is an open bracket, which
    // then swallows the rest of the page as a string.
    const data = new Uint8Array(40);
    data[0] = 0x01;
    data[1] = 0x20;
    data[2] = 0x45; // E
    data[3] = 0x49; // I
    data[4] = 0x20;
    data[5] = 0x28; // (
    for (let n = 6; n < data.length; n += 1) data[n] = 0x80 + (n % 32);

    const bytes = await handWrittenRaw([
      joinBytes([
        "BI /W 40 /H 1 /CS /G /BPC 8 ID ",
        data,
        "\nEI\n",
        block(40, 200, "(Real run) Tj"),
        block(40, 160, "(Other run) Tj"),
      ]),
    ]);
    // pdf.js works the length out from the image's own dictionary and skips the
    // lot, so both readers have to agree there are two runs here and no more.
    expect(await stringsOn(bytes, 0)).toEqual(["Real run", "Other run"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Real run"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Other run"]);
  });

  it("believes an inline image that says how long it is", async () => {
    // Worse than the last one, because these bytes get past the "does the rest
    // of this look like instructions" test as well: after the false EI comes
    // an open bracket and then ordinary letters. Only the declared length
    // saves this one.
    const data = new Uint8Array(24);
    data[0] = 0x20;
    data[1] = 0x45; // E
    data[2] = 0x49; // I
    data[3] = 0x20;
    data[4] = 0x28; // (
    for (let n = 5; n < data.length; n += 1) data[n] = 0x41 + (n % 24);

    const bytes = await handWrittenRaw([
      joinBytes([
        `BI /W 24 /H 1 /CS /G /BPC 8 /L ${data.length} ID `,
        data,
        "\nEI\n",
        block(40, 200, "(Declared length) Tj"),
        block(40, 160, "(Neighbour run) Tj"),
      ]),
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Declared length", "Neighbour run"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Declared length"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Neighbour run"]);
  });

  it("follows q, Q and cm when working out where a run sits", async () => {
    // The words are drawn at 0 40 in text space, and the cm inside q pushes
    // them to 40 200 on the page. Anything that ignored cm would look for them
    // in the corner.
    const bytes = await handWritten([
      {
        streams: [
          "q\n1 0 0 1 40 160 cm\n" +
            block(0, 40, "(Moved by cm) Tj") +
            "Q\n" +
            block(40, 120, "(Not moved) Tj"),
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Moved by cm", "Not moved"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Moved by cm"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Not moved"]);
  });

  it("follows Td, TD, TL and T star down a paragraph", async () => {
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n40 240 Td\n(First of four) Tj\n" +
            "0 -20 TD\n(Second of four) Tj\n" +
            "T*\n(Third of four) Tj\n" +
            "16 TL\nT*\n(Fourth of four) Tj\nET\n",
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual([
      "First of four",
      "Second of four",
      "Third of four",
      "Fourth of four",
    ]);

    // Td put the first line at 240, TD dropped 20, T* repeated that drop, then
    // TL changed the drop to 16. So the last line sits at 240 - 20 - 20 - 16.
    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 184 }, boxOf({ streams: [] }), "Fourth of four"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual([
      "First of four",
      "Second of four",
      "Third of four",
    ]);
  });

  it("counts the rise from Ts, so a footnote mark is not the line it sits on", async () => {
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n(Body text) Tj\n" +
            "1 0 0 1 120 200 Tm\n6 Ts\n(Raised bit) Tj\n0 Ts\nET\n",
        ],
      },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 120, y: 206 }, boxOf({ streams: [] }), "Raised bit"),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Body text"]);
  });

  it("reads hex strings, which is what pdf-lib itself writes", async () => {
    const bytes = await drawn([
      { text: "Written as hex", x: 40, y: 200 },
      { text: "Also as hex", x: 40, y: 160 },
    ]);
    expect(await contentOn(bytes, 0)).toContain("Tj");

    const target = await targetFor(bytes, 0, "Written as hex");
    const outcome = await exciseTextRun(bytes, target);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await stringsOn(outcome.bytes, 0)).toEqual(["Also as hex"]);
    expect(await contentOn(outcome.bytes, 0)).toContain("<> Tj");
  });
});

describe("exciseTextRun, when it refuses", () => {
  it("refuses when two runs start in nearly the same place", async () => {
    const bytes = await handWritten([
      {
        streams: [block(40, 200, "(Alpha) Tj") + block(40.5, 200, "(Bravo) Tj")],
      },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Alpha"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("2 runs start within");
  });

  it("refuses when nothing at all is drawn there", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(Somewhere else) Tj")] },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 300, y: 60 }, boxOf({ streams: [] }), "Somewhere else"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("no run starts within");
  });

  it("refuses when the run at that spot says something else", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(What it really says) Tj") + block(40, 160, "(Other) Tj")] },
    ]);

    const outcome = await exciseTextRun(bytes, {
      page: 0,
      rect: { x: 40, y: 88, width: 60, height: 12 },
      baseline: 12,
      text: "What it really says",
    });
    expect(outcome.ok).toBe(true);

    const wrong = await exciseTextRun(bytes, {
      ...targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "What it really says"),
      text: "Other",
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.reason).toContain("says");
  });

  it("refuses when the page never said those words", async () => {
    const bytes = await handWritten([{ streams: [block(40, 200, "(Only this) Tj")] }]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Something never printed"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("does not say");
  });

  it("refuses when the same words are printed twice on the page", async () => {
    const bytes = await handWritten([
      {
        streams: [
          block(40, 220, "(Jane Roe) Tj") +
            block(40, 180, "(Some other line) Tj") +
            block(40, 140, "(Jane Roe) Tj"),
        ],
      },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 220 }, boxOf({ streams: [] }), "Jane Roe"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("more than once");
    // And nothing was handed back to save, so the caller cannot use it by
    // accident.
    expect("bytes" in outcome).toBe(false);
  });

  it("refuses to cut a run that the next one is leaning on", async () => {
    // Three strings, one Tm, no repositioning between them. The second and
    // third are drawn wherever the one before them stopped, so emptying the
    // first drags them both about 37pt back down the line. Nothing downstream
    // could catch that: the page still says all the same remaining words in
    // the same order, and a text extractor reports words and not places.
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n" +
            "(Salary ) Tj\n(250000) Tj\n( pounds) Tj\nET\n" +
            block(40, 160, "(Untouched line) Tj"),
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Salary 250000 pounds", "Untouched line"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Salary"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("slide it along the line");
  });

  it("refuses the same way when both runs are TJ arrays", async () => {
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n" +
            "[(Con) -15 (fidential)] TJ\n[( and secret)] TJ\nET\n",
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Confidential and secret"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Confidential"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("slide it along the line");
  });

  it("refuses when joining the streams changes what the rest of the page says", async () => {
    // The spec only lets a Contents array break between tokens, and this one
    // breaks in the middle of a string, which real files occasionally do. A
    // newline goes in at every join here so two operators cannot be glued into
    // one, and on a file like this that newline lands inside the string. The
    // words the cut was not asked about come out different, and the last check
    // is the only thing standing between that and a saved file.
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n(Straddling ru",
          "n) Tj\nET\n" + block(40, 160, "(Second) Tj"),
        ],
      },
    ]);
    expect(await stringsOn(bytes, 0)).toEqual(["Straddling run", "Second"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 160 }, boxOf({ streams: [] }), "Second"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("did not come through the cut unchanged");
  });

  it("refuses a run that follows another run rather than guessing where it starts", async () => {
    const bytes = await handWritten([
      {
        streams: [
          "BT\n/F1 12 Tf\n1 0 0 1 40 200 Tm\n(First half ) Tj\n(second half) Tj\nET\n",
        ],
      },
    ]);
    expect((await wholeText(bytes)).replace(/\s+/g, " ")).toContain("second half");

    // The second Tj starts wherever the first one ended, which this file does
    // not work out, so pointing at it finds nothing rather than a guess. The
    // words really are about 60pt along the line, which is what makes this a
    // fair ask and not a target in the wrong place.
    const outcome = await exciseTextRun(bytes, {
      page: 0,
      rect: { x: 100, y: 88, width: 40, height: 12 },
      baseline: 12,
      text: "second half",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("follow another run");
  });

  it("refuses a page number the document does not have", async () => {
    const bytes = await handWritten([{ streams: [block(40, 200, "(Only page) Tj")] }]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(4, { x: 40, y: 200 }, boxOf({ streams: [] }), "Only page"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("this document has 1 of them");
  });

  it("refuses a target with no measurements rather than working with NaN", async () => {
    const bytes = await handWritten([{ streams: [block(40, 200, "(Anything) Tj")] }]);

    const outcome = await exciseTextRun(bytes, {
      page: 0,
      rect: { x: Number.NaN, y: 100, width: 40, height: 12 },
      baseline: 12,
      text: "Anything",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("not a measurement");
  });

  it("refuses bytes that are not a PDF instead of throwing at the caller", async () => {
    const outcome = await exciseTextRun(new TextEncoder().encode("this is not a pdf"), {
      page: 0,
      rect: { x: 10, y: 10, width: 40, height: 12 },
      baseline: 12,
      text: "Anything",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("not a PDF");
  });

  it("refuses a page with nothing printed on it at all", async () => {
    // A page pdf-lib never drew on has no content stream, so this stops at the
    // first check of all: the page does not say what the caller thinks.
    const doc = await blankPdf();
    doc.addPage([400, 300]);
    const bytes = await savePdf(doc);

    const outcome = await exciseTextRun(bytes, {
      page: 0,
      rect: { x: 40, y: 100, width: 40, height: 12 },
      baseline: 12,
      text: "Anything",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("does not say");
  });

  it("refuses a content stream it cannot make sense of", async () => {
    const bytes = await handWritten([
      { streams: [block(40, 200, "(Good line) Tj") + "(unclosed string Tj\n"] },
    ]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Good line"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("never closed");
  });

  it("refuses text that lives inside a form XObject, which is a limit it admits to", async () => {
    const doc = await blankPdf();
    const { StandardFonts, PDFName } = await pdfLib();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);

    const form = doc.context.stream("BT /F1 12 Tf 1 0 0 1 40 200 Tm (Inside a form) Tj ET\n", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 400, 300],
      Resources: doc.context.obj({ Font: { F1: font.ref } }),
    });
    page.node.setXObject(PDFName.of("X0"), doc.context.register(form));
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q\n/X0 Do\nQ\n")));
    const bytes = await savePdf(doc);

    // pdf.js reads straight through the form and reports the words, so the
    // caller has every reason to point at them. This file only reads the page's
    // own stream, so it says no rather than pretending it looked.
    expect(await stringsOn(bytes, 0)).toEqual(["Inside a form"]);

    const outcome = await exciseTextRun(
      bytes,
      targetAt(0, { x: 40, y: 200 }, boxOf({ streams: [] }), "Inside a form"),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("this page's own stream");
  });
});
