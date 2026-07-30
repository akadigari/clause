import { beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, zlibSync } from "fflate";
import { PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";

import { imagesToPdf, pagesToImages, pdfToText, zipFiles } from "./convert";
import { loadPdf, PdfOpError } from "./common";
import { PAGE_SIZES, fitInside } from "../geometry";

/* ------------------------------------------------------------------ */
/* A stand-in for viewer.ts                                            */
/* ------------------------------------------------------------------ */

/**
 * pdf.js cannot be imported under node: its modern build reaches for DOMMatrix
 * at module load and dies. That is not a reason to leave pagesToImages and
 * pdfToText untested, because convert.ts imports viewer.ts from inside the
 * function bodies, so the import can be replaced.
 *
 * The fake mirrors viewer.ts's real contract exactly: openForViewing resolves
 * to { doc, close }, NOT to the pdf.js document. Getting that wrapper wrong is
 * the whole reason these tests exist.
 */
const viewer = vi.hoisted(() => ({
  pages: [] as Array<{ text: string; width: number; height: number }>,
  closed: 0,
  rendered: [] as number[],
  textRead: [] as number[],
}));

type FakePage = { n: number; getViewport(o: { scale: number }): { width: number; height: number }; cleanup(): void };

vi.mock("../viewer", () => ({
  openForViewing: async () => ({
    doc: {
      numPages: viewer.pages.length,
      getPage: async (n: number): Promise<FakePage> => {
        const page = viewer.pages[n - 1];
        if (!page) throw new Error(`fake viewer has no page ${n}`);
        return {
          n,
          getViewport: ({ scale }) => ({ width: page.width * scale, height: page.height * scale }),
          cleanup: () => undefined,
        };
      },
    },
    close: async () => {
      viewer.closed += 1;
    },
  }),
  renderPageToBlob: async (page: FakePage) => {
    viewer.rendered.push(page.n);
    return new Blob([new Uint8Array([page.n])], { type: "image/png" });
  },
  pageText: async (page: FakePage) => {
    viewer.textRead.push(page.n);
    return viewer.pages[page.n - 1]?.text ?? "";
  },
}));

function fakeDoc(pages: Array<{ text?: string; width?: number; height?: number }>): void {
  viewer.pages = pages.map((p) => ({
    text: p.text ?? "",
    width: p.width ?? 612,
    height: p.height ?? 792,
  }));
  viewer.closed = 0;
  viewer.rendered = [];
  viewer.textRead = [];
}

/** Any bytes that get as far as openForViewing. The fake ignores them. */
const SOME_PDF = new TextEncoder().encode("%PDF-1.7\nwhatever");

/* ------------------------------------------------------------------ */
/* Fixtures built by hand, so the tests carry their own images         */
/* ------------------------------------------------------------------ */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i] as number;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A real 8 bit RGB PNG, all black, with correct CRCs and a real zlib IDAT. */
function makePng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type 2, truecolour
  // Every row is a filter byte of 0 followed by three bytes a pixel.
  const raw = new Uint8Array(height * (1 + width * 3));
  return join([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * A JPEG with a real SOI and SOF0 frame header and no scan data. pdf-lib
 * reads the markers to learn the size and then embeds the bytes untouched,
 * so this is enough to test the sizing without shipping a real photo.
 */
function makeJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length, 17
    0x08, // 8 bits per component
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, // three components, so RGB
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
    0xff, 0xd9, // EOI
  ]);
}

/**
 * The same JPEG with an EXIF block in front of it carrying one orientation
 * tag. Built by hand so the test does not need a real photo: SOI, then an
 * APP1 segment holding "Exif\0\0" and a little endian TIFF header whose first
 * directory has exactly one entry, tag 0x0112.
 */
