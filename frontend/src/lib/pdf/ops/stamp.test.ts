import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { addPageNumbers, addWatermark, stampImage, stampText } from "./stamp";
import { blankPdf, loadPdf, pdfLib, PdfOpError, savePdf } from "./common";

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

// ---------------------------------------------------------------------------
// Reading back what was actually drawn
// ---------------------------------------------------------------------------

/**
 * The page's content stream as text.
 *
 * Asserting on the operators is the only way to prove a stamp landed on the
 * right coordinate. Reloading and looking at page counts would pass even if
 * every mark went to the wrong corner.
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

/** Every `a b c d e f Tm` in a content stream. */
function textMatrices(ops: string): number[][] {
  const re = new RegExp(`${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} Tm`, "g");
  const out: number[][] = [];
  for (const m of ops.matchAll(re)) {
    out.push([1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  }
  return out;
}

/** Every `a b c d e f cm` in a content stream. */
function matrices(ops: string): number[][] {
  const re = new RegExp(`${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM} cm`, "g");
  const out: number[][] = [];
  for (const m of ops.matchAll(re)) {
    out.push([1, 2, 3, 4, 5, 6].map((i) => Number(m[i])));
  }
  return out;
}

/** The `r g b rg` fill colour, which is how a hex string is checked from outside. */
function fillColour(ops: string): number[] {
  const m = new RegExp(`${NUM} ${NUM} ${NUM} rg`).exec(ops);
  if (!m) return [];
  return [1, 2, 3].map((i) => Number(m[i]));
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

// ---------------------------------------------------------------------------
// A real PNG, built here so the test needs no asset on disk
// ---------------------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i] ?? 0;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A solid colour RGB PNG, 8 bits per channel, no interlace. */
function makePng(width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 is truecolour RGB

  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 3;
      raw[at] = 200;
      raw[at + 1] = 30;
      raw[at + 2] = 60;
    }
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * JPEG headers only, no picture.
 *
 * pdf-lib reads the size out of the SOF0 marker and copies the rest of the
 * bytes straight through without decoding, so this is enough to prove the
 * sniffer picked the JPEG path. It is not enough to prove a real photo renders.
 */
function makeFakeJpeg(width: number, height: number): Uint8Array {
  const out = new Uint8Array(24);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xffd8); // SOI
  view.setUint16(2, 0xffc0); // SOF0
  view.setUint16(4, 17); // segment length
  out[6] = 8; // bits per component
  view.setUint16(7, height);
  view.setUint16(9, width);
  out[11] = 3; // three channels, so DeviceRGB
  view.setUint16(22, 0xffd9); // EOI
  return out;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

describe("hex colours", () => {
  const onePage = () => makeDoc([{ width: 400, height: 600, rotation: 0 }]);

  async function drawnColour(color: string): Promise<number[]> {
    const out = await stampText(await onePage(), { pages: [0], text: "hi", color });
    return fillColour(await pageOps(out, 0));
  }

  it("reads six digit hex", async () => {
    expect(await drawnColour("#ff0000")).toEqual([1, 0, 0]);
    expect(await drawnColour("#000000")).toEqual([0, 0, 0]);
    const half = await drawnColour("#808080");
    expect(half[0]).toBeCloseTo(128 / 255, 6);
    expect(half[2]).toBeCloseTo(128 / 255, 6);
  });

  it("doubles each digit of three digit hex", async () => {
    // Compared against the literal channels, not against the six digit form.
    // Two calls to the same broken function agree with each other, so that
    // comparison alone still passes on a function that draws nothing at all.
    expect(await drawnColour("#f00")).toEqual([1, 0, 0]);
    expect(await drawnColour("#f00")).toEqual(await drawnColour("#ff0000"));
    const g = await drawnColour("#0a3");
    expect(g[0]).toBeCloseTo(0, 6);
    expect(g[1]).toBeCloseTo(170 / 255, 6);
    expect(g[2]).toBeCloseTo(51 / 255, 6);
    expect(g).toEqual(await drawnColour("#00aa33"));
  });

  it("takes hex with or without the hash, and ignores stray spaces", async () => {
    expect(await drawnColour(" 00ff00 ")).toEqual([0, 1, 0]);
  });

  for (const bad of ["", "red", "#12345", "#gg0000", "#ff00000", "0x00ff00", "#"]) {
    it(`refuses ${JSON.stringify(bad)} with a PdfOpError`, async () => {
      await expect(
        stampText(await onePage(), { pages: [0], text: "hi", color: bad }),
      ).rejects.toThrow(PdfOpError);
    });
  }

  it("refuses it in watermarks and page numbers too", async () => {
    const bytes = await onePage();
    await expect(addWatermark(bytes, { text: "DRAFT", color: "#12345" })).rejects.toThrow(
      PdfOpError,
    );
    await expect(addPageNumbers(bytes, { color: "nope" })).rejects.toThrow(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Placement across all four page rotations
// ---------------------------------------------------------------------------

/**
 * Helvetica's own metrics, checked here so the hand worked numbers below have
 * something to stand on. Ascender 718, Descender -207, per the AFM.
 */
describe("font metrics this test leans on", () => {
  it("puts Helvetica's baseline 8.616pt below the top of a 12pt line", async () => {
    const { StandardFonts } = await pdfLib();
    const doc = await blankPdf();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(font.heightAtSize(12, { descender: false })).toBeCloseTo(8.616, 6);
    expect(font.heightAtSize(12)).toBeCloseTo(11.1, 6);
  });
});

describe("a stamp lands where it was dropped, on every page rotation", () => {
  // A page that is 400 x 600 with its MediaBox pushed off the origin, which is
  // the pair of traps that puts stamps in the wrong corner.
  const W = 400;
  const H = 600;
  const OX = 20;
  const OY = 30;
  const VX = 100;
  const VY = 50;
  const ASCENT = 8.616; // Helvetica at 12pt
  const BY = VY + ASCENT; // the baseline, in view space

  // Worked out by hand from the PDF display rules, not by calling geometry.ts.
  //   rotate 0    user = (vx,        H - vy)
  //   rotate 90   user = (vy,        vx)
  //   rotate 180  user = (W - vx,    vy)
  //   rotate 270  user = (W - vy,    H - vx)
  // then shifted by the MediaBox origin.
  const cases = [
    { rotation: 0, x: VX + OX, y: H - BY + OY, cos: 1, sin: 0 },
    { rotation: 90, x: BY + OX, y: VX + OY, cos: 0, sin: 1 },
    { rotation: 180, x: W - VX + OX, y: BY + OY, cos: -1, sin: 0 },
    { rotation: 270, x: W - BY + OX, y: H - VX + OY, cos: 0, sin: -1 },
  ];

  for (const c of cases) {
    it(`lands at the right user point with /Rotate ${c.rotation}`, async () => {
      const bytes = await makeDoc([
        { width: W, height: H, rotation: c.rotation, origin: [OX, OY] },
      ]);
      const out = await stampText(bytes, {
        pages: [0],
        text: "Anchor",
        x: VX,
        y: VY,
        size: 12,
      });

      const tms = textMatrices(await pageOps(out, 0));
      expect(tms).toHaveLength(1);
      const tm = tms[0] ?? [];
      expect(tm[4]).toBeCloseTo(c.x, 3);
      expect(tm[5]).toBeCloseTo(c.y, 3);
    });

    it(`turns the text to stay upright with /Rotate ${c.rotation}`, async () => {
      const bytes = await makeDoc([
        { width: W, height: H, rotation: c.rotation, origin: [OX, OY] },
      ]);
      const out = await stampText(bytes, { pages: [0], text: "Anchor", x: VX, y: VY, size: 12 });

      const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
      // [cos, sin, -sin, cos] for a turn that cancels the page's own turn.
      expect(tm[0]).toBeCloseTo(c.cos, 6);
      expect(tm[1]).toBeCloseTo(c.sin, 6);
      expect(tm[2]).toBeCloseTo(-c.sin, 6);
      expect(tm[3]).toBeCloseTo(c.cos, 6);
    });
  }

  it("keeps the page's own size and rotation untouched", async () => {
    const bytes = await makeDoc([{ width: W, height: H, rotation: 90, origin: [OX, OY] }]);
    const out = await stampText(bytes, { pages: [0], text: "Anchor", x: 10, y: 10 });
    const doc = await loadPdf(out);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getRotation().angle).toBe(90);
    const media = page.getMediaBox();
    expect([media.x, media.y, media.width, media.height]).toEqual([OX, OY, W, H]);
  });

  it("does not mutate the bytes it was given", async () => {
    const bytes = await makeDoc([{ width: 300, height: 300, rotation: 0 }]);
    const before = bytes.slice();
    await stampText(bytes, { pages: [0], text: "x" });
    expect(Array.from(bytes)).toEqual(Array.from(before));
  });
});

describe("anchors", () => {
  it("pins to a corner with a margin, in the size the reader sees", async () => {
    // A 400 x 600 page turned 90 reads as 600 wide and 400 tall, so a
    // bottom-right anchor has to use those numbers, not the stored ones.
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 90 }]);
    const out = await stampText(bytes, {
      pages: [0],
      text: "Anchor",
      anchor: "bottom-right",
      margin: 20,
      size: 12,
    });

    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    // View size is 600 x 400. Text height 11.1, so the box top is at
    // 400 - 11.1 - 20 = 368.9 and the baseline at 368.9 + 8.616 = 377.516.
    // With /Rotate 90 the user point is (baselineY, boxLeft).
    const { StandardFonts } = await pdfLib();
    const probe = await blankPdf();
    const font = await probe.embedFont(StandardFonts.Helvetica);
    const tw = font.widthOfTextAtSize("Anchor", 12);
    expect(tm[4]).toBeCloseTo(400 - 11.1 - 20 + 8.616, 3);
    expect(tm[5]).toBeCloseTo(600 - tw - 20, 3);
  });

  it("lets an explicit x or y beat the anchor, one axis at a time", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await stampText(bytes, {
      pages: [0],
      text: "Anchor",
      anchor: "bottom-right",
      margin: 20,
      x: 7,
      size: 12,
    });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    expect(tm[4]).toBeCloseTo(7, 3);
    // y still came from the anchor.
    expect(tm[5]).toBeCloseTo(600 - (600 - 11.1 - 20 + 8.616), 3);
  });

  it("refuses an anchor that is not a place on the page", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    await expect(
      stampText(bytes, { pages: [0], text: "x", anchor: "middle-ish" as never }),
    ).rejects.toThrow(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Non-Latin text
// ---------------------------------------------------------------------------

describe("text the built-in fonts cannot draw", () => {
  it("raises a PdfOpError that says why, not a raw pdf-lib error", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    let caught: unknown;
    try {
      await stampText(bytes, { pages: [0], text: "合同", x: 10, y: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PdfOpError);
    const err = caught as PdfOpError;
    expect(err.message).not.toMatch(/WinAnsi/);
    expect(`${err.message} ${err.hint ?? ""}`).toMatch(/Western European|Latin/);
  });

  it("catches it in watermarks and page numbers too", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    await expect(addWatermark(bytes, { text: "秘密" })).rejects.toBeInstanceOf(PdfOpError);
    await expect(
      addPageNumbers(bytes, { format: "第{n}页" }),
    ).rejects.toBeInstanceOf(PdfOpError);
  });

  it("still takes accented Western European text", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await stampText(bytes, { pages: [0], text: "Café Müller", x: 10, y: 10 });
    expect(shownText(await pageOps(out, 0))).toEqual(["Café Müller"]);
  });
});

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------

describe("page numbers", () => {
  const five = () =>
    makeDoc(Array.from({ length: 5 }, () => ({ width: 400, height: 600, rotation: 0 })));

  it("numbers every page by default, bottom centre", async () => {
    const out = await addPageNumbers(await five(), {});
    for (let i = 0; i < 5; i += 1) {
      expect(shownText(await pageOps(out, i))).toEqual([String(i + 1)]);
    }
  });

  it("fills {n} and {total}", async () => {
    const out = await addPageNumbers(await five(), { format: "Page {n} of {total}" });
    expect(shownText(await pageOps(out, 0))).toEqual(["Page 1 of 5"]);
    expect(shownText(await pageOps(out, 4))).toEqual(["Page 5 of 5"]);
  });

  it("only marks the pages it was given, and counts only those", async () => {
    const out = await addPageNumbers(await five(), {
      pages: [0, 2, 4],
      format: "{n}/{total}",
    });
    expect(shownText(await pageOps(out, 0))).toEqual(["1/3"]);
    expect(shownText(await pageOps(out, 1))).toEqual([]);
    expect(shownText(await pageOps(out, 2))).toEqual(["2/3"]);
    expect(shownText(await pageOps(out, 3))).toEqual([]);
    expect(shownText(await pageOps(out, 4))).toEqual(["3/3"]);
  });

  it("starts counting wherever it is told", async () => {
    const out = await addPageNumbers(await five(), { start: 7, format: "{n} of {total}" });
    expect(shownText(await pageOps(out, 0))).toEqual(["7 of 11"]);
    expect(shownText(await pageOps(out, 4))).toEqual(["11 of 11"]);
  });

  it("sits upright on a page that is turned", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 270, origin: [15, 25] }]);
    const out = await addPageNumbers(bytes, { anchor: "bottom-center", margin: 30, size: 10 });
    const ops = await pageOps(out, 0);
    expect(shownText(ops)).toEqual(["1"]);
    const tm = textMatrices(ops)[0] ?? [];
    expect(tm[0]).toBeCloseTo(0, 6);
    expect(tm[1]).toBeCloseTo(-1, 6);
    expect(tm[2]).toBeCloseTo(1, 6);
    expect(tm[3]).toBeCloseTo(0, 6);
  });

  it("handles a one page document", async () => {
    const bytes = await makeDoc([{ width: 200, height: 200, rotation: 0 }]);
    const out = await addPageNumbers(bytes, { format: "{n} of {total}" });
    expect(shownText(await pageOps(out, 0))).toEqual(["1 of 1"]);
    expect((await loadPdf(out)).getPageCount()).toBe(1);
  });

  it("refuses an empty selection and an out of range page", async () => {
    const bytes = await makeDoc([{ width: 200, height: 200, rotation: 0 }]);
    await expect(addPageNumbers(bytes, { pages: [] })).rejects.toThrow(PdfOpError);
    await expect(addPageNumbers(bytes, { pages: [4, -1] })).rejects.toThrow(PdfOpError);
    await expect(stampText(bytes, { pages: [9], text: "x" })).rejects.toThrow(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

describe("watermark", () => {
  it("goes on every page, turned and see through", async () => {
    const bytes = await makeDoc([
      { width: 400, height: 600, rotation: 0 },
      { width: 400, height: 600, rotation: 90 },
    ]);
    const out = await addWatermark(bytes, { text: "DRAFT", opacity: 0.2 });

    for (const i of [0, 1]) {
      const ops = await pageOps(out, i);
      expect(shownText(ops)).toEqual(["DRAFT"]);
      // 45 degrees on top of the page's own turn.
      const tm = textMatrices(ops)[0] ?? [];
      const angle = (Math.atan2(tm[1] ?? 0, tm[0] ?? 0) * 180) / Math.PI;
      expect(((angle % 360) + 360) % 360).toBeCloseTo(i === 0 ? 45 : 135, 4);
      // Opacity below 1 has to bring a graphics state with it.
      expect(ops).toMatch(/\/GS\S* gs/);
    }
  });

  it("skips the graphics state when it is fully opaque", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await addWatermark(bytes, { text: "FINAL", opacity: 1 });
    expect(await pageOps(out, 0)).not.toMatch(/gs\b/);
  });

  it("shrinks so a long word still fits the page", async () => {
    const bytes = await makeDoc([{ width: 200, height: 200, rotation: 0 }]);
    const out = await addWatermark(bytes, { text: "CONFIDENTIAL", size: 200, angle: 0 });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    // Starting x must still be inside the page rather than far off the left.
    expect(tm[4] ?? -1).toBeGreaterThanOrEqual(0);
    expect(tm[4] ?? 999).toBeLessThan(200);
  });

  it("takes a page list when it is given one", async () => {
    const bytes = await makeDoc([
      { width: 300, height: 300, rotation: 0 },
      { width: 300, height: 300, rotation: 0 },
    ]);
    const out = await addWatermark(bytes, { text: "COPY", pages: [1] });
    expect(shownText(await pageOps(out, 0))).toEqual([]);
    expect(shownText(await pageOps(out, 1))).toEqual(["COPY"]);
  });

  it("refuses empty text", async () => {
    const bytes = await makeDoc([{ width: 300, height: 300, rotation: 0 }]);
    await expect(addWatermark(bytes, { text: "   " })).rejects.toThrow(PdfOpError);
    await expect(stampText(bytes, { pages: [0], text: "" })).rejects.toThrow(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

describe("image stamps", () => {
  it("reads PNG off the bytes and puts it where it was dropped", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0, origin: [20, 30] }]);
    const out = await stampImage(bytes, {
      pages: [0],
      image: makePng(40, 20),
      x: 100,
      y: 50,
      width: 80,
      height: 40,
    });

    const cms = matrices(await pageOps(out, 0));
    // translate, rotate, scale. The first one carries the anchor point.
    expect(cms.length).toBeGreaterThanOrEqual(3);
    const move = cms[0] ?? [];
    // View top left (100, 50) with a height of 40 means a screen foot of
    // (100, 90), which on an unturned page is user (120, 600 - 90 + 30).
    expect(move[4]).toBeCloseTo(120, 3);
    expect(move[5]).toBeCloseTo(600 - 90 + 30, 3);
    const size = cms[2] ?? [];
    expect(size[0]).toBeCloseTo(80, 3);
    expect(size[3]).toBeCloseTo(40, 3);
  });

  it("keeps the shape when only one side is given", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const png = makePng(40, 20);

    const wide = await stampImage(bytes, { pages: [0], image: png, x: 0, y: 0, width: 100 });
    const wideScale = matrices(await pageOps(wide, 0))[2] ?? [];
    expect(wideScale[0]).toBeCloseTo(100, 3);
    expect(wideScale[3]).toBeCloseTo(50, 3);

    const tall = await stampImage(bytes, { pages: [0], image: png, x: 0, y: 0, height: 100 });
    const tallScale = matrices(await pageOps(tall, 0))[2] ?? [];
    expect(tallScale[0]).toBeCloseTo(200, 3);
    expect(tallScale[3]).toBeCloseTo(100, 3);
  });

  it("falls back to the image's own pixel size", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await stampImage(bytes, { pages: [0], image: makePng(40, 20), x: 0, y: 0 });
    const scale = matrices(await pageOps(out, 0))[2] ?? [];
    expect(scale[0]).toBeCloseTo(40, 3);
    expect(scale[3]).toBeCloseTo(20, 3);
  });

  it("turns with the page so a signature is not sideways", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 90 }]);
    const out = await stampImage(bytes, {
      pages: [0],
      image: makePng(10, 10),
      x: 10,
      y: 10,
      width: 50,
      height: 50,
    });
    const turn = matrices(await pageOps(out, 0))[1] ?? [];
    expect(turn[0]).toBeCloseTo(0, 6);
    expect(turn[1]).toBeCloseTo(1, 6);
  });

  it("picks the JPEG path from the magic bytes, whatever the caller called it", async () => {
    // Nothing says "this is a JPEG" here except the two leading bytes, and a
    // PNG decoder would have thrown instead of reporting 64 x 32.
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const out = await stampImage(bytes, {
      pages: [0],
      image: makeFakeJpeg(64, 32),
      x: 0,
      y: 0,
    });
    const doc = await loadPdf(out);
    const filters = doc.context
      .enumerateIndirectObjects()
      .map(([, obj]) => String(obj))
      .filter((s) => /\/Subtype\s*\/Image/.test(s));
    expect(filters.join(" ")).toMatch(/\/DCTDecode/);

    const ops = await pageOps(out, 0);
    const scale = matrices(ops)[2] ?? [];
    expect(scale[0]).toBeCloseTo(64, 3);
    expect(scale[3]).toBeCloseTo(32, 3);
  });

  it("refuses anything that is not a PNG or a JPEG", async () => {
    const bytes = await makeDoc([{ width: 400, height: 600, rotation: 0 }]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    await expect(stampImage(bytes, { pages: [0], image: gif, x: 0, y: 0 })).rejects.toThrow(
      PdfOpError,
    );
    await expect(
      stampImage(bytes, { pages: [0], image: new Uint8Array([1, 2, 3, 4]), x: 0, y: 0 }),
    ).rejects.toThrow(PdfOpError);
    await expect(
      stampImage(bytes, { pages: [0], image: new Uint8Array(0), x: 0, y: 0 }),
    ).rejects.toThrow(PdfOpError);
  });

  it("embeds the image once for many pages", async () => {
    const bytes = await makeDoc(
      Array.from({ length: 3 }, () => ({ width: 300, height: 300, rotation: 0 })),
    );
    const out = await stampImage(bytes, {
      pages: [0, 1, 2],
      image: makePng(8, 8),
      x: 5,
      y: 5,
      width: 20,
    });
    const doc = await loadPdf(out);
    const images = doc.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => /\/Subtype\s*\/Image/.test(String(obj)));
    expect(images).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What pdf-lib does to the string before it draws it
// ---------------------------------------------------------------------------

describe("the text measured is the text drawn", () => {
  const page400 = () => makeDoc([{ width: 400, height: 600, rotation: 0 }]);

  it("counts a Windows line break once, the way a person does", async () => {
    // pdf-lib splits on \n and on \r separately, so a raw \r\n reaches the
    // page as two breaks and leaves a blank line the layout never reserved.
    const out = await stampText(await page400(), {
      pages: [0],
      text: "one\r\ntwo",
      anchor: "bottom-left",
      margin: 10,
      size: 12,
    });
    expect(shownText(await pageOps(out, 0))).toEqual(["one", "two"]);
  });

  it("puts a CRLF block in the same place as the LF block it means", async () => {
    const bytes = await page400();
    const opts = { pages: [0], anchor: "bottom-left" as const, margin: 10, size: 12 };
    const lf = await stampText(bytes, { ...opts, text: "one\ntwo" });
    const crlf = await stampText(bytes, { ...opts, text: "one\r\ntwo" });
    const tm = textMatrices(await pageOps(crlf, 0));
    // Pinned to the worked number as well as to the LF run, because two calls
    // to a function that draws nothing also agree with each other.
    // Two lines of 11.1 sit 10 above the foot, so the first baseline is at
    // view 600 - 22.2 - 10 + 8.616 = 576.416, which is user 23.584.
    expect(tm).toHaveLength(1);
    expect(tm[0]?.[4]).toBeCloseTo(10, 3);
    expect(tm[0]?.[5]).toBeCloseTo(600 - (600 - 22.2 - 10 + 8.616), 3);
    expect(tm).toEqual(textMatrices(await pageOps(lf, 0)));
    expect(shownText(await pageOps(crlf, 0))).toEqual(["one", "two"]);
    expect(shownText(await pageOps(crlf, 0))).toEqual(shownText(await pageOps(lf, 0)));
  });

  it("draws a tab as spaces instead of calling it a foreign script", async () => {
    // pdf-lib turns a tab into four spaces before it draws. Measuring the raw
    // tab used to throw from the encoder and get reported as "the built-in
    // fonts cannot draw that", which blamed Chinese for an indented line.
    const out = await stampText(await page400(), {
      pages: [0],
      text: "a\tb",
      x: 10,
      y: 10,
    });
    expect(shownText(await pageOps(out, 0))).toEqual(["a    b"]);
  });

  it("takes the Unicode separators pdf-lib also turns into spaces", async () => {
    for (const code of [0x0085, 0x2028, 0x2029]) {
      const out = await stampText(await page400(), {
        pages: [0],
        text: `a${String.fromCharCode(code)}b`,
        x: 10,
        y: 10,
      });
      expect(shownText(await pageOps(out, 0))).toEqual(["a    b"]);
    }
  });

  it("drops the characters pdf-lib drops, rather than reserving a line", async () => {
    for (const code of [0x0008, 0x000b]) {
      const out = await stampText(await page400(), {
        pages: [0],
        text: `a${String.fromCharCode(code)}b`,
        x: 10,
        y: 10,
      });
      expect(shownText(await pageOps(out, 0))).toEqual(["ab"]);
    }
  });

  it("still refuses text that is nothing but a tab", async () => {
    await expect(
      stampText(await page400(), { pages: [0], text: "\t\t" }),
    ).rejects.toThrow(PdfOpError);
  });
});

// ---------------------------------------------------------------------------
// Numbers that are not numbers
// ---------------------------------------------------------------------------

describe("a measurement that is not a real number", () => {
  const page400 = () => makeDoc([{ width: 400, height: 600, rotation: 0 }]);

  it("is refused rather than written into the file", async () => {
    // pdf-lib checks for NaN but not for Infinity: it writes the literal word
    // Infinity into the content stream, which no reader will open, and says
    // nothing. An empty number box in the UI gives one or the other.
    const bytes = await page400();
    const bad: Array<Promise<unknown>> = [
      stampText(bytes, { pages: [0], text: "x", x: Infinity, y: 0 }),
      stampText(bytes, { pages: [0], text: "x", x: NaN, y: 0 }),
      stampText(bytes, { pages: [0], text: "x", y: Number.NaN }),
      stampText(bytes, { pages: [0], text: "x", size: Infinity }),
      stampText(bytes, { pages: [0], text: "x", margin: Infinity }),
      stampText(bytes, { pages: [0], text: "x", rotate: NaN }),
      addWatermark(bytes, { text: "X", size: Infinity }),
      addWatermark(bytes, { text: "X", angle: NaN }),
      addPageNumbers(bytes, { size: NaN }),
      addPageNumbers(bytes, { margin: Infinity }),
      addPageNumbers(bytes, { start: Infinity }),
      stampImage(bytes, { pages: [0], image: makePng(4, 4), x: Infinity, y: 0 }),
      stampImage(bytes, { pages: [0], image: makePng(4, 4), x: 0, y: NaN }),
      stampImage(bytes, { pages: [0], image: makePng(4, 4), x: 0, y: 0, width: Infinity }),
    ];
    for (const attempt of bad) {
      await expect(attempt).rejects.toThrow(PdfOpError);
    }
  });

  it("rounds a page number that arrived with a fraction", async () => {
    const out = await addPageNumbers(await page400(), { start: 1.5, format: "{n}" });
    expect(shownText(await pageOps(out, 0))).toEqual(["2"]);
  });
});

// ---------------------------------------------------------------------------
// The box the reader is shown is the CropBox
// ---------------------------------------------------------------------------

describe("a page whose CropBox is smaller than its MediaBox", () => {
  /** MediaBox 612 x 792, CropBox 500 x 700 starting at (50, 60). */
  async function cropped(rotation = 0): Promise<Uint8Array> {
    const { degrees } = await pdfLib();
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    page.setMediaBox(0, 0, 612, 792);
    page.setCropBox(50, 60, 500, 700);
    if (rotation !== 0) page.setRotation(degrees(rotation));
    return savePdf(doc);
  }

  it("puts view (0, 0) at the corner the reader sees, not the sheet corner", async () => {
    // Every reader shows the CropBox, and pdf.js sizes its viewport from it,
    // so view space starts at (50, 60) here. Measured against the MediaBox the
    // stamp lands at user (0, 783.4), which is off the visible page entirely.
    const out = await stampText(await cropped(), {
      pages: [0],
      text: "TL",
      x: 0,
      y: 0,
      size: 12,
    });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    expect(tm[4]).toBeCloseTo(50, 3);
    expect(tm[5]).toBeCloseTo(60 + 700 - 8.616, 3);
  });

  it("anchors to the corner of the visible page, so nothing lands off it", async () => {
    const out = await stampText(await cropped(), {
      pages: [0],
      text: "BR",
      anchor: "bottom-right",
      margin: 0,
      size: 12,
    });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    const { StandardFonts } = await pdfLib();
    const probe = await blankPdf();
    const font = await probe.embedFont(StandardFonts.Helvetica);
    const tw = font.widthOfTextAtSize("BR", 12);
    expect(tm[4]).toBeCloseTo(50 + 500 - tw, 3);
    // Inside the crop, not past its right edge at 550.
    expect(tm[4] ?? 999).toBeLessThan(550);
    expect(tm[5]).toBeCloseTo(60 + 11.1 - 8.616, 3);
  });

  it("holds when the cropped page is also turned", async () => {
    const out = await stampText(await cropped(90), {
      pages: [0],
      text: "TL",
      x: 0,
      y: 0,
      size: 12,
    });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    // Turned 90 the visible box reads 700 x 500, and view (0, 8.616) becomes
    // user (8.616, 0) before the crop origin is added back on.
    expect(tm[4]).toBeCloseTo(50 + 8.616, 3);
    expect(tm[5]).toBeCloseTo(60, 3);
  });

  it("puts an image inside the visible page too", async () => {
    const out = await stampImage(await cropped(), {
      pages: [0],
      image: makePng(10, 10),
      x: 0,
      y: 0,
      width: 40,
      height: 40,
    });
    const move = matrices(await pageOps(out, 0))[0] ?? [];
    expect(move[4]).toBeCloseTo(50, 3);
    expect(move[5]).toBeCloseTo(60 + 700 - 40, 3);
  });

  it("ignores a CropBox that is nonsense and falls back to the sheet", async () => {
    const doc = await blankPdf();
    const page = doc.addPage([400, 600]);
    page.setMediaBox(0, 0, 400, 600);
    page.setCropBox(0, 0, 0, 0);
    const out = await stampText(await savePdf(doc), {
      pages: [0],
      text: "TL",
      x: 0,
      y: 0,
      size: 12,
    });
    const tm = textMatrices(await pageOps(out, 0))[0] ?? [];
    expect(tm[4]).toBeCloseTo(0, 3);
    expect(tm[5]).toBeCloseTo(600 - 8.616, 3);
  });
});

// ---------------------------------------------------------------------------
// A real file off disk
// ---------------------------------------------------------------------------

describe("a real sample PDF", () => {
  const sample = resolve(
    __dirname,
    "../../../../../backend/samples/sample-apartment-lease.pdf",
  );

  it("takes a watermark and page numbers without losing pages", async () => {
    const original = new Uint8Array(readFileSync(sample));
    const before = await loadPdf(original);
    const count = before.getPageCount();
    expect(count).toBeGreaterThan(0);
    const firstSize = before.getPage(0).getSize();

    const marked = await addWatermark(original, { text: "SAMPLE" });
    const numbered = await addPageNumbers(marked, { format: "Page {n} of {total}" });

    const after = await loadPdf(numbered);
    expect(after.getPageCount()).toBe(count);
    expect(after.getPage(0).getSize()).toEqual(firstSize);
    expect(shownText(await pageOps(numbered, 0))).toContain("SAMPLE");
    expect(shownText(await pageOps(numbered, 0))).toContain(`Page 1 of ${count}`);
  });
});
