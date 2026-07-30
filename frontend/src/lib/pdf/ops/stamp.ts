/**
 * Putting new marks onto pages that already exist.
 *
 * Text, a signature image, a diagonal DRAFT across every page and a page
 * number in the corner are all the same job underneath: work out where the
 * reader wants the mark, turn that into the coordinates the PDF actually
 * stores, and draw.
 *
 * Two things make that harder than it sounds, and both are handled here once
 * so nothing else has to think about them.
 *
 * First, x and y arrive in VIEW space: origin top left, y growing downward, in
 * points, exactly the way the page looks on screen. What gets written into the
 * file is user space: origin at the corner of the box the reader is shown,
 * which is not always (0, 0), y growing upward, and /Rotate ignored.
 * geometry.ts owns that conversion, so every placement in this file boils down
 * to one call to viewToUser.
 *
 * That visible box is the CropBox, not the MediaBox. See visibleBoxOf below.
 *
 * Second, /Rotate turns the page clockwise when it is displayed. Content drawn
 * flat in user space therefore comes out sideways to the reader. Every mark is
 * turned by the page's own rotation to cancel that out. The derivation: a
 * clockwise display turn of R makes user-space angle t look like t - R on
 * screen, so t = R puts the mark upright again.
 */

import {
  breathe,
  checkSize,
  copyBytes,
  loadPdf,
  pageBoxOf,
  pdfLib,
  PdfOpError,
  requirePages,
  savePdf,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
} from "./common";
import { viewSize, viewToUser, type PageBox, type Point } from "../geometry";

export type Anchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type TextStamp = {
  pages: number[];
  text: string;
  /** View space, origin top left. The left edge of the text box. */
  x?: number;
  /** View space, y growing down. The top edge of the text box. */
  y?: number;
  anchor?: Anchor;
  margin?: number;
  size?: number;
  color?: string;
  opacity?: number;
  font?: "sans" | "serif" | "mono";
  bold?: boolean;
  /** Turn of the mark itself, counter clockwise as the reader sees it. */
  rotate?: number;
};

export type ImageStamp = {
  pages: number[];
  /** Raw PNG or JPEG bytes. Which one is read off the file itself. */
  image: Uint8Array;
  /** View space, origin top left. The top left corner of the image. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  opacity?: number;
};

export type WatermarkOptions = {
  pages?: number[];
  text: string;
  size?: number;
  color?: string;
  opacity?: number;
  /** Counter clockwise as the reader sees it. 45 runs bottom left to top right. */
  angle?: number;
};

export type PageNumberOptions = {
  pages?: number[];
  start?: number;
  anchor?: Anchor;
  margin?: number;
  size?: number;
  color?: string;
  /** Supports {n} and {total}, so "Page {n} of {total}" works. */
  format?: string;
};

/** Half an inch, the margin every word processor picks by default. */
const DEFAULT_MARGIN = 36;

/** Pages per pause. Long documents have to let the tab paint. */
const BREATHE_EVERY = 16;

/**
 * The built-in fonts, by family and weight.
 *
 * Only these fourteen come free with every PDF reader. Anything else has to be
 * embedded, which costs a few hundred KB, so this tool stays with the built-ins
 * and tells the user plainly when their text is outside what those cover.
 */
const FONT_KEYS = {
  sans: { regular: "Helvetica", bold: "HelveticaBold" },
  serif: { regular: "TimesRoman", bold: "TimesRomanBold" },
  mono: { regular: "Courier", bold: "CourierBold" },
} as const;

type FontFamily = keyof typeof FONT_KEYS;

type Measured = {
  /** Widest line, in points. */
  width: number;
  /** All lines stacked, in points. */
  height: number;
  lineHeight: number;
  /** Baseline to the top of the tallest letter. */
  ascent: number;
};

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const HEX3 = /^[0-9a-fA-F]{3}$/;
const HEX6 = /^[0-9a-fA-F]{6}$/;

