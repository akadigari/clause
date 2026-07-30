import { describe, expect, it } from "vitest";

import {
  COVER_NOT_REMOVED,
  measureFit,
  replaceText,
  suggestFontSize,
  type TextEdit,
} from "./edit";
import { blankPdf, loadPdf, pdfLib, PdfOpError, savePdf, type PDFFont } from "./common";
import { groupIntoLines } from "../textblocks";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Spec = { width: number; height: number; rotation: number; origin?: [number, number] };

/** Build a document from a list of page specs, so rotation cases stay explicit. */
async function makeDoc(specs: Spec[]): Promise<Uint8Array> {
  const { degrees } = await pdfLib();
  const doc = await blankPdf();
  for (const spec of specs) {
    const page = doc.addPage([spec.width, spec.height]);
    const [ox, oy] = spec.origin ?? [0, 0];
    if (ox !== 0 || oy !== 0) {
      page.setMediaBox(ox, oy, spec.width, spec.height);
    }
    if (spec.rotation !== 0) page.setRotation(degrees(spec.rotation));
  }
  return savePdf(doc);
}

/** The same font the module reaches for by default, to measure against. */
async function helvetica(): Promise<PDFFont> {
  const { StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  return doc.embedFont(StandardFonts.Helvetica);
}

// ---------------------------------------------------------------------------
// Reading back what was actually drawn
// ---------------------------------------------------------------------------

/**
 * The page's content stream as text.
 *
 * Asserting on the operators is the only way to prove a cover landed on the
 * right coordinate. Reloading and checking the page count would pass even if
 * every rectangle went to the wrong corner.
 */
async function pageOps(bytes: Uint8Array, index: number): Promise<string> {
  const lib = await pdfLib();
  const doc = await loadPdf(bytes);
  const page = doc.getPage(index);
  const contents = page.node.Contents();

  const parts: string[] = [];
  const take = (obj: unknown) => {
    if (obj instanceof lib.PDFRawStream) {
      const raw = lib.decodePDFRawStream(obj).decode();
      let out = "";
      for (let i = 0; i < raw.length; i += 4096) {
        out += String.fromCharCode(...raw.subarray(i, i + 4096));
      }
      parts.push(out);
    }
  };

  if (contents instanceof lib.PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      take(doc.context.lookup(contents.get(i)));
    }
  } else if (contents) {
    take(contents);
  }
  return parts.join("\n");
}

const NUM = "(-?[\\d.]+(?:e[-+]?\\d+)?)";

type Matrix = [number, number, number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };

function matchCm(line: string): Matrix | null {
  const m = new RegExp(`^${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm$`).exec(line);
  if (!m) return null;
  return [1, 2, 3, 4, 5, 6].map((i) => Number(m[i])) as Matrix;
}

/**
 * A point in the local space of a path, pushed out to user space.
 *
 * `cm` concatenates onto the left of the current matrix, so the LAST one
 * written is the first one a point goes through. Walking the list backwards is
 * what makes this agree with the file rather than with the order the code
 * happened to emit.
 */
function toUser(point: { x: number; y: number }, chain: Matrix[]): { x: number; y: number } {
  let { x, y } = point;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const m = chain[i];
    if (!m) continue;
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    x = nx;
    y = ny;
  }
  return { x, y };
}

/**
 * Every filled path in the stream, as a user space box.
 *
 * Built from the path operators rather than from a fixed op sequence, so it
 * still reports the truth if pdf-lib reorders what it writes.
 */
function filledBoxes(ops: string): Box[] {
  const lines = ops.split(/\r?\n/).map((line) => line.trim());
  const stack: Matrix[][] = [[]];
  let path: Array<{ x: number; y: number }> = [];
  const out: Box[] = [];

  const finish = () => {
    if (path.length === 0) return;
    const xs = path.map((p) => p.x);
    const ys = path.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    out.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    path = [];
  };

  for (const line of lines) {
    if (line === "q") {
      stack.push([...(stack[stack.length - 1] ?? [])]);
      continue;
    }
    if (line === "Q") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const cm = matchCm(line);
    if (cm) {
      stack[stack.length - 1]?.push(cm);
      continue;
    }
    const point = new RegExp(`^${NUM} ${NUM} (m|l)$`).exec(line);
    if (point) {
      path.push(
        toUser({ x: Number(point[1]), y: Number(point[2]) }, stack[stack.length - 1] ?? []),
      );
      continue;
    }
    if (line === "f" || line === "f*" || line === "B" || line === "b") finish();
    if (line === "S" || line === "n") path = [];
  }
  return out;
}

