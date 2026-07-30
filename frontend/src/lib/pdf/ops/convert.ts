/**
 * Getting things in and out of a PDF.
 *
 * Four one way trips live here, and they are the ones people actually ask a
 * PDF tool for:
 *
 *   pagesToImages  a PDF becomes PNGs or JPEGs
 *   imagesToPdf    a pile of photos becomes a PDF
 *   pdfToText      the words come out as plain text
 *   zipFiles       a batch of any of the above comes down as one download
 *
 * Two of these need pdf.js, which is a megabyte, so viewer.ts is imported
 * inside the functions that use it rather than at the top. That keeps
 * imagesToPdf and zipFiles usable without dragging a renderer along.
 *
 * pagesToImages is the only thing here that touches a canvas, which means it
 * is the only thing here that cannot run outside a browser.
 */

import { zip, type AsyncZippable } from "fflate";

import {
  blankPdf,
  breathe,
  checkSize,
  copyBytes,
  LIMITS,
  PdfOpError,
  pdfLib,
  requirePages,
  savePdf,
  type PDFDocument,
  type PDFImage,
  type PDFPage,
  type Progress,
} from "./common";
import { fitInside, PAGE_SIZES } from "../geometry";
import { pageNo, safeName } from "../../format";

/** One exported image: the bytes, the name to save it under, and its real size. */
export type ImageOut = { name: string; blob: Blob; width: number; height: number };

/**
 * The most pixels one canvas may be asked for.
 *
 * dpi on its own does not bound this, because the page size is the other
 * factor: 600dpi is fine on a Letter page (33 megapixels) and past every
 * browser's limit on A0. Going over the limit does not raise an error, it
 * hands back a canvas that is silently blank, so the export "succeeds" and
 * every page comes out white. Refusing with a sentence is the only honest
 * option. Note this cannot rescue iOS, which caps a single canvas far lower
 * than desktop Safari and gives no way to ask what the cap is.
 */
const MAX_CANVAS_PIXELS = 50_000_000;

/* ------------------------------------------------------------------ */
/* PDF out, as pictures                                                */
/* ------------------------------------------------------------------ */

/**
 * Render pages to image files.
 *
 * `dpi` is real dots per inch, so 150 turns a Letter page into 1275 pixels
 * across. 150 is comfortable to read on screen, 300 is what a scanner gives
 * you, and past 600 a browser canvas starts refusing to allocate.
 *
 * This needs a canvas, so it only runs in a browser tab.
 */
export async function pagesToImages(
  bytes: Uint8Array,
  options: {
    pages?: number[];
    dpi?: number;
    type?: "image/png" | "image/jpeg";
    quality?: number;
    baseName?: string;
    onProgress?: Progress;
  },
): Promise<ImageOut[]> {
  const {
    pages,
    dpi = 150,
    type = "image/png",
    quality = 0.82,
    baseName = "page",
    onProgress,
  } = options;

  checkSize(bytes);

  if (!Number.isFinite(dpi) || dpi < 36 || dpi > 600) {
    throw new PdfOpError(
      `${dpi} dots per inch is outside what a browser canvas will hold.`,
      "Anything from 36 to 600 works. 150 reads well on screen, 300 matches a scanner.",
    );
  }

  const { openForViewing, renderPageToBlob } = await import("../viewer");
  // openForViewing hands back { doc, close }, not the pdf.js document itself.
  // The close() is the only way to shut the worker down: neither the proxy nor
  // this wrapper has a destroy(), so dropping it leaks a worker per export.
  const opened = await openForViewing(copyBytes(bytes));
  const doc = opened.doc;

  try {
    const total = doc.numPages;
    if (total === 0) {
      throw new PdfOpError(
        "That PDF has no pages in it.",
        "The file opened, but there is nothing inside to export.",
      );
    }

    const chosen = requirePages(pages ?? everyIndex(total), total);
    const stem = safeName(baseName);
    const extension = type === "image/jpeg" ? "jpg" : "png";
    const out: ImageOut[] = [];

    for (const [nth, index] of chosen.entries()) {
      const page = await doc.getPage(index + 1);
      const viewport = page.getViewport({ scale: dpi / 72 });
      // renderPageToBlob floors the canvas the same way, so these are the
      // sizes the file really came out at rather than an estimate.
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));

      if (width * height > MAX_CANVAS_PIXELS) {
        const fits = Math.floor(
          dpi * Math.sqrt(MAX_CANVAS_PIXELS / (width * height)),
        );
        page.cleanup();
        throw new PdfOpError(
          `Page ${index + 1} at ${dpi} dots per inch would be ${width} by ${height} pixels, which is more than a browser canvas will hold.`,
          `Try ${Math.max(36, fits)} dots per inch instead, or export that page on its own.`,
        );
      }

      const blob = await renderPageToBlob(page, { dpi, type, quality });
      page.cleanup();

      out.push({
        name: `${stem}-${pageNo(index, total)}.${extension}`,
        blob,
        width,
        height,
      });

      onProgress?.(nth + 1, chosen.length, `page ${index + 1}`);
      await breathe();
    }

    return out;
  } finally {
    await opened.close();
  }
}