function makeJpegWithExif(width: number, height: number, orientation: number): Uint8Array {
  const tiff = new Uint8Array(26);
  const t = new DataView(tiff.buffer);
  tiff[0] = 0x49; // "II", little endian
  tiff[1] = 0x49;
  t.setUint16(2, 42, true); // the number that proves the byte order read right
  t.setUint32(4, 8, true); // first directory sits right after this header
  t.setUint16(8, 1, true); // one entry in it
  t.setUint16(10, 0x0112, true); // tag: orientation
  t.setUint16(12, 3, true); // type: SHORT
  t.setUint32(14, 1, true); // count
  t.setUint16(18, orientation, true); // the value itself, it fits inline
  t.setUint32(22, 0, true); // no second directory

  // "Exif" then two zero bytes, which is what marks an APP1 as an EXIF block.
  const payload = join([new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), tiff]);
  const app1 = new Uint8Array(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  new DataView(app1.buffer).setUint16(2, payload.length + 2);
  app1.set(payload, 4);

  const plain = makeJpeg(width, height);
  // Slot the APP1 in between the SOI and the frame header.
  return join([plain.subarray(0, 2), app1, plain.subarray(2)]);
}

function makeWebp(): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  out.set([0x10, 0x00, 0x00, 0x00], 4);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  out.set([0x56, 0x50, 0x38, 0x20], 12); // VP8 chunk
  return out;
}

function makeHeic(): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x00, 0x00, 0x00, 0x18], 0); // box size
  out.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  out.set([0x68, 0x65, 0x69, 0x63], 8); // heic brand
  out.set([0x6d, 0x69, 0x66, 0x31], 12); // mif1
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading the result back out                                         */
/* ------------------------------------------------------------------ */

async function sizesOf(bytes: Uint8Array): Promise<Array<{ width: number; height: number }>> {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((page) => {
    const box = page.getMediaBox();
    return { width: box.width, height: box.height };
  });
}

/** The decoded content stream text for one page of a saved document. */
async function contentOf(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await loadPdf(bytes);
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const parts: string[] = [];

  const take = (value: unknown): void => {
    if (value instanceof PDFRawStream) {
      parts.push(new TextDecoder().decode(decodePDFRawStream(value).decode()));
    }
  };

  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) take(doc.context.lookup(contents.get(i)));
  } else {
    take(contents);
  }
  return parts.join("\n");
}

/**
 * Where the image actually landed on the page.
 *
 * pdf-lib draws an image by concatenating a translate, a rotate, a scale and
 * a skew, then painting the unit square. Pushing (0,0) and (1,1) back through
 * those matrices in reverse order gives the rectangle that was really drawn,
 * which is the only honest way to check the placement maths.
 */