/** Every `a b c d e f Tm` in a content stream. */
function textMatrices(ops: string): number[][] {
  const re = new RegExp(`${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} Tm`, "g");
  const out: number[][] = [];
  for (const m of ops.matchAll(re)) {
    out.push([1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  }
  return out;
}

/** Every font size set with `/Name size Tf`. The name carries a random suffix. */
function fontSizes(ops: string): number[] {
  const out: number[] = [];
  for (const m of ops.matchAll(new RegExp(`/\\S+ ${NUM} Tf`, "g"))) {
    out.push(Number(m[1]));
  }
  return out;
}

/** Every string shown by a `<hex> Tj`, decoded back from WinAnsi. */
function shownText(ops: string): string[] {
  const out: string[] = [];
  for (const m of ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
    const hex = m[1] ?? "";
    let s = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    out.push(s);
  }
  return out;
}

/** Every `r g b rg` fill colour, in the order it was set. */
function fillColours(ops: string): number[][] {
  const out: number[][] = [];
  for (const m of ops.matchAll(new RegExp(`${NUM} ${NUM} ${NUM} rg`, "g"))) {
    out.push([1, 2, 3].map((i) => Number(m[i])));
  }
  return out;
}

function expectBox(actual: Box | undefined, expected: Box): void {
  expect(actual).toBeDefined();
  if (!actual) return;
  expect(actual.x).toBeCloseTo(expected.x, 3);
  expect(actual.y).toBeCloseTo(expected.y, 3);
  expect(actual.width).toBeCloseTo(expected.width, 3);
  expect(actual.height).toBeCloseTo(expected.height, 3);
}

/** The run every placement test uses, so the arithmetic is checkable by hand. */
const RUN = { x: 100, y: 50, width: 80, height: 12 };

// ---------------------------------------------------------------------------
// Where the cover lands
// ---------------------------------------------------------------------------

describe("the cover rectangle", () => {
  /**
   * Every number below is worked out by hand from a 400 by 600 page and a run
   * at view (100, 50) that is 80 by 12, grown by half a point on each side to
   * (99.5, 49.5) by 81 by 13. Deriving them from geometry.ts instead would
   * only prove this file calls that file.
   */
  const cases: Array<{ rotation: number; want: Box }> = [
    { rotation: 0, want: { x: 99.5, y: 537.5, width: 81, height: 13 } },
    { rotation: 90, want: { x: 49.5, y: 99.5, width: 13, height: 81 } },
    { rotation: 180, want: { x: 219.5, y: 49.5, width: 81, height: 13 } },
    { rotation: 270, want: { x: 337.5, y: 419.5, width: 13, height: 81 } },
  ];

  for (const { rotation, want } of cases) {
    it(`lands on the right words at /Rotate ${rotation}`, async () => {
      const bytes = await makeDoc([{ width: 400, height: 600, rotation }]);
      const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

      const boxes = filledBoxes(await pageOps(out.bytes, 0));
      expect(boxes).toHaveLength(1);
      expectBox(boxes[0], want);
    });
  }

  it("lands on the right words at /Rotate 270 with an offset MediaBox", async () => {
    // Worked by hand. viewToUser at 270 is ux = W - vy, uy = H - vx, then the
    // MediaBox origin is added. The grown box is (99.5, 49.5) to (180.5, 62.5).
    //   corner a: ux = 400 - 49.5 = 350.5, uy = 600 - 99.5 = 500.5  -> +(12,-30) = (362.5, 470.5)
    //   corner b: ux = 400 - 62.5 = 337.5, uy = 600 - 180.5 = 419.5 -> +(12,-30) = (349.5, 389.5)
    // so the cover is (349.5, 389.5) by 13 wide and 81 tall.
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 270, origin: [12, -30] },
    ]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

    const ops = await pageOps(out.bytes, 0);
    const boxes = filledBoxes(ops);
    expect(boxes).toHaveLength(1);
    expectBox(boxes[0], { x: 349.5, y: 389.5, width: 13, height: 81 });

    // The baseline is view (100, 62): ux = 400 - 62 = 338, uy = 600 - 100 = 500,
    // plus the origin, so (350, 470). Half a point in from the cover's low edge,
    // which is COVER_PAD, and the ascenders point along user +x toward its high
    // edge at 362.5.
    const [tm] = textMatrices(ops);
    expect(tm?.[0]).toBeCloseTo(0, 6);
    expect(tm?.[1]).toBeCloseTo(-1, 6);
    expect(tm?.[4]).toBeCloseTo(350, 3);
    expect(tm?.[5]).toBeCloseTo(470, 3);
  });

  it("follows a MediaBox that does not start at the origin", async () => {
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 0, origin: [20, 30] },
    ]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

    const boxes = filledBoxes(await pageOps(out.bytes, 0));
    expect(boxes).toHaveLength(1);
    // The rotate 0 case shifted by the box origin: 99.5 + 20, 537.5 + 30.
    expectBox(boxes[0], { x: 119.5, y: 567.5, width: 81, height: 13 });
  });

  it("is white unless the caller sampled a colour", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);

    const plain = await replaceText(bytes, [{ page: 0, rect: RUN, text: "" }]);
    expect(fillColours(await pageOps(plain.bytes, 0))[0]).toEqual([1, 1, 1]);

    const sampled = await replaceText(bytes, [
      { page: 0, rect: RUN, text: "", background: "#f00" },
    ]);
    expect(fillColours(await pageOps(sampled.bytes, 0))[0]).toEqual([1, 0, 0]);
  });

  it("refuses a colour that is not a colour", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    await expect(
      replaceText(bytes, [{ page: 0, rect: RUN, text: "x", background: "beige" }]),
    ).rejects.toBeInstanceOf(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Where the replacement sits
// ---------------------------------------------------------------------------

describe("the replacement text", () => {
  it("sits on the baseline the old words sat on", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

    const ops = await pageOps(out.bytes, 0);
    expect(shownText(ops)).toEqual(["Smith"]);

    // The run's box runs from view y 50 down to 62, so the baseline is 62,
    // which is 600 - 62 = 538 up from the bottom in user space.
    const [tm] = textMatrices(ops);
    expect(tm).toBeDefined();
    expect(tm?.[4]).toBeCloseTo(100, 3);
    expect(tm?.[5]).toBeCloseTo(538, 3);
  });

  it("keeps that baseline when the MediaBox is offset", async () => {
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 0, origin: [20, 30] },
    ]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

    const [tm] = textMatrices(await pageOps(out.bytes, 0));
    expect(tm?.[4]).toBeCloseTo(120, 3);
    expect(tm?.[5]).toBeCloseTo(568, 3);
  });

  it("turns to match the page on all four rotations", async () => {
    const want = [
      { rotation: 0, x: 100, y: 538, a: 1, b: 0 },
      { rotation: 90, x: 62, y: 100, a: 0, b: 1 },
      { rotation: 180, x: 300, y: 62, a: -1, b: 0 },
      { rotation: 270, x: 338, y: 500, a: 0, b: -1 },
    ];

    for (const one of want) {
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: one.rotation }]);
      const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);
      const [tm] = textMatrices(await pageOps(out.bytes, 0));

      expect(tm).toBeDefined();
      expect(tm?.[0]).toBeCloseTo(one.a, 6);
      expect(tm?.[1]).toBeCloseTo(one.b, 6);
      expect(tm?.[4]).toBeCloseTo(one.x, 3);
      expect(tm?.[5]).toBeCloseTo(one.y, 3);
    }
  });

  it("takes its size from the run unless told otherwise", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);

    const fromRun = await replaceText(bytes, [{ page: 0, rect: RUN, text: "ok" }]);
    expect(fontSizes(await pageOps(fromRun.bytes, 0))).toEqual([12]);

    const asked = await replaceText(bytes, [
      { page: 0, rect: RUN, text: "ok", fontSize: 9 },
    ]);
    expect(fontSizes(await pageOps(asked.bytes, 0))).toEqual([9]);
  });

  it("draws in the colour asked for, black by default", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);

    const plain = await replaceText(bytes, [{ page: 0, rect: RUN, text: "ok" }]);
    // First fill is the cover, second is the ink.
    expect(fillColours(await pageOps(plain.bytes, 0))[1]).toEqual([0, 0, 0]);

    const blue = await replaceText(bytes, [
      { page: 0, rect: RUN, text: "ok", color: "#0000ff" },
    ]);
    expect(fillColours(await pageOps(blue.bytes, 0))[1]).toEqual([0, 0, 1]);
  });

  it("carries the run's horizontal squeeze onto the new words", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);

    const squeezed = await replaceText(bytes, [
      { page: 0, rect: RUN, text: "ok", squeeze: 0.8 },
    ]);
    expect(await pageOps(squeezed.bytes, 0)).toMatch(/\b80 Tz\b/);

    const plain = await replaceText(bytes, [{ page: 0, rect: RUN, text: "ok" }]);
    expect(await pageOps(plain.bytes, 0)).not.toMatch(/Tz/);
  });

  /**
   * The box the editor actually hands over is a line from textblocks.ts, not a
   * raw run, and the two do not agree about their own bottom edge. A line box
   * is padded to 1.22 font sizes so it covers descenders, so its bottom is a
   * fifth of a line BELOW the baseline. Taking the bottom as the baseline drops
   * the new words 2.64pt on 12pt text and sizes them at 14.64pt.
   */
  describe("a line box from textblocks, which is what the editor gives it", () => {
    const line = groupIntoLines([
      {
        str: "Jane Smith",
        x: 100,
        y: 50,
        width: 60,
        height: 12,
        fontSize: 12,
        squeeze: 1,
        hasEOL: false,
        start: 0,
        end: 10,
      },
    ])[0];

    it("is padded past the baseline, which is the whole reason baseline exists", () => {
      expect(line).toBeDefined();
      expect(line?.height).toBeCloseTo(14.64, 6);
      expect(line?.baseline).toBeCloseTo(12, 6);
      expect(line?.y).toBeCloseTo(50, 6);
    });

    it("puts the new words on the old baseline, not on the bottom of the box", async () => {
      expect(line).toBeDefined();
      if (!line) return;
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
      const out = await replaceText(bytes, [
        {
          page: 0,
          rect: { x: line.x, y: line.y, width: line.width, height: line.height },
          baseline: line.baseline,
          text: "John Smith",
        },
      ]);

      const ops = await pageOps(out.bytes, 0);
      // Baseline at view y 50 + 12 = 62, so 600 - 62 = 538 up from the bottom.
      // Without the baseline field it would be 600 - 64.64 = 535.36.
      const [tm] = textMatrices(ops);
      expect(tm?.[5]).toBeCloseTo(538, 3);
      // And the cover still reaches down past the baseline to catch descenders.
      expectBox(filledBoxes(ops)[0], {
        x: 99.5,
        y: 600 - 64.64 - 0.5,
        width: 61,
        height: 15.64,
      });
    });

    it("takes the old font size from the baseline, not from the padded height", async () => {
      expect(line).toBeDefined();
      if (!line) return;
      const rect = { x: line.x, y: line.y, width: line.width, height: line.height };
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);

      // Short enough that nothing shrinks, so the size on the page is the size
      // the module chose rather than the size that happened to fit.
      const withBaseline = await replaceText(bytes, [
        { page: 0, rect, baseline: line.baseline, text: "Jo" },
      ]);
      expect(fontSizes(await pageOps(withBaseline.bytes, 0))).toEqual([12]);

      // What it would have drawn without it: the padded height, 22% too big.
      const without = await replaceText(bytes, [{ page: 0, rect, text: "Jo" }]);
      expect(fontSizes(await pageOps(without.bytes, 0))).toEqual([14.64]);
    });

    it("still uses the bottom of the box when no baseline is given", async () => {
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
      const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);
      const [tm] = textMatrices(await pageOps(out.bytes, 0));
      expect(tm?.[5]).toBeCloseTo(538, 3);
    });

    it("falls back to the bottom of the box when the baseline is junk", async () => {
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
      const zero = await replaceText(bytes, [
        { page: 0, rect: RUN, text: "Smith", baseline: 0 },
      ]);
      expect(textMatrices(await pageOps(zero.bytes, 0))[0]?.[5]).toBeCloseTo(538, 3);

      await expect(
        replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith", baseline: Number.NaN }]),
      ).rejects.toBeInstanceOf(PdfOpError);
    });

    it("turns the corrected baseline with the page", async () => {
      const bytes = await makeDoc([{ width: 400, height: 600, rotation: 90 }]);
      const out = await replaceText(bytes, [
        { page: 0, rect: { ...RUN, height: 14.64 }, baseline: 12, text: "Smith" },
      ]);
      // Baseline is view (100, 62). At 90, ux = vy = 62 and uy = vx = 100.
      const [tm] = textMatrices(await pageOps(out.bytes, 0));
      expect(tm?.[4]).toBeCloseTo(62, 3);
      expect(tm?.[5]).toBeCloseTo(100, 3);
    });
  });

  it("keeps a pasted line break on the one line the run has", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [
      { page: 0, rect: { ...RUN, width: 300 }, text: "one\ntwo" },
    ]);
    expect(shownText(await pageOps(out.bytes, 0))).toEqual(["one two"]);
  });
});