/* ------------------------------------------------------------------ */
/* Pictures in                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build a PDF out of image files, one image per page.
 *
 * `pageSize: 'auto'` gives each page exactly the pixel size of its own image,
 * counted as points at 72dpi. That is the right default for phone photos and
 * screenshots: nothing gets cropped, nothing gets padded, and a set of mixed
 * sizes stays mixed instead of being squashed onto one shape. 'a4' and
 * 'letter' put every image on the same fixed page, centred, with its shape
 * kept.
 *
 * A phone photo carries its turn in an EXIF tag rather than in the pixels, and
 * pdf-lib does not read that tag, so the turn is applied here. Without it a
 * held-upright photo comes out lying on its side, which is the single most
 * common thing anyone drops into a tool like this.
 */
export async function imagesToPdf(
  images: Array<{ name: string; bytes: Uint8Array }>,
  options: {
    pageSize?: "auto" | "a4" | "letter";
    margin?: number;
    onProgress?: Progress;
  } = {},
): Promise<Uint8Array> {
  const { pageSize = "auto", margin = 36, onProgress } = options;

  if (images.length === 0) {
    throw new PdfOpError(
      "No images were given.",
      "Drop in some PNG or JPEG files and try again.",
    );
  }
  if (images.length > LIMITS.maxPages) {
    throw new PdfOpError(
      `${images.length} images is past the ${LIMITS.maxPages} page ceiling.`,
      "Do it in two batches and merge the results.",
    );
  }
  // Every other entry point weighs its input. A pile of photos can easily be
  // larger than the PDF that would be refused for the same size.
  let weight = 0;
  for (const file of images) weight += file.bytes.byteLength;
  if (weight > LIMITS.maxBytes) {
    throw new PdfOpError(
      `Those ${images.length} images come to ${Math.round(weight / 1048576)}MB, past the ${
        LIMITS.maxBytes / 1048576
      }MB this can handle.`,
      "Everything here runs in the browser tab, which has a memory ceiling a desktop app does not.",
    );
  }
  if (!Number.isFinite(margin) || margin < 0) {
    throw new PdfOpError(
      "A margin cannot be negative.",
      "Margins are in points, 72 to the inch, so 36 is a half inch and 0 is edge to edge.",
    );
  }

  const frame = pageSize === "auto" ? null : PAGE_SIZES[pageSize];
  if (frame && (margin * 2 >= frame.width || margin * 2 >= frame.height)) {
    throw new PdfOpError(
      `A ${Math.round(margin)} point margin leaves no room on a ${pageSize.toUpperCase()} page.`,
      "Margins are in points, 72 to the inch. Try 36.",
    );
  }

  const doc = await blankPdf();
  const { degrees } = await pdfLib();

  for (const [nth, file] of images.entries()) {
    const { image, turn } = await embedImage(doc, file.name, file.bytes);
    // A quarter turn swaps which side of the photo is its width, so every
    // size decision below is made on the turned shape, not the stored one.
    const shown =
      turn === 90 || turn === 270
        ? { width: image.height, height: image.width }
        : { width: image.width, height: image.height };

    if (frame) {
      const box = { width: frame.width - margin * 2, height: frame.height - margin * 2 };
      const fit = fitInside(shown, box);
      const page = doc.addPage([frame.width, frame.height]);
      drawTurned(page, image, turn, degrees, {
        x: (frame.width - fit.width) / 2,
        y: (frame.height - fit.height) / 2,
        width: fit.width,
        height: fit.height,
      });
    } else {
      const page = doc.addPage([shown.width, shown.height]);
      drawTurned(page, image, turn, degrees, {
        x: 0,
        y: 0,
        width: shown.width,
        height: shown.height,
      });
    }

    onProgress?.(nth + 1, images.length, file.name);
    await breathe();
  }

  return savePdf(doc);
}