/**
 * A CSS hex string to the 0..1 channels pdf-lib wants.
 *
 * Three digit hex doubles each digit, so #f0a means #ff00aa. That is the CSS
 * rule, not a shortcut, and getting it wrong shifts every colour slightly.
 */
function parseHexColor(input: string): { r: number; g: number; b: number } {
  const trimmed = typeof input === "string" ? input.trim() : "";
  const body = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;

  let full: string;
  if (HEX6.test(body)) {
    full = body;
  } else if (HEX3.test(body)) {
    full = body
      .split("")
      .map((c) => c + c)
      .join("");
  } else {
    throw new PdfOpError(
      `"${input}" is not a colour this understands.`,
      'Use a hex colour like "#ff0000" or the short form "#f00".',
    );
  }

  const value = parseInt(full, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}

// ---------------------------------------------------------------------------
// Text measuring and placement
// ---------------------------------------------------------------------------

/**
 * Turn one of pdf-lib's encoding failures into something a person can act on.
 *
 * The standard fonts are WinAnsi, so anything outside Western European throws
 * from deep inside the font embedder with a message about code points. Left
 * alone it reaches the user as a raw library error, which reads like a crash.
 */
function guardEncoding<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/cannot encode/i.test(message)) throw err;
    const match = /cannot encode "(.+?)"/.exec(message);
    const bad = match?.[1];
    throw new PdfOpError(
      bad
        ? `The built-in fonts cannot draw "${bad}".`
        : "The built-in fonts cannot draw one of those characters.",
      "They only cover Western European characters. Accents like é and ü are fine, but Chinese, Japanese, Korean, Arabic, Hebrew, Greek and Cyrillic are not. Use Latin text here.",
    );
  }
}

/**
 * The exact scrubbing pdf-lib does to a string before it draws it, plus a
 * Windows line break folded down to a single break.
 *
 * This has to exist because pdf-lib rewrites the text on the way in, and the
 * layout here has to measure what actually gets drawn rather than what was
 * handed over. pdf-lib turns a tab and the three Unicode separators into four
 * spaces, drops backspace and vertical tab, and only then splits on the
 * newline characters, one character at a time. Three things fall out of that:
 *
 *   - A carriage return followed by a newline is TWO breaks to pdf-lib and one
 *     break to a person, so text pasted out of Word or typed into a textarea
 *     came out with a blank line the layout never counted, and the block hung
 *     a full line below the box it had been fitted into.
 *   - A vertical tab is the mirror of that. pdf-lib deletes it, so it is not a
 *     break at all, but this file used to count one and reserve a line for it.
 *   - A tab never reaches the font, but measuring the raw string sent one
 *     straight to the encoder, which threw, which this file then reported as
 *     "the built-in fonts cannot draw that" and blamed Chinese and Arabic for
 *     an indented line of plain English.
 *
 * Running this once and using the result for BOTH the measuring and the
 * drawing is what keeps the two in step. Handing pdf-lib a string that has
 * already been through it is safe: there is nothing left for it to change.
 */
function cleanForDrawing(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t|\u0085|\u2028|\u2029/g, "    ")
    .replace(/[\b\v]/g, "");
}

/** Split the way pdf-lib splits. Only ever called on already cleaned text. */
function splitLines(text: string): string[] {
  return text.split(/[\n\f\r\u000B]/);
}

function measureText(font: PDFFont, lines: string[], size: number): Measured {
  const lineHeight = font.heightAtSize(size);
  const ascent = font.heightAtSize(size, { descender: false });
  let width = 0;
  for (const line of lines) {
    const w = guardEncoding(() => font.widthOfTextAtSize(line, size));
    if (w > width) width = w;
  }
  return { width, height: lines.length * lineHeight, lineHeight, ascent };
}

/**
 * Where a box of a given size sits when it is pinned to a corner.
 *
 * Everything here is view space, so "top" really is the top the reader sees
 * even on a page that has been turned sideways.
 */