function drawnRect(content: string): { x: number; y: number; width: number; height: number } {
  const pattern =
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  const matrices: number[][] = [];
  for (const m of content.matchAll(pattern)) {
    matrices.push(m.slice(1, 7).map(Number));
  }
  expect(matrices.length).toBeGreaterThan(0);

  const apply = (m: number[], p: { x: number; y: number }) => ({
    x: (m[0] as number) * p.x + (m[2] as number) * p.y + (m[4] as number),
    y: (m[1] as number) * p.x + (m[3] as number) * p.y + (m[5] as number),
  });
  const through = (p: { x: number; y: number }) => {
    let out = p;
    for (let i = matrices.length - 1; i >= 0; i--) out = apply(matrices[i] as number[], out);
    return out;
  };

  const a = through({ x: 0, y: 0 });
  const b = through({ x: 1, y: 1 });
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Where the image's own top left corner ends up on the page.
 *
 * The bounding box alone cannot tell a half turn from no turn at all, since
 * both cover the same rectangle. An image XObject is painted over the unit
 * square with its first row of pixels along y = 1, so pushing (0, 1) through
 * the matrices says which page corner the top of the photo is now against,
 * which is the thing an orientation tag is actually about.
 */
function storedTopLeft(content: string): { x: number; y: number } {
  const pattern =
    /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  const matrices: number[][] = [];
  for (const m of content.matchAll(pattern)) matrices.push(m.slice(1, 7).map(Number));
  expect(matrices.length).toBeGreaterThan(0);

  let out = { x: 0, y: 1 };
  for (let i = matrices.length - 1; i >= 0; i--) {
    const m = matrices[i] as number[];
    out = {
      x: (m[0] as number) * out.x + (m[2] as number) * out.y + (m[4] as number),
      y: (m[1] as number) * out.x + (m[3] as number) * out.y + (m[5] as number),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* imagesToPdf                                                         */
/* ------------------------------------------------------------------ */

describe("imagesToPdf", () => {
  it("gives every page the image's own size when pageSize is auto", async () => {
    const out = await imagesToPdf([
      { name: "wide.png", bytes: makePng(120, 60) },
      { name: "tall.jpg", bytes: makeJpeg(200, 400) },
    ]);

    expect(await sizesOf(out)).toEqual([
      { width: 120, height: 60 },
      { width: 200, height: 400 },
    ]);
  });

  it("fills an auto page edge to edge", async () => {
    const out = await imagesToPdf([{ name: "wide.png", bytes: makePng(120, 60) }]);
    const rect = drawnRect(await contentOf(out, 0));

    expect(rect.x).toBeCloseTo(0, 4);
    expect(rect.y).toBeCloseTo(0, 4);
    expect(rect.width).toBeCloseTo(120, 4);
    expect(rect.height).toBeCloseTo(60, 4);
  });

  it("centres inside a fixed A4 page and keeps the image's shape", async () => {
    const out = await imagesToPdf([{ name: "wide.png", bytes: makePng(120, 60) }], {
      pageSize: "a4",
      margin: 36,
    });

    expect(await sizesOf(out)).toEqual([
      { width: PAGE_SIZES.a4.width, height: PAGE_SIZES.a4.height },
    ]);

    const fit = fitInside(
      { width: 120, height: 60 },
      { width: PAGE_SIZES.a4.width - 72, height: PAGE_SIZES.a4.height - 72 },
    );
    const rect = drawnRect(await contentOf(out, 0));

    expect(rect.width).toBeCloseTo(fit.width, 3);
    expect(rect.height).toBeCloseTo(fit.height, 3);
    expect(rect.x).toBeCloseTo((PAGE_SIZES.a4.width - fit.width) / 2, 3);
    expect(rect.y).toBeCloseTo((PAGE_SIZES.a4.height - fit.height) / 2, 3);
    // Shape kept means the ratio survives the fit.
    expect(rect.width / rect.height).toBeCloseTo(2, 6);
  });

  it("uses the whole page when the margin is zero", async () => {
    const out = await imagesToPdf([{ name: "tall.jpg", bytes: makeJpeg(300, 600) }], {
      pageSize: "letter",
      margin: 0,
    });

    expect(await sizesOf(out)).toEqual([
      { width: PAGE_SIZES.letter.width, height: PAGE_SIZES.letter.height },
    ]);

    const rect = drawnRect(await contentOf(out, 0));
    // A 1:2 image is taller than Letter's 612:792, so height is the binding side.
    expect(rect.height).toBeCloseTo(PAGE_SIZES.letter.height, 3);
    expect(rect.width).toBeCloseTo(PAGE_SIZES.letter.height / 2, 3);
    expect(rect.y).toBeCloseTo(0, 3);
    expect(rect.x).toBeCloseTo((PAGE_SIZES.letter.width - PAGE_SIZES.letter.height / 2) / 2, 3);
  });

  it("names the file and the format when handed a WEBP", async () => {
    const failure = await imagesToPdf([{ name: "holiday.webp", bytes: makeWebp() }]).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(PdfOpError);
    expect((failure as PdfOpError).message).toContain("holiday.webp");
    expect((failure as PdfOpError).message).toContain("WEBP");
    expect((failure as PdfOpError).message).toMatch(/PNG or JPEG/);
  });

  it("names the file and the format when handed a HEIC", async () => {
    const failure = await imagesToPdf([{ name: "IMG_0042.HEIC", bytes: makeHeic() }]).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(PdfOpError);
    expect((failure as PdfOpError).message).toContain("IMG_0042.HEIC");
    expect((failure as PdfOpError).message).toContain("HEIC");
    expect((failure as PdfOpError).message).toMatch(/PNG or JPEG/);
  });

  it("does not let a HEIC that lies about its extension slip through as unknown", async () => {
    // Phones hand out .jpg names for HEIC files all the time.
    const failure = await imagesToPdf([{ name: "photo.jpg", bytes: makeHeic() }]).catch(
      (err: unknown) => err,
    );

    expect((failure as PdfOpError).message).toContain("HEIC");
    expect((failure as PdfOpError).message).not.toContain("not an image");
  });

  it("says so when the file is really a PDF", async () => {
    const notAnImage = new TextEncoder().encode("%PDF-1.7\nnot an image at all");
    const failure = await imagesToPdf([{ name: "lease.pdf", bytes: notAnImage }]).catch(
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(PdfOpError);
    expect((failure as PdfOpError).message).toContain("lease.pdf");
    expect((failure as PdfOpError).message).toContain("not an image");
  });

  it("refuses an empty batch", async () => {
    await expect(imagesToPdf([])).rejects.toBeInstanceOf(PdfOpError);
  });

  it("refuses a margin that leaves no room", async () => {
    const failure = await imagesToPdf([{ name: "a.png", bytes: makePng(10, 10) }], {
      pageSize: "a4",
      margin: 400,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(PdfOpError);
    expect((failure as PdfOpError).message).toContain("400");
  });

  it("refuses a negative margin", async () => {
    await expect(
      imagesToPdf([{ name: "a.png", bytes: makePng(10, 10) }], { margin: -5 }),
    ).rejects.toBeInstanceOf(PdfOpError);
  });

  it("handles a one image batch and a one pixel image", async () => {
    const out = await imagesToPdf([{ name: "dot.png", bytes: makePng(1, 1) }]);
    expect(await sizesOf(out)).toEqual([{ width: 1, height: 1 }]);
  });

  it("reports progress once per image", async () => {
    const seen: Array<[number, number]> = [];
    await imagesToPdf(
      [
        { name: "a.png", bytes: makePng(10, 10) },
        { name: "b.png", bytes: makePng(10, 10) },
        { name: "c.jpg", bytes: makeJpeg(10, 10) },
      ],
      { onProgress: (done, total) => seen.push([done, total]) },
    );
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("leaves the caller's bytes alone", async () => {
    const png = makePng(20, 10);
    const before = png.slice();
    await imagesToPdf([{ name: "a.png", bytes: png }]);
    expect(Array.from(png)).toEqual(Array.from(before));
  });

  it("reads a JPEG correctly even when the bytes are a view into a bigger buffer", async () => {
    // pdf-lib's JPEG reader builds a DataView over the whole backing buffer and
    // ignores the view's offset, so an uncopied subarray would be read from the
    // wrong place and come out with a nonsense size.
    const jpeg = makeJpeg(150, 90);
    const padded = new Uint8Array(jpeg.length + 64);
    padded.set(jpeg, 64);
    const view = padded.subarray(64);

    const out = await imagesToPdf([{ name: "offset.jpg", bytes: view }]);
    expect(await sizesOf(out)).toEqual([{ width: 150, height: 90 }]);
  });
});

/* ------------------------------------------------------------------ */
/* imagesToPdf and the turn a phone records instead of applying        */
/* ------------------------------------------------------------------ */

describe("imagesToPdf EXIF orientation", () => {
  it("leaves an upright photo alone", async () => {
    const out = await imagesToPdf([
      { name: "up.jpg", bytes: makeJpegWithExif(200, 100, 1) },
    ]);
    expect(await sizesOf(out)).toEqual([{ width: 200, height: 100 }]);
    // Top of the photo against the top of the page.
    const corner = storedTopLeft(await contentOf(out, 0));
    expect(corner.x).toBeCloseTo(0, 3);
    expect(corner.y).toBeCloseTo(100, 3);
  });

  it("stands a sideways photo up, and gives the page the turned shape", async () => {
    // Orientation 6 is the common one: held upright, sensor rows stored
    // landscape. 200x100 stored has to come out 100 wide by 200 tall.
    const out = await imagesToPdf([
      { name: "IMG_1.jpg", bytes: makeJpegWithExif(200, 100, 6) },
    ]);
    expect(await sizesOf(out)).toEqual([{ width: 100, height: 200 }]);

    const content = await contentOf(out, 0);
    const rect = drawnRect(content);
    expect(rect.x).toBeCloseTo(0, 3);
    expect(rect.y).toBeCloseTo(0, 3);
    expect(rect.width).toBeCloseTo(100, 3);
    expect(rect.height).toBeCloseTo(200, 3);

    // Orientation 6 says the stored top row belongs on the right hand side.
    const corner = storedTopLeft(content);
    expect(corner.x).toBeCloseTo(100, 3);
    expect(corner.y).toBeCloseTo(200, 3);
  });

  it("turns the other way for orientation 8", async () => {
    const out = await imagesToPdf([
      { name: "IMG_2.jpg", bytes: makeJpegWithExif(200, 100, 8) },
    ]);
    expect(await sizesOf(out)).toEqual([{ width: 100, height: 200 }]);

    // Orientation 8 puts the stored top row on the left hand side, which is
    // the opposite corner from orientation 6. Getting these two the same way
    // round is the whole point.
    const corner = storedTopLeft(await contentOf(out, 0));
    expect(corner.x).toBeCloseTo(0, 3);
    expect(corner.y).toBeCloseTo(0, 3);
  });

  it("half turns an upside down photo without changing the page shape", async () => {
    const out = await imagesToPdf([
      { name: "IMG_3.jpg", bytes: makeJpegWithExif(200, 100, 3) },
    ]);
    expect(await sizesOf(out)).toEqual([{ width: 200, height: 100 }]);

    const content = await contentOf(out, 0);
    const rect = drawnRect(content);
    expect(rect.x).toBeCloseTo(0, 3);
    expect(rect.y).toBeCloseTo(0, 3);
    expect(rect.width).toBeCloseTo(200, 3);
    expect(rect.height).toBeCloseTo(100, 3);

    // A half turn covers the same rectangle, so only the corner shows it ran.
    const corner = storedTopLeft(content);
    expect(corner.x).toBeCloseTo(200, 3);
    expect(corner.y).toBeCloseTo(0, 3);
  });

  it("fits the turned shape, not the stored one, onto a fixed page", async () => {
    // Stored 400x200. Turned it is 200 wide by 400 tall, so on A4 with a 36
    // point margin the height is the binding side, not the width.
    const out = await imagesToPdf(
      [{ name: "IMG_4.jpg", bytes: makeJpegWithExif(400, 200, 6) }],
      { pageSize: "a4", margin: 36 },
    );

    const fit = fitInside(
      { width: 200, height: 400 },
      { width: PAGE_SIZES.a4.width - 72, height: PAGE_SIZES.a4.height - 72 },
    );
    const rect = drawnRect(await contentOf(out, 0));
    expect(rect.width).toBeCloseTo(fit.width, 3);
    expect(rect.height).toBeCloseTo(fit.height, 3);
    expect(rect.x).toBeCloseTo((PAGE_SIZES.a4.width - fit.width) / 2, 3);
    expect(rect.y).toBeCloseTo((PAGE_SIZES.a4.height - fit.height) / 2, 3);
    // Tall, not wide. Reading the stored size would have given 2, not 0.5.
    expect(rect.width / rect.height).toBeCloseTo(0.5, 6);
  });

  it("ignores a nonsense orientation rather than turning on a guess", async () => {
    const out = await imagesToPdf([
      { name: "junk.jpg", bytes: makeJpegWithExif(200, 100, 99) },
    ]);
    expect(await sizesOf(out)).toEqual([{ width: 200, height: 100 }]);
  });

  it("does not go looking for EXIF in a JPEG that has none", async () => {
    const out = await imagesToPdf([{ name: "plain.jpg", bytes: makeJpeg(200, 100) }]);
    expect(await sizesOf(out)).toEqual([{ width: 200, height: 100 }]);
  });
});

/* ------------------------------------------------------------------ */
/* zipFiles                                                            */
/* ------------------------------------------------------------------ */

describe("zipFiles", () => {
  it("builds a real zip that unpacks back to the same bytes", async () => {
    const blob = await zipFiles([
      { name: "notes.txt", data: new TextEncoder().encode("hello there") },
      { name: "page-01.png", data: makePng(4, 4) },
    ]);

    expect(blob.type).toBe("application/zip");

    const packed = new Uint8Array(await blob.arrayBuffer());
    // Local file header magic, so this is a zip and not a hopeful buffer.
    expect(Array.from(packed.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const unpacked = unzipSync(packed);
    expect(Object.keys(unpacked).sort()).toEqual(["notes.txt", "page-01.png"]);
    expect(new TextDecoder().decode(unpacked["notes.txt"] as Uint8Array)).toBe("hello there");
    expect(Array.from(unpacked["page-01.png"] as Uint8Array)).toEqual(
      Array.from(makePng(4, 4)),
    );
  });

  it("keeps both files when two share a name", async () => {
    const blob = await zipFiles([
      { name: "page.txt", data: new TextEncoder().encode("first") },
      { name: "page.txt", data: new TextEncoder().encode("second") },
      { name: "page.txt", data: new TextEncoder().encode("third") },
    ]);

    const unpacked = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(unpacked).sort()).toEqual(["page-2.txt", "page-3.txt", "page.txt"]);
    expect(new TextDecoder().decode(unpacked["page.txt"] as Uint8Array)).toBe("first");
    expect(new TextDecoder().decode(unpacked["page-2.txt"] as Uint8Array)).toBe("second");
    expect(new TextDecoder().decode(unpacked["page-3.txt"] as Uint8Array)).toBe("third");
  });

  it("scrubs path separators out of names so the archive stays flat", async () => {
    const blob = await zipFiles([
      { name: "../../etc/passwd", data: new TextEncoder().encode("nope") },
    ]);
    const names = Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain("/");
  });

  it("survives a batch big enough to matter", async () => {
    const files = Array.from({ length: 200 }, (_unused, i) => ({
      name: `page-${String(i + 1).padStart(3, "0")}.png`,
      data: makePng(8, 8),
    }));

    const blob = await zipFiles(files);
    const unpacked = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(unpacked)).toHaveLength(200);
    expect(unpacked["page-200.png"]).toBeDefined();
  });

  it("refuses an empty batch", async () => {
    await expect(zipFiles([])).rejects.toBeInstanceOf(PdfOpError);
  });

  it("leaves the caller's arrays alone", async () => {
    const data = makePng(6, 6);
    const before = data.slice();
    await zipFiles([{ name: "a.png", data }]);
    expect(Array.from(data)).toEqual(Array.from(before));
  });
});

/* ------------------------------------------------------------------ */
/* The two that go through viewer.ts                                   */
/* ------------------------------------------------------------------ */

describe("pagesToImages", () => {
  beforeEach(() => {
    fakeDoc([{}, {}, {}]);
  });

  it("renders every page and names them padded to the stack", async () => {
    const out = await pagesToImages(SOME_PDF, {});
    expect(out.map((o) => o.name)).toEqual(["page-1.png", "page-2.png", "page-3.png"]);
    expect(viewer.rendered).toEqual([1, 2, 3]);
  });

  it("reports the pixel size the file really came out at", async () => {
    // Letter at 150dpi is 612 * 150/72 = 1275 across.
    const out = await pagesToImages(SOME_PDF, { dpi: 150 });
    expect(out[0]).toMatchObject({ width: 1275, height: 1650 });
  });

  it("takes a subset by index and still names by document page number", async () => {
    fakeDoc(Array.from({ length: 12 }, () => ({})));
    const out = await pagesToImages(SOME_PDF, { pages: [0, 4, 11] });
    expect(viewer.rendered).toEqual([1, 5, 12]);
    expect(out.map((o) => o.name)).toEqual(["page-01.png", "page-05.png", "page-12.png"]);
  });

  it("counts progress against the selection, not the document", async () => {
    fakeDoc(Array.from({ length: 12 }, () => ({})));
    const seen: Array<[number, number]> = [];
    await pagesToImages(SOME_PDF, {
      pages: [3, 4],
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("uses the jpg extension for jpeg output", async () => {
    const out = await pagesToImages(SOME_PDF, { type: "image/jpeg" });
    expect(out.map((o) => o.name)).toEqual(["page-1.jpg", "page-2.jpg", "page-3.jpg"]);
  });

  it("shuts the document down, including when it throws", async () => {
    await pagesToImages(SOME_PDF, {});
    expect(viewer.closed).toBe(1);

    await expect(pagesToImages(SOME_PDF, { pages: [99] })).rejects.toBeInstanceOf(PdfOpError);
    expect(viewer.closed).toBe(2);
  });

  it("refuses a dpi that would ask for a canvas no browser will give", async () => {
    fakeDoc([{ width: 2000, height: 2000 }]);
    const failure = await pagesToImages(SOME_PDF, { dpi: 600 }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(PdfOpError);
    // It has to say which page and offer a dpi that would fit.
    expect((failure as PdfOpError).message).toContain("Page 1");
    expect((failure as PdfOpError).hint).toMatch(/\d+ dots per inch/);
    // Nothing was rendered, so no blank white file was handed back as a win.
    expect(viewer.rendered).toEqual([]);
  });

  it("still allows 600dpi on an ordinary page", async () => {
    const out = await pagesToImages(SOME_PDF, { dpi: 600, pages: [0] });
    expect(out[0]).toMatchObject({ width: 5100, height: 6600 });
  });

  it("refuses a dpi outside the range and an empty selection", async () => {
    await expect(pagesToImages(SOME_PDF, { dpi: 5 })).rejects.toBeInstanceOf(PdfOpError);
    await expect(pagesToImages(SOME_PDF, { dpi: 5000 })).rejects.toBeInstanceOf(PdfOpError);
    await expect(pagesToImages(SOME_PDF, { pages: [] })).rejects.toBeInstanceOf(PdfOpError);
  });
});

describe("pdfToText", () => {
  it("joins the pages with a form feed and a newline", async () => {
    fakeDoc([
      { text: "the first page has plenty of words on it" },
      { text: "and so does the second page here" },
    ]);
    const text = await pdfToText(SOME_PDF, {});
    expect(text).toBe(
      "the first page has plenty of words on it\f\nand so does the second page here",
    );
  });

  it("reads only the pages that were asked for", async () => {
    fakeDoc(
      Array.from({ length: 10 }, (_unused, i) => ({ text: `page ${i + 1} has real words on it` })),
    );
    const text = await pdfToText(SOME_PDF, { pages: [2, 7] });

    // The old version read all ten and threw eight away.
    expect(viewer.textRead).toEqual([3, 8]);
    expect(text).toBe("page 3 has real words on it\f\npage 8 has real words on it");
  });

  it("counts progress against the selection, not the document", async () => {
    fakeDoc(
      Array.from({ length: 40 }, (_unused, i) => ({ text: `page ${i + 1} has real words on it` })),
    );
    const seen: Array<[number, number]> = [];
    await pdfToText(SOME_PDF, {
      pages: [0, 1, 2],
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("says plainly that a scan has no text rather than returning nothing", async () => {
    fakeDoc([{ text: "" }, { text: "  \n " }, { text: "3" }]);
    const text = await pdfToText(SOME_PDF, {});
    expect(text).toContain("OCR");
    expect(text).toContain("All 3 of these pages are pictures");
  });

  it("gets the grammar right for a single page", async () => {
    fakeDoc([{ text: "" }]);
    const text = await pdfToText(SOME_PDF, {});
    expect(text).toContain("This page is a picture");
    expect(text).not.toContain("All 1");
  });

  it("keeps a page that has no text when its neighbours do", async () => {
    fakeDoc([{ text: "a page with a real sentence on it" }, { text: "" }]);
    expect(await pdfToText(SOME_PDF, {})).toBe("a page with a real sentence on it\f\n");
  });

  it("shuts the document down, including when it throws", async () => {
    fakeDoc([{ text: "a page with a real sentence on it" }]);
    await pdfToText(SOME_PDF, {});
    expect(viewer.closed).toBe(1);

    await expect(pdfToText(SOME_PDF, { pages: [42] })).rejects.toBeInstanceOf(PdfOpError);
    expect(viewer.closed).toBe(2);
  });
});