/**
 * Paint an image so it fills `target` after being turned by `turn` degrees.
 *
 * pdf-lib builds the matrix as translate, then rotate, then scale, and then
 * paints the unit square. That means the point given as (x, y) is the corner
 * the square grows away from, and which corner that is changes with every
 * quarter turn, so each case has to place it separately. The width and height
 * passed to drawImage are the unturned size, which for a quarter turn is the
 * target's two sides the other way round.
 */
function drawTurned(
  page: PDFPage,
  image: PDFImage,
  turn: 0 | 90 | 180 | 270,
  degrees: (typeof import("pdf-lib"))["degrees"],
  target: { x: number; y: number; width: number; height: number },
): void {
  const { x, y, width: w, height: h } = target;

  switch (turn) {
    case 90:
      page.drawImage(image, { x: x + w, y, width: h, height: w, rotate: degrees(90) });
      break;
    case 180:
      page.drawImage(image, {
        x: x + w,
        y: y + h,
        width: w,
        height: h,
        rotate: degrees(180),
      });
      break;
    case 270:
      page.drawImage(image, { x, y: y + h, width: h, height: w, rotate: degrees(270) });
      break;
    default:
      page.drawImage(image, { x, y, width: w, height: h });
  }
}

/* ------------------------------------------------------------------ */
/* Words out                                                           */
/* ------------------------------------------------------------------ */

/**
 * Pull the text out of a PDF.
 *
 * Pages are separated by a form feed then a newline, which is what every
 * other text extractor emits, so the output drops into another tool without
 * surprising it.
 *
 * A scanned document has no text to give. Rather than handing back an empty
 * string and letting the user think the tool broke, this says plainly that
 * the pages are pictures and that reading them would need OCR.
 */
export async function pdfToText(
  bytes: Uint8Array,
  options: { pages?: number[]; onProgress?: Progress } = {},
): Promise<string> {
  const { pages, onProgress } = options;

  checkSize(bytes);

  const { openForViewing, pageText } = await import("../viewer");
  // openForViewing hands back { doc, close }, not the pdf.js document itself.
  const opened = await openForViewing(copyBytes(bytes));
  const doc = opened.doc;

  try {
    const total = doc.numPages;
    if (total === 0) {
      throw new PdfOpError(
        "That PDF has no pages in it.",
        "The file opened, but there is nothing inside to read.",
      );
    }

    const chosen = requirePages(pages ?? everyIndex(total), total);

    // Walking the chosen pages rather than reading every page and throwing
    // most of it away. Asking for one page of a 400 page contract used to cost
    // all 400, and the progress bar counted to 400 for a job of one.
    const picked: string[] = [];
    for (const [nth, index] of chosen.entries()) {
      const page = await doc.getPage(index + 1);
      picked.push(await pageText(page));
      page.cleanup();
      onProgress?.(nth + 1, chosen.length, `page ${index + 1}`);
      if (nth % 8 === 7) await breathe();
    }

    if (!picked.some(hasRealText)) {
      const n = picked.length;
      const subject =
        n === 1 ? "This page is a picture" : `All ${n} of these pages are pictures`;
      return (
        `${subject} with no text layer, which is what a scan or a phone photo ` +
        `looks like, so there is nothing to pull out. Getting the words off ` +
        `them needs OCR, and this tool does not do OCR.`
      );
    }

    return picked.join("\f\n");
  } finally {
    await opened.close();
  }
}

/* ------------------------------------------------------------------ */
/* A batch, in one download                                            */
/* ------------------------------------------------------------------ */

/**
 * Pack files into a zip.
 *
 * This uses fflate's callback API, not zipSync. Compressing 200 exported
 * pages on the main thread freezes the tab for long enough that the browser
 * offers to kill it, and the progress bar the user is watching never repaints.
 * The callback version does the work off the main thread.
 */