function anchorPoint(
  anchor: Anchor,
  margin: number,
  view: { width: number; height: number },
  size: { width: number; height: number },
): Point {
  const left = margin;
  const midX = (view.width - size.width) / 2;
  const right = view.width - size.width - margin;
  const top = margin;
  const midY = (view.height - size.height) / 2;
  const bottom = view.height - size.height - margin;

  switch (anchor) {
    case "top-left":
      return { x: left, y: top };
    case "top-center":
      return { x: midX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "center":
      return { x: midX, y: midY };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom-center":
      return { x: midX, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    default:
      throw new PdfOpError(
        `"${String(anchor)}" is not a place on the page.`,
        "Pick one of top-left, top-center, top-right, center, bottom-left, bottom-center or bottom-right.",
      );
  }
}

/**
 * The first baseline, in user space, plus the turn to draw at.
 *
 * pdf-lib anchors text at the start of the first baseline and spins it about
 * that point, so the whole layout question reduces to finding one point. The
 * box is laid out unrotated, then spun about its own centre, which is what
 * people expect when they drag a rotation handle.
 *
 * View space has y going down, so a turn that looks counter clockwise on
 * screen flips the sign on the sine terms.
 */
function placeText(args: {
  topLeft: Point;
  measured: Measured;
  spin: number;
  box: PageBox;
}): { x: number; y: number; rotate: number } {
  const { topLeft, measured, spin, box } = args;
  const phi = (spin * Math.PI) / 180;
  const advance = { x: Math.cos(phi), y: -Math.sin(phi) };
  const up = { x: -Math.sin(phi), y: -Math.cos(phi) };

  const centre = {
    x: topLeft.x + measured.width / 2,
    y: topLeft.y + measured.height / 2,
  };
  // How far back along the "up" direction the first baseline sits from the
  // centre of the whole block.
  const back = measured.ascent - measured.height / 2;

  const baseline = {
    x: centre.x - (measured.width / 2) * advance.x - back * up.x,
    y: centre.y - (measured.width / 2) * advance.y - back * up.y,
  };

  const user = viewToUser(baseline, box);
  return { x: user.x, y: user.y, rotate: box.rotation + spin };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Reject a measurement that is not a real number.
 *
 * An empty number box in the UI parses to NaN and a runaway zoom to Infinity.
 * pdf-lib rejects NaN itself, but with a library error the UI is meant to
 * report as a bug rather than as bad input, and it does not check for Infinity
 * at all: it writes the literal word Infinity into the page, which produces a
 * file no reader will open and no error to say so. Both stop here.
 */
function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new PdfOpError(
      `${what} has to be a number.`,
      "Check the box you typed it into. It may be empty, or hold something that is not a number.",
    );
  }
  return value;
}

/** The same check for a setting that is allowed to be left out entirely. */
function finiteOrNone(value: number | undefined, what: string): number | undefined {
  return value === undefined ? undefined : finite(value, what);
}

/**
 * The box the reader is actually shown.
 *
 * pageBoxOf reports the MediaBox, which is the whole sheet of paper. Every
 * reader displays the CropBox instead, clipped to the MediaBox, and pdf.js
 * sizes its viewport the same way, so view space in this app is the CropBox.
 * On press ready files, and on anything scanned and then trimmed, the two
 * differ by tens of points, and a stamp placed against the MediaBox lands
 * outside the page the reader can see. Content still gets written in one user
 * space, so only the origin and the size change here.
 */
function visibleBoxOf(page: PDFPage): PageBox {
  const media = pageBoxOf(page);
  const crop = page.getCropBox();

  // Anything outside the MediaBox is ignored by every reader, per the spec, so
  // what the reader sees is the overlap of the two.
  const left = Math.max(media.originX, crop.x);
  const bottom = Math.max(media.originY, crop.y);
  const right = Math.min(media.originX + media.width, crop.x + crop.width);
  const top = Math.min(media.originY + media.height, crop.y + crop.height);

  // A CropBox that is backwards, empty or full of junk is worse than none.
  if (!(right > left) || !(top > bottom)) return media;

  return {
    originX: left,
    originY: bottom,
    width: right - left,
    height: top - bottom,
    rotation: media.rotation,
  };
}

/** pdf-lib only builds a graphics state when opacity is set, so skip a full 1. */
function opacityOption(value: number): number | undefined {
  return value < 1 ? value : undefined;
}

async function embedStandard(
  doc: PDFDocument,
  family: FontFamily,
  bold: boolean,
): Promise<PDFFont> {
  const { StandardFonts } = await pdfLib();
  const key = FONT_KEYS[family][bold ? "bold" : "regular"];
  return doc.embedFont(StandardFonts[key]);
}

function requireText(text: string, what: string): string {
  if (typeof text !== "string" || text.trim() === "") {
    throw new PdfOpError(`There is no ${what} to draw.`, "Type something first.");
  }
  return text;
}

function allPages(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i);
}