// ---------------------------------------------------------------------------
// Text that is too long for the space it replaces
// ---------------------------------------------------------------------------

describe("text wider than the run it replaces", () => {
  it("shrinks it, warns, and the shrunk text really does fit", async () => {
    const font = await helvetica();
    const text = "Jane Smithson";
    const rect = { x: 100, y: 50, width: 60, height: 12 };
    expect(font.widthOfTextAtSize(text, 12)).toBeGreaterThan(rect.width);

    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect, text }]);

    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/Page 1/);
    expect(out.warnings[0]).toMatch(/Jane Smithson/);
    expect(out.warnings[0]).toMatch(/wider/);

    const [size] = fontSizes(await pageOps(out.bytes, 0));
    expect(size).toBeDefined();
    expect(size ?? 0).toBeLessThan(12);
    expect(size ?? 0).toBeGreaterThanOrEqual(12 * 0.6);
    expect(font.widthOfTextAtSize(text, size ?? 0)).toBeLessThanOrEqual(rect.width);
  });

  it("stops at 60% of the size and says so when even that is too wide", async () => {
    const font = await helvetica();
    const text = "This is far more text than ever fitted in that box";
    const rect = { x: 100, y: 50, width: 20, height: 12 };

    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect, text }]);

    expect(out.applied).toBe(1);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/smallest/);

    const [size] = fontSizes(await pageOps(out.bytes, 0));
    expect(size).toBeCloseTo(7.2, 2);
    // The point of the warning: it is still too wide, and it says by how much.
    expect(font.widthOfTextAtSize(text, size ?? 0)).toBeGreaterThan(rect.width);
  });

  it("says nothing when the replacement fits", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Jo" }]);
    expect(out.warnings).toEqual([]);
    expect(fontSizes(await pageOps(out.bytes, 0))).toEqual([12]);
  });

  it("counts the squeeze when deciding whether it fits", async () => {
    const font = await helvetica();
    const text = "Jane Smithson";
    // Wide enough for the plain text, too narrow once stretched by half again.
    const rect = { x: 100, y: 50, width: font.widthOfTextAtSize(text, 12) + 1, height: 12 };

    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const loose = await replaceText(bytes, [{ page: 0, rect, text }]);
    expect(loose.warnings).toEqual([]);

    const stretched = await replaceText(bytes, [
      { page: 0, rect, text, squeeze: 1.5 },
    ]);
    expect(stretched.warnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe("several edits at once", () => {
  it("applies every one, on every page, in one pass", async () => {
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 0 },
      { width: 400, height: 600, rotation: 0 },
      { width: 400, height: 600, rotation: 90 },
    ]);

    const edits: TextEdit[] = [
      { page: 2, rect: RUN, text: "third" },
      { page: 0, rect: RUN, text: "first" },
      { page: 0, rect: { ...RUN, y: 200 }, text: "second" },
    ];
    const out = await replaceText(bytes, edits);

    expect(out.applied).toBe(3);
    expect(out.warnings).toEqual([]);

    const first = await pageOps(out.bytes, 0);
    expect(filledBoxes(first)).toHaveLength(2);
    expect(shownText(first).sort()).toEqual(["first", "second"]);

    const untouched = await pageOps(out.bytes, 1);
    expect(filledBoxes(untouched)).toHaveLength(0);
    expect(shownText(untouched)).toEqual([]);

    const third = await pageOps(out.bytes, 2);
    expect(filledBoxes(third)).toHaveLength(1);
    expect(shownText(third)).toEqual(["third"]);

    const reopened = await loadPdf(out.bytes);
    expect(reopened.getPageCount()).toBe(3);
  });

  it("reports progress once per edit", async () => {
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 0 },
      { width: 400, height: 600, rotation: 0 },
    ]);
    const seen: Array<[number, number]> = [];
    await replaceText(
      bytes,
      [
        { page: 0, rect: RUN, text: "a" },
        { page: 1, rect: RUN, text: "b" },
      ],
      (done, total) => seen.push([done, total]),
    );
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("changes nothing at all when one edit names a page that is not there", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    let caught: unknown;
    try {
      await replaceText(bytes, [
        { page: 0, rect: RUN, text: "fine" },
        { page: 7, rect: RUN, text: "nowhere" },
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfOpError);
    expect((caught as PdfOpError).message).toMatch(/Page 8/);
  });

  it("refuses an empty list rather than handing back an untouched file", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    await expect(replaceText(bytes, [])).rejects.toBeInstanceOf(PdfOpError);
  });

  it("skips a run with no size and says which page it was on", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [
      { page: 0, rect: { x: 10, y: 10, width: 0, height: 12 }, text: "nope" },
      { page: 0, rect: RUN, text: "yes" },
    ]);
    expect(out.applied).toBe(1);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/Page 1/);
    expect(shownText(await pageOps(out.bytes, 0))).toEqual(["yes"]);
  });
});