export async function zipFiles(
  files: Array<{ name: string; data: Uint8Array }>,
): Promise<Blob> {
  if (files.length === 0) {
    throw new PdfOpError(
      "There is nothing to put in the zip.",
      "Export at least one file first.",
    );
  }

  const entries: AsyncZippable = {};
  const used = new Set<string>();

  for (const [nth, file] of files.entries()) {
    const name = uniqueName(safeName(file.name), used);
    // Deflating a PNG or a JPEG buys back a rounding error and costs real
    // seconds, because those formats are already compressed. Store them
    // instead and spend the time on things that will actually shrink.
    entries[name] = [file.data, { level: alreadyPacked(name) ? 0 : 6 }];
    if (nth % 64 === 63) await breathe();
  }

  // The ArrayBuffer in the type argument is not decoration: Blob will not take
  // a view over a SharedArrayBuffer, which is what a bare Uint8Array widens to.
  const packed = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => {
      if (err) {
        reject(
          new PdfOpError(
            "The zip could not be built.",
            "This usually means the browser ran out of memory. Export fewer files at a time.",
          ),
        );
        return;
      }
      resolve(data);
    });
  });

  return new Blob([packed], { type: "application/zip" });
}

/* ------------------------------------------------------------------ */
/* Image sniffing                                                      */
/* ------------------------------------------------------------------ */

type ImageKind =
  | "png"
  | "jpeg"
  | "webp"
  | "heic"
  | "avif"
  | "gif"
  | "bmp"
  | "tiff"
  | "pdf"
  | "unknown";

/**
 * What a file really is, read from its first bytes.
 *
 * The extension is not evidence. Phones hand out .jpg files that are HEIC
 * inside, and browsers save .jpg files that are WEBP inside, so both of those
 * would otherwise fail deep in pdf-lib with a message about a missing marker.
 */
function sniffImage(bytes: Uint8Array): ImageKind {
  if (bytes.length < 12) return "unknown";
  const at = (i: number): number => bytes[i] ?? -1;

  if (
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "png";
  }

  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";

  // "RIFF" then four bytes of length then "WEBP".
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "webp";
  }

  // The ISO container both HEIC and AVIF sit in: a four byte box size, then
  // "ftyp", then the brand that says which one it is.
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = tag(bytes, 8);
    if (brand === "avif" || brand === "avis") return "avif";
    if (
      brand.startsWith("hei") ||
      brand.startsWith("hev") ||
      brand === "mif1" ||
      brand === "msf1"
    ) {
      return "heic";
    }
    return "unknown";
  }

  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "gif";
  if (at(0) === 0x42 && at(1) === 0x4d) return "bmp";
  if (
    (at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a && at(3) === 0x00) ||
    (at(0) === 0x4d && at(1) === 0x4d && at(2) === 0x00 && at(3) === 0x2a)
  ) {
    return "tiff";
  }
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return "pdf";

  return "unknown";
}

/** Four bytes read as lowercase text, for container brands. */
function tag(bytes: Uint8Array, offset: number): string {
  let out = "";
  for (let i = offset; i < offset + 4; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out.toLowerCase();
}

/** Formats a PDF simply cannot carry, and what to call them out loud. */
const NOT_EMBEDDABLE: Partial<Record<ImageKind, string>> = {
  webp: "WEBP",
  heic: "HEIC",
  avif: "AVIF",
  gif: "GIF",
  bmp: "BMP",
  tiff: "TIFF",
};

/**
 * How far a photo has to be turned to sit the way it was taken.
 *
 * A camera writes the sensor's own rows to the file and records how the body
 * was being held in tag 0x0112, so the pixels of an upright phone photo are
 * usually stored sideways. These are the eight tag values mapped to the turn
 * that undoes them, counterclockwise, which is the direction PDF counts in.
 * The four mirrored values keep their turn: flipping as well would need the
 * pixels re-encoded, and a mirrored photo at least reads the right way up.
 */
const EXIF_TURN: Record<number, 0 | 90 | 180 | 270> = {
  1: 0,
  2: 0,
  3: 180,
  4: 180,
  5: 90,
  6: 270,
  7: 270,
  8: 90,
};

/**
 * Read a JPEG's EXIF orientation tag, or 1 when there is not one to read.
 *
 * This walks the marker segments rather than searching for the bytes, because
 * "Exif\0\0" can occur inside compressed scan data and a search would find it
 * there. Anything malformed returns 1: a photo shown the way it was stored is
 * a much smaller wrong than a photo turned on a guess.
 */
function jpegOrientation(bytes: Uint8Array): number {
  if (bytes.byteLength < 4) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xffd8) return 1;

  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return 1; // out of step with the segments
    const marker = view.getUint8(at + 1);
    // Markers that carry no length field of their own.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // Start of scan or end of image. EXIF always comes before both.
    if (marker === 0xda || marker === 0xd9) return 1;

    const length = view.getUint16(at + 2);
    if (length < 2) return 1;
    if (marker === 0xe1) {
      const found = readExifOrientation(view, at + 4);
      if (found) return found;
    }
    at += 2 + length;
  }
  return 1;
}