function familyOf(name: string | undefined): FontFamily {
  if (name === "serif" || name === "mono" || name === "sans") return name;
  if (name === undefined) return "sans";
  throw new PdfOpError(
    `"${name}" is not a font this has.`,
    "Choose sans, serif or mono.",
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export async function stampText(
  bytes: Uint8Array,
  stamp: TextStamp,
): Promise<Uint8Array> {
  checkSize(bytes);
  // Clean first, then check: a string of nothing but tabs is nothing to draw.
  const text = cleanForDrawing(requireText(stamp.text, "text"));
  requireText(text, "text");

  const doc = await loadPdf(bytes);
  const indexes = requirePages(stamp.pages ?? [], doc.getPageCount());

  const { rgb, degrees } = await pdfLib();
  const size = finite(stamp.size ?? 12, "Text size");
  if (!(size > 0)) {
    throw new PdfOpError("Text size has to be bigger than zero.", "Try 12.");
  }

  const font = await embedStandard(doc, familyOf(stamp.font), stamp.bold === true);
  const lines = splitLines(text);
  const measured = measureText(font, lines, size);
  const colour = parseHexColor(stamp.color ?? "#000000");
  const opacity = clampOpacity(stamp.opacity ?? 1);
  const margin = finite(stamp.margin ?? DEFAULT_MARGIN, "The margin");
  const spin = finite(stamp.rotate ?? 0, "The turn");
  const anchor = stamp.anchor ?? "top-left";
  const askedX = finiteOrNone(stamp.x, "The across position");
  const askedY = finiteOrNone(stamp.y, "The down position");

  let done = 0;
  for (const index of indexes) {
    const page = doc.getPage(index);
    const box = visibleBoxOf(page);
    const view = viewSize(box);

    // An explicit coordinate beats the anchor, one axis at a time, so giving
    // only x still lets the anchor decide the height.
    const fallback = anchorPoint(anchor, margin, view, measured);
    const topLeft = { x: askedX ?? fallback.x, y: askedY ?? fallback.y };

    const placed = placeText({ topLeft, measured, spin, box });
    guardEncoding(() =>
      page.drawText(text, {
        x: placed.x,
        y: placed.y,
        size,
        font,
        color: rgb(colour.r, colour.g, colour.b),
        rotate: degrees(placed.rotate),
        lineHeight: measured.lineHeight,
        opacity: opacityOption(opacity),
      }),
    );

    done += 1;
    if (done % BREATHE_EVERY === 0) await breathe();
  }

  return savePdf(doc);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Read the format off the bytes, not off whatever the caller claimed.
 *
 * File pickers and drag and drop both hand over a MIME type that comes from
 * the file extension, so a JPEG named .png arrives labelled as a PNG and
 * embedPng fails somewhere unhelpful.
 */
function sniffImage(image: Uint8Array): "png" | "jpg" {
  if (image.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => image[i] === b)) {
    return "png";
  }
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return "jpg";
  }
  throw new PdfOpError(
    "That image is not a PNG or a JPEG.",
    "Those are the only two formats a PDF can hold directly. Save it as one of them and try again.",
  );
}

export async function stampImage(
  bytes: Uint8Array,
  stamp: ImageStamp,
): Promise<Uint8Array> {
  checkSize(bytes);
  if (!stamp.image || stamp.image.length === 0) {
    throw new PdfOpError("There is no image to stamp.", "Pick a PNG or JPEG file.");
  }

  const doc = await loadPdf(bytes);
  const indexes = requirePages(stamp.pages ?? [], doc.getPageCount());
  const { degrees } = await pdfLib();

  const atX = finite(stamp.x, "The across position");
  const atY = finite(stamp.y, "The down position");

  const kind = sniffImage(stamp.image);
  const copy = copyBytes(stamp.image);
  let embedded;
  try {
    embedded = kind === "png" ? await doc.embedPng(copy) : await doc.embedJpg(copy);
  } catch {
    throw new PdfOpError(
      `That ${kind === "png" ? "PNG" : "JPEG"} could not be read.`,
      "The file may be truncated or saved in a variant PDFs cannot hold, such as a 16 bit or CMYK JPEG. Re-save it from an image editor.",
    );
  }

  if (!(embedded.width > 0) || !(embedded.height > 0)) {
    throw new PdfOpError("That image has no size.", "It may be an empty file.");
  }

  const askedW = finiteOrNone(stamp.width, "The image width");
  const askedH = finiteOrNone(stamp.height, "The image height");

  const ratio = embedded.height / embedded.width;
  let width: number;
  let height: number;
  if (askedW !== undefined && askedH !== undefined) {
    width = askedW;
    height = askedH;
  } else if (askedW !== undefined) {
    width = askedW;
    height = askedW * ratio;
  } else if (askedH !== undefined) {
    height = askedH;
    width = askedH / ratio;
  } else {
    width = embedded.width;
    height = embedded.height;
  }

  if (!(width > 0) || !(height > 0)) {
    throw new PdfOpError(
      "The image size has to be bigger than zero.",
      "Leave width and height off to use the image's own size.",
    );
  }

  const opacity = clampOpacity(stamp.opacity ?? 1);

  let done = 0;
  for (const index of indexes) {
    const page = doc.getPage(index);
    const box = visibleBoxOf(page);

    // drawImage anchors at the corner the reader sees as bottom left once the
    // page turn is cancelled out, and the caller gave the top left.
    const foot = viewToUser({ x: atX, y: atY + height }, box);
    page.drawImage(embedded, {
      x: foot.x,
      y: foot.y,
      width,
      height,
      rotate: degrees(box.rotation),
      opacity: opacityOption(opacity),
    });

    done += 1;
    if (done % BREATHE_EVERY === 0) await breathe();
  }

  return savePdf(doc);
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/**
 * How much to shrink so a turned block of text still fits the page.
 *
 * A block spun by phi covers a bigger upright box than it started with, and
 * "CONFIDENTIAL" at 48pt across an A5 page runs off both edges. Never grows,
 * only shrinks.
 */
function fitScale(
  measured: Measured,
  spin: number,
  view: { width: number; height: number },
): number {
  const phi = (spin * Math.PI) / 180;
  const c = Math.abs(Math.cos(phi));
  const s = Math.abs(Math.sin(phi));
  const spread = measured.width * c + measured.height * s;
  const rise = measured.width * s + measured.height * c;
  if (!(spread > 0) || !(rise > 0)) return 1;
  return Math.min(1, view.width / spread, view.height / rise);
}

export async function addWatermark(
  bytes: Uint8Array,
  options: WatermarkOptions,
): Promise<Uint8Array> {
  checkSize(bytes);
  const text = cleanForDrawing(requireText(options.text, "watermark"));
  requireText(text, "watermark");

  const doc = await loadPdf(bytes);
  const total = doc.getPageCount();
  const indexes = requirePages(options.pages ?? allPages(total), total);

  const { rgb, degrees } = await pdfLib();
  const baseSize = finite(options.size ?? 48, "Watermark size");
  if (!(baseSize > 0)) {
    throw new PdfOpError("Watermark size has to be bigger than zero.", "Try 48.");
  }

  const font = await embedStandard(doc, "sans", true);
  const lines = splitLines(text);
  const colour = parseHexColor(options.color ?? "#808080");
  const opacity = clampOpacity(options.opacity ?? 0.15);
  const spin = finite(options.angle ?? 45, "The watermark angle");

  let done = 0;
  for (const index of indexes) {
    const page = doc.getPage(index);
    const box = visibleBoxOf(page);
    const view = viewSize(box);

    // Measured once at the asked-for size to work out the shrink, then again
    // at the size that actually fits, because every width scales with it.
    const rough = measureText(font, lines, baseSize);
    const size = baseSize * fitScale(rough, spin, view);
    const measured = measureText(font, lines, size);

    const topLeft = anchorPoint("center", 0, view, measured);
    const placed = placeText({ topLeft, measured, spin, box });

    guardEncoding(() =>
      page.drawText(text, {
        x: placed.x,
        y: placed.y,
        size,
        font,
        color: rgb(colour.r, colour.g, colour.b),
        rotate: degrees(placed.rotate),
        lineHeight: measured.lineHeight,
        opacity: opacityOption(opacity),
      }),
    );

    done += 1;
    if (done % BREATHE_EVERY === 0) await breathe();
  }

  return savePdf(doc);
}

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------

/** Fill {n} and {total} in a page number format. */
function fillFormat(format: string, n: number, total: number): string {
  return format.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total));
}