// ---------------------------------------------------------------------------
// Erasing
// ---------------------------------------------------------------------------

describe("an empty replacement", () => {
  it("covers the words and draws nothing", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "" }]);

    expect(out.applied).toBe(1);
    expect(out.warnings).toEqual([]);

    const ops = await pageOps(out.bytes, 0);
    expect(filledBoxes(ops)).toHaveLength(1);
    expect(shownText(ops)).toEqual([]);
    expect(ops).not.toMatch(/BT/);
  });

  it("erases whitespace the same way, since there is nothing to draw", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "\n" }]);
    // A lone break folds to a space, which is a real character and still drawn.
    expect(shownText(await pageOps(out.bytes, 0))).toEqual([" "]);
  });
});

// ---------------------------------------------------------------------------
// Text the built-in fonts cannot draw
// ---------------------------------------------------------------------------

describe("non-Latin text", () => {
  it("raises a PdfOpError that says why, not a raw pdf-lib error", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    let caught: unknown;
    try {
      await replaceText(bytes, [{ page: 0, rect: RUN, text: "合同" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfOpError);
    const err = caught as PdfOpError;
    expect(err.message).not.toMatch(/WinAnsi/);
    expect(`${err.message} ${err.hint ?? ""}`).toMatch(/Western European|Latin/);
  });

  it("still allows the accented Latin the built-ins do cover", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await replaceText(bytes, [
      { page: 0, rect: { ...RUN, width: 200 }, text: "Amélie Müller" },
    ]);
    expect(shownText(await pageOps(out.bytes, 0))).toEqual(["Amélie Müller"]);
  });
});

// ---------------------------------------------------------------------------
// What this does not do
// ---------------------------------------------------------------------------

/**
 * These pin the promise the module header makes, so nobody can quietly turn
 * this into a redaction tool by deleting a comment. The failure they guard
 * against is somebody changing a salary or an address here and believing the
 * old value left the file.
 */
describe("covering is not removing", () => {
  async function withRealText(): Promise<Uint8Array> {
    const { StandardFonts } = await pdfLib();
    const doc = await blankPdf();
    const page = doc.addPage([400, 600]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Drawn at user y 538, which is where a run at view (100, 50) 80 by 12 sits.
    page.drawText("Salary: 250000 USD", { x: 100, y: 538, size: 12, font });
    return savePdf(doc);
  }

  it("leaves the old words in the file, still readable by anything", async () => {
    const bytes = await withRealText();
    const out = await replaceText(bytes, [
      { page: 0, rect: { ...RUN, width: 120 }, text: "Salary: withheld" },
    ]);

    const shown = shownText(await pageOps(out.bytes, 0));
    expect(shown).toContain("Salary: withheld");
    // The point of the test. If this ever stops being true, the module header,
    // COVER_NOT_REMOVED and whatever the UI says all have to change with it.
    expect(shown).toContain("Salary: 250000 USD");
  });

  it("does not remove them when the replacement is empty either", async () => {
    const bytes = await withRealText();
    const out = await replaceText(bytes, [{ page: 0, rect: { ...RUN, width: 120 }, text: "" }]);
    expect(shownText(await pageOps(out.bytes, 0))).toEqual(["Salary: 250000 USD"]);
  });

  it("ships one sentence saying so, in words that do not claim removal", () => {
    expect(COVER_NOT_REMOVED).toMatch(/still/i);
    expect(COVER_NOT_REMOVED).toMatch(/Redact/);
    // No word here may tell somebody the text is gone.
    expect(COVER_NOT_REMOVED).not.toMatch(/\b(removes?|removed|deletes?|deleted|erases?|erased)\b/i);
  });
});

// ---------------------------------------------------------------------------
// The caller's bytes
// ---------------------------------------------------------------------------

describe("the input", () => {
  it("is never mutated", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const before = bytes.slice();

    const out = await replaceText(bytes, [{ page: 0, rect: RUN, text: "Smith" }]);

    expect(Array.from(bytes)).toEqual(Array.from(before));
    expect(out.bytes).not.toBe(bytes);
    expect(shownText(await pageOps(bytes, 0))).toEqual([]);
  });

  it("has to be a PDF", async () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(
      replaceText(junk, [{ page: 0, rect: RUN, text: "x" }]),
    ).rejects.toBeInstanceOf(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// The pure fitting helpers
// ---------------------------------------------------------------------------

describe("measureFit", () => {
  // Half an em per character, which makes every expected width arithmetic.
  const half = () => 0.5;

  it("says yes with no overflow when the text fits", () => {
    const fit = measureFit("abcd", { x: 0, y: 0, width: 40, height: 12 }, 10, half);
    expect(fit.fits).toBe(true);
    expect(fit.overflowPoints).toBe(0);
  });

  it("says no and by how many points when it does not", () => {
    const fit = measureFit("abcd", { x: 0, y: 0, width: 15, height: 12 }, 10, half);
    expect(fit.fits).toBe(false);
    expect(fit.overflowPoints).toBeCloseTo(5, 6);
  });

  it("scales with the font size, since widths are per em", () => {
    const rect = { x: 0, y: 0, width: 20, height: 12 };
    expect(measureFit("abcd", rect, 10, half).fits).toBe(true);
    expect(measureFit("abcd", rect, 20, half).fits).toBe(false);
  });

  it("treats an empty replacement as fitting anywhere", () => {
    const fit = measureFit("", { x: 0, y: 0, width: 0, height: 12 }, 10, half);
    expect(fit.fits).toBe(true);
  });

  it("ignores a character the measure cannot size rather than throwing", () => {
    const fit = measureFit("ab", { x: 0, y: 0, width: 10, height: 12 }, 10, (c) =>
      c === "a" ? Number.NaN : 0.5,
    );
    expect(fit.fits).toBe(true);
    expect(fit.overflowPoints).toBe(0);
  });
});

describe("suggestFontSize", () => {
  // Same half em rule, so a string of n characters is n * 0.5 * size wide.
  const measure = (t: string, size: number) => t.length * 0.5 * size;

  it("leaves the size alone when the text already fits", () => {
    expect(suggestFontSize("abcd", { x: 0, y: 0, width: 40, height: 12 }, 12, measure)).toBe(
      12,
    );
  });

  it("shrinks to the largest size that fits", () => {
    const size = suggestFontSize("abcd", { x: 0, y: 0, width: 20, height: 12 }, 12, measure);
    expect(size).toBeLessThanOrEqual(10);
    expect(size).toBeGreaterThan(9.9);
    expect(measure("abcd", size)).toBeLessThanOrEqual(20);
  });

  it("stops at 60% of where it started, however long the text is", () => {
    const long = "x".repeat(200);
    const size = suggestFontSize(long, { x: 0, y: 0, width: 20, height: 12 }, 12, measure);
    expect(size).toBeCloseTo(7.2, 2);
  });

  it("has nothing to do with no text and no room", () => {
    expect(suggestFontSize("", { x: 0, y: 0, width: 20, height: 12 }, 12, measure)).toBe(12);
    expect(suggestFontSize("abcd", { x: 0, y: 0, width: 0, height: 12 }, 12, measure)).toBe(
      12,
    );
  });
});