/** The orientation inside one APP1 segment, or 0 if it is not in there. */
function readExifOrientation(view: DataView, start: number): number {
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  if (start + 6 + 8 > view.byteLength) return 0;
  for (let i = 0; i < 6; i++) {
    if (view.getUint8(start + i) !== header[i]) return 0;
  }

  // A TIFF header: byte order, the number 42 to prove it was read right, then
  // the offset of the first directory. Every offset counts from here.
  const tiff = start + 6;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return 0;
  const little = order === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 42) return 0;

  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd < tiff || ifd + 2 > view.byteLength) return 0;

  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > view.byteLength) return 0;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : 0;
  }
  return 0;
}

/**
 * Put one image into the document, or explain exactly why it will not go.
 *
 * PDF only knows two image codecs worth using: DCTDecode, which is JPEG, and
 * FlateDecode, which is what pdf-lib turns a PNG into. Everything else has to
 * be converted before it gets here, and there is no way to fake that in the
 * browser without pulling in a decoder for each format.
 *
 * The turn that comes back is the photo's own EXIF turn. PNG has no equivalent
 * tag that viewers agree on, so a PNG is always 0.
 */
async function embedImage(
  doc: PDFDocument,
  name: string,
  bytes: Uint8Array,
): Promise<{ image: PDFImage; turn: 0 | 90 | 180 | 270 }> {
  const kind = sniffImage(bytes);

  if (kind === "png" || kind === "jpeg") {
    // pdf-lib's JPEG reader builds a DataView over the whole backing buffer
    // and ignores the view's own offset, so a subarray would be read from the
    // wrong place. A fresh copy always starts at zero.
    const data = copyBytes(bytes);
    try {
      if (kind === "png") return { image: await doc.embedPng(data), turn: 0 };
      const turn = EXIF_TURN[jpegOrientation(data)] ?? 0;
      return { image: await doc.embedJpg(data), turn };
    } catch {
      throw new PdfOpError(
        `${name} starts like a ${kind === "png" ? "PNG" : "JPEG"} but the rest of the file is damaged.`,
        "Open it in an image viewer and save a fresh copy, then try again.",
      );
    }
  }

  const label = NOT_EMBEDDABLE[kind];
  if (label) {
    throw new PdfOpError(
      `${name} is a ${label} image, and a PDF cannot hold ${label}. Convert it to PNG or JPEG first.`,
      "Preview on a Mac and Photos on Windows both export to PNG and JPEG from the File menu.",
    );
  }

  if (kind === "pdf") {
    throw new PdfOpError(
      `${name} is a PDF, not an image.`,
      "Use Merge to join PDFs together.",
    );
  }

  throw new PdfOpError(
    `${name} is not an image this can read.`,
    "PNG and JPEG go straight in. Anything else has to be converted first.",
  );
}

/* ------------------------------------------------------------------ */
/* Small shared bits                                                   */
/* ------------------------------------------------------------------ */

function everyIndex(total: number): number[] {
  return Array.from({ length: total }, (_unused, i) => i);
}

/**
 * A page with a text layer has hundreds of characters on it. A scanned page
 * comes back empty, or with a stray character or two off a stamp, so eight is
 * comfortably below anything real and comfortably above the noise.
 */
function hasRealText(text: string): boolean {
  return text.replace(/\s+/g, "").length > 8;
}

/**
 * Keep names unique inside the archive.
 *
 * A zip is a flat map from name to bytes, so two files called page-01.png
 * would leave only one behind and the user would just get fewer files than
 * they asked for, with nothing to say why.
 */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** Formats that are compressed already, so deflating them is wasted time. */
function alreadyPacked(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|heic|avif|zip|mp4|mov|woff2?)$/i.test(name);
}