export async function addPageNumbers(
  bytes: Uint8Array,
  options: PageNumberOptions,
): Promise<Uint8Array> {
  checkSize(bytes);

  const doc = await loadPdf(bytes);
  const total = doc.getPageCount();
  const indexes = requirePages(options.pages ?? allPages(total), total);

  const { rgb, degrees } = await pdfLib();
  const size = finite(options.size ?? 10, "Page number size");
  if (!(size > 0)) {
    throw new PdfOpError("Page number size has to be bigger than zero.", "Try 10.");
  }

  const font = await embedStandard(doc, "sans", false);
  const colour = parseHexColor(options.color ?? "#000000");
  const margin = finite(options.margin ?? DEFAULT_MARGIN, "The margin");
  const anchor = options.anchor ?? "bottom-center";
  const format = options.format ?? "{n}";
  // A page number is a whole number. 1.5 is not a page.
  const start = Math.round(finite(options.start ?? 1, "The first page number"));

  // {total} is the LAST number printed, not the document's page count and not
  // a count of the marked pages. Numbering pages 1, 3 and 5 gives "1 of 3",
  // and starting at 7 on five pages gives "7 of 11", which is what you want
  // when the numbering carries on from somewhere else.
  const highest = start + indexes.length - 1;

  for (let i = 0; i < indexes.length; i += 1) {
    const index = indexes[i];
    if (index === undefined) continue;
    const page = doc.getPage(index);
    const box = visibleBoxOf(page);
    const view = viewSize(box);

    const label = cleanForDrawing(fillFormat(format, start + i, highest));
    if (label === "") continue;
    const lines = splitLines(label);
    const measured = measureText(font, lines, size);

    const topLeft = anchorPoint(anchor, margin, view, measured);
    const placed = placeText({ topLeft, measured, spin: 0, box });

    guardEncoding(() =>
      page.drawText(label, {
        x: placed.x,
        y: placed.y,
        size,
        font,
        color: rgb(colour.r, colour.g, colour.b),
        rotate: degrees(placed.rotate),
        lineHeight: measured.lineHeight,
      }),
    );

    if ((i + 1) % BREATHE_EVERY === 0) await breathe();
  }

  return savePdf(doc);
}
