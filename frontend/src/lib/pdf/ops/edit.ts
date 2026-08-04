/**
 * Changing words that are already printed on a page.
 *
 * A PDF has no paragraph you can retype. A page is a list of drawing
 * instructions and a word is a set of glyphs pinned at fixed coordinates. So
 * changing text means two different things depending on whether the old glyphs
 * can be found and taken out, and this file does both and tells the caller
 * which one happened.
 *
 * FIRST it tries to cut. Pass `original` on an edit and excise.ts replays the
 * page's instructions, finds the run that starts exactly where that one does,
 * and empties the string it draws. Then it reopens the result and checks that
 * the words really are gone and that nothing else on the page moved. Only if
 * both hold does the cut count. Those runs come back in `removed`, and for
 * them the file genuinely stops saying what it said.
 *
 * WHEN THE CUT IS REFUSED it falls back to the old behaviour: paint a small
 * filled rectangle over the run and draw the new words on top. The old glyphs
 * are still underneath, still returned by every text extractor, search box and
 * copy-paste. Those runs come back in `covered`, and **whenever `covered` is
 * above zero the screen has to say so**, using COVER_NOT_REMOVED below.
 *
 * The cut refuses more often than you would guess, and refusing is the right
 * behaviour every time. Two runs starting in the same place cannot be told
 * apart. A run that begins wherever the previous one happened to stop has no
 * position of its own to match, and emptying the one before it would slide it
 * across the page. Getting either wrong damages a document silently, which is
 * far worse than leaving the old words in it and admitting that is what
 * happened.
 *
 * Neither path is a way to hide sensitive information on its own, because you
 * cannot tell by looking which one you got. Redact is still the tool for that:
 * it rasterizes the page, so the words stop existing rather than stopping being
 * findable, and redact.ts spells out what that costs.
 *
 * Two more limits, both of which the reader can see:
 *
 *   - The replacement is drawn in one of the fourteen fonts every PDF reader
 *     already carries. Most real documents embed their own typeface, so the
 *     new words will be close to the surrounding text rather than identical.
 *   - Nothing reflows. The run keeps the box it had. Text that is too long for
 *     that box gets shrunk to try to fit, and warned about when even that is
 *     not enough. The words after it do not shuffle along to make room and the
 *     line does not rewrap.
 *
 * Several small helpers below are the same ones stamp.ts uses. They are copied
 * rather than shared because stamp.ts keeps them private, and this file is not
 * allowed to change that file.
 */

import { exciseTextRun } from "./excise";
import {
  breathe,
  checkSize,
  loadPdf,
  pageBoxOf,
  pdfLib,
  PdfOpError,
  savePdf,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
  type Progress,
} from "./common";
import { viewRectToUser, viewToUser, type PageBox, type Rect } from "../geometry";

export type TextEdit = {
  page: number;
  /**
   * The box being covered, in VIEW space points.
   *
   * Two different shapes of box get handed in and they do NOT agree on where
   * the baseline is, so read `baseline` below before wiring this up:
   *
   *   - A raw run from pageTextPieces. Its height is one font size and its
   *     bottom edge IS the baseline, so descenders hang outside it.
   *   - A line from textblocks.ts, which is what the editor actually gives you
   *     when somebody clicks words on the page. groupIntoLines pads the height
   *     to 1.22 font sizes on purpose, so the box reaches past the baseline far
   *     enough to cover the tails on g, y and p. Its bottom edge is a fifth of
   *     a line BELOW the baseline.
   *
   * The line box is the better thing to cover. It just has to say where its
   * baseline is, or the new words land low and oversized.
   *
   * A block from findTextBlocks can be several lines tall. Pass one line at a
   * time. Nothing here wraps, so a rect three lines high would draw one line of
   * text at three lines' worth of size.
   */
  rect: Rect;
  /**
   * Points from the TOP of rect down to the baseline the old words sat on.
   *
   * TextLine already carries exactly this number, so a caller working from the
   * editor passes `line.baseline` and is done. Left out, this falls back to the
   * height of rect, which is right for a raw pageTextPieces run and wrong by
   * about a fifth of a line for anything from textblocks.ts.
   *
   * It also sets the default font size, because for both of those shapes the
   * distance from the top of the box to the baseline IS the font size.
   */
  baseline?: number;
  /** What it should say instead. Empty covers the old words and draws nothing. */
  text: string;
  /** Points. Defaults to the baseline offset, i.e. the old font size. */
  fontSize?: number;
  /** Hex. Defaults to black. */
  color?: string;
  /**
   * Hex fill for the rectangle painted over the old words. Defaults to white.
   * Nothing here samples the page, so on anything that is not white paper the
   * caller has to read the pixel under the run and pass it, or the correction
   * sits in a white box.
   */
  background?: string;
  font?: "sans" | "serif" | "mono";
  bold?: boolean;
  italic?: boolean;
  /** Horizontal squeeze from the original run, so a replacement of similar
   *  length occupies similar width. */
  squeeze?: number;
  /**
   * What the run says now.
   *
   * Supply it and this will first try to cut those words out of the content
   * stream, so the file stops saying them rather than stopping showing them.
   * The cut has to prove it removed the right words and moved nothing else, and
   * anything short of that falls back to painting over. Leave it out and the
   * cut is never attempted, because there would be no way to confirm the right
   * run was found.
   */
  original?: string;
};

export type EditResult = {
  bytes: Uint8Array;
  /** Runs that were replaced. */
  applied: number;
  /**
   * Runs whose old words were taken out of the content stream for good, so no
   * extractor can find them any more.
   */
  removed: number;
  /**
   * Runs that had to be painted over instead, because taking them out could
   * not be proved safe. For these, and only these, the old text is still in
   * the file. If this is above zero the screen has to say so.
   */
  covered: number;
  /** Warnings the UI must show, e.g. text wider than the space it replaces. */
  warnings: string[];
};

/**
 * How far the cover reaches past the run on every side, in points.
 *
 * Glyphs are drawn with anti-aliased edges, so a rectangle that stops exactly
 * on the reported box leaves a grey hairline where the old letters touched it.
 * Half a point swallows that and is still far too small to reach the line
 * above or below.
 *
 * It is deliberately not big enough to catch a descender. The tails on g, y and
 * p hang below the baseline, and a raw pageTextPieces run stops AT the
 * baseline, so covering those means growing the box by a fifth of a line, which
 * on tightly set text paints over the line below. The fix is not a bigger pad
 * here, it is to hand in a line box from textblocks.ts, which is already padded
 * to 1.22 font sizes for exactly this, together with its `baseline`.
 */
const COVER_PAD = 0.5;

/** The most this will shrink text to make it fit: 60% of the asked-for size. */
const MIN_SHRINK = 0.6;

/**
 * The two sentences the UI has to put in front of anyone using this.
 *
 * They are defined in `edit.messages.ts` and re-exported here. The panel shows
 * them before anything is applied, so it imports them from that file directly
 * and keeps this module, pdf-lib and the cutter out of its own chunk. See the
 * header of `edit.messages.ts`.
 */
export { COVER_NOT_REMOVED, OLD_TEXT_REMOVED } from "./edit.messages";

/**
 * Names one edit, so the cutting pass and the drawing pass agree on which run
 * they are talking about. Rounded, because these are floats off a viewer.
 */
function keyOf(edit: TextEdit): string {
  const r = edit.rect;
  return `${edit.page}:${Math.round(r.x)}:${Math.round(r.y)}`;
}

/** Edits per pause, so a long batch does not freeze the tab. */
const BREATHE_EVERY = 16;

/**
 * The built-in fonts, by family and by weight.
 *
 * Only these fourteen come free with every reader. Anything else has to be
 * embedded, which costs a few hundred KB per file, so this stays with the
 * built-ins and says plainly when the text asked for is outside what they can
 * draw.
 */
const FONT_KEYS = {
  sans: {
    regular: "Helvetica",
    bold: "HelveticaBold",
    italic: "HelveticaOblique",
    boldItalic: "HelveticaBoldOblique",
  },
  serif: {
    regular: "TimesRoman",
    bold: "TimesRomanBold",
    italic: "TimesRomanItalic",
    boldItalic: "TimesRomanBoldItalic",
  },
  mono: {
    regular: "Courier",
    bold: "CourierBold",
    italic: "CourierOblique",
    boldItalic: "CourierBoldOblique",
  },
} as const;

type FontFamily = keyof typeof FONT_KEYS;
type FontWeight = keyof (typeof FONT_KEYS)["sans"];

// ---------------------------------------------------------------------------
// Small shared helpers, mirroring stamp.ts
// ---------------------------------------------------------------------------

const HEX3 = /^[0-9a-fA-F]{3}$/;
const HEX6 = /^[0-9a-fA-F]{6}$/;

/**
 * A CSS hex string to the 0..1 channels pdf-lib wants.
 *
 * Three digit hex doubles each digit, so #f0a means #ff00aa. That is the CSS
 * rule rather than a shortcut, and getting it wrong shifts every colour.
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

/**
 * Turn one of pdf-lib's encoding failures into something a person can act on.
 *
 * The standard fonts are WinAnsi, so anything outside Western European throws
 * from deep inside the font embedder with a message about code points. Left
 * alone that reaches the user as a raw library error, which reads like a crash
 * in the app rather than a limit of the fonts.
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
 * The same scrubbing pdf-lib does on its way in, with every line break folded
 * to a space.
 *
 * A run of text is one line by definition, so a newline in a replacement is
 * somebody pasting a paragraph into a box that holds a phrase. Keeping the
 * break would push the second half down over whatever is under it, which looks
 * like a bug. A space keeps it on the line it belongs to, where the overflow
 * warning can be honest about it not fitting.
 */
function cleanForDrawing(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t|\u0085|\u2028|\u2029/g, "    ")
    .replace(/[\b\v]/g, "")
    .replace(/[\n\f\r]/g, " ");
}

/**
 * Reject a measurement that is not a real number.
 *
 * An empty number box in the UI parses to NaN and a runaway zoom to Infinity.
 * pdf-lib catches NaN itself but not Infinity: it writes the literal word into
 * the page, which produces a file no reader will open and no error to say so.
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

function familyOf(name: string | undefined): FontFamily {
  if (name === "serif" || name === "mono" || name === "sans") return name;
  if (name === undefined) return "sans";
  throw new PdfOpError(
    `"${name}" is not a font this has.`,
    "Choose sans, serif or mono.",
  );
}

/**
 * The box the reader is actually shown.
 *
 * pageBoxOf reports the MediaBox, which is the whole sheet. Readers display the
 * CropBox clipped to it, and pdf.js sizes its viewport the same way, so the
 * view space coordinates coming out of pageTextPieces are CropBox based. On
 * press ready files the two differ by tens of points, and measuring against the
 * wrong one puts every cover off by that much.
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

async function fontFor(
  doc: PDFDocument,
  cache: Map<string, PDFFont>,
  family: FontFamily,
  bold: boolean,
  italic: boolean,
): Promise<PDFFont> {
  const weight: FontWeight = bold
    ? italic
      ? "boldItalic"
      : "bold"
    : italic
      ? "italic"
      : "regular";
  const key = `${family}.${weight}`;
  const already = cache.get(key);
  if (already) return already;

  const { StandardFonts } = await pdfLib();
  const font = await doc.embedFont(StandardFonts[FONT_KEYS[family][weight]]);
  cache.set(key, font);
  return font;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Enough of the replacement to recognise it in a warning, on one line. */
function quoteForMessage(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 32 ? `${flat.slice(0, 31)}...` : flat;
}

// ---------------------------------------------------------------------------
// Fitting. Both of these are pure, so the UI can call them while the user is
// still typing without opening the document.
// ---------------------------------------------------------------------------

/**
 * Does this text fit the box the old words had, and by how much does it miss.
 *
 * The callback reports one character's width at a font size of ONE, which is
 * why it is named per em and not just width. That is the unit every font metric
 * table is written in, and it means the caller can memoize a per-character
 * lookup once and reuse it at any size. Handing in
 * `(c) => font.widthOfTextAtSize(c, size)` instead multiplies by the size
 * twice and reports everything as far too wide, so wrap the size out:
 * `(c) => font.widthOfTextAtSize(c, 1)`.
 *
 * Characters the callback cannot size count as nothing, because a fit check
 * that throws is worse than a fit check that is slightly optimistic.
 */
export function measureFit(
  text: string,
  rect: Rect,
  fontSize: number,
  widthOfCharPerEm: (c: string) => number,
): { fits: boolean; overflowPoints: number } {
  let ems = 0;
  for (const ch of text) {
    const w = widthOfCharPerEm(ch);
    if (Number.isFinite(w)) ems += w;
  }
  const width = ems * fontSize;
  const room = Math.abs(rect.width);
  const over = width - room;
  return { fits: !(over > 0), overflowPoints: over > 0 ? over : 0 };
}

/**
 * The largest size at or below startSize that fits, never smaller than the
 * floor.
 *
 * Shrinking has to stop somewhere. Text at 40% of the size around it does not
 * read as a correction, it reads as damage, so the floor is 60% and a
 * replacement that still does not fit comes back at the floor for the caller
 * to warn about.
 *
 * The search assumes width grows with size, which is true of every font, and
 * `measure` is called about twenty times rather than solved in one division
 * because a caller is free to hand in a measure that rounds or that adds
 * letter spacing.
 */
export function suggestFontSize(
  text: string,
  rect: Rect,
  startSize: number,
  measure: (t: string, size: number) => number,
): number {
  const room = Math.abs(rect.width);
  if (!(startSize > 0) || !(room > 0) || text === "") return startSize;
  if (measure(text, startSize) <= room) return startSize;

  let low = startSize * MIN_SHRINK;
  let high = startSize;
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    if (measure(text, mid) <= room) low = mid;
    else high = mid;
  }
  // Rounding down keeps whatever fit the search found, since rounding up can
  // undo it. The nudge is float slop: 12 * 0.6 is 7.199999999999999, and
  // without it a floor that was meant to be reachable comes back as 7.19.
  return Math.floor(low * 100 + 1e-6) / 100;
}

// ---------------------------------------------------------------------------
// Replacing
// ---------------------------------------------------------------------------

/** A squeeze of zero or less would collapse the text to nothing, so ignore it. */
function squeezeOf(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

/** Fold a rect that arrived with negative sides, and refuse one made of junk. */
function normalizeRect(rect: Rect | undefined): Rect {
  if (!rect || typeof rect !== "object") {
    throw new PdfOpError(
      "That edit has no box to work in.",
      "Click the words you want to change so the tool knows where they are.",
    );
  }
  const x = finite(rect.x, "The left edge of the text");
  const y = finite(rect.y, "The top edge of the text");
  const width = finite(rect.width, "The width of the text");
  const height = finite(rect.height, "The height of the text");
  return {
    x: width < 0 ? x + width : x,
    y: height < 0 ? y + height : y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}

/**
 * How far below the top of rect the old baseline sat.
 *
 * Falling back to the full height is what a raw pageTextPieces run wants, since
 * such a run stops at its own baseline. A caller that pads the box to catch
 * descenders has to say so, and a value that is not a usable length gets the
 * fallback rather than an error, because a slightly high baseline is a much
 * smaller problem than a batch that refuses to run.
 */
function baselineDrop(edit: TextEdit, rect: Rect): number {
  if (edit.baseline === undefined) return rect.height;
  const drop = finite(edit.baseline, "The baseline of the text");
  return drop > 0 ? drop : rect.height;
}

function pageIndexOf(edit: TextEdit, total: number): number {
  const index = edit.page;
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new PdfOpError(
      `Page ${Number.isFinite(index) ? index + 1 : "?"} is not in this document, which has ${total} ${
        total === 1 ? "page" : "pages"
      }.`,
      "Pages are counted from the document you have open right now, so this edit may be left over from a different one.",
    );
  }
  return index;
}

/**
 * Group by page, keeping the order the caller gave within each page.
 *
 * Every edit is checked here, before a single mark is made, so a batch with one
 * bad page number fails with nothing half done rather than leaving a document
 * that is part edited.
 */
function groupByPage(edits: TextEdit[], total: number): Array<[number, TextEdit[]]> {
  const groups = new Map<number, TextEdit[]>();
  for (const edit of edits) {
    const index = pageIndexOf(edit, total);
    const list = groups.get(index);
    if (list) list.push(edit);
    else groups.set(index, [edit]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * Cover the old words and draw the new ones.
 *
 * The document is opened once and every page is visited once, in order, so a
 * hundred corrections spread over a report cost the same load as one.
 */
export async function replaceText(
  bytes: Uint8Array,
  edits: TextEdit[],
  onProgress?: Progress,
): Promise<EditResult> {
  checkSize(bytes);
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new PdfOpError(
      "There are no changes to make.",
      "Pick a run of text on the page and type what it should say instead.",
    );
  }

  // Cut first, draw second.
  //
  // The cut works by replaying the page's instructions and matching a run by
  // where it starts. Drawing the replacements first would put new words on the
  // page for it to match against, so the order here is not a preference.
  const cutKeys = new Set<string>();
  let working = bytes;
  {
    let seen = 0;
    for (const edit of edits) {
      const original = typeof edit.original === "string" ? edit.original : "";
      if (original.trim() === "") continue;
      const rect = normalizeRect(edit.rect);
      if (!(rect.width > 0) || !(rect.height > 0)) continue;

      // Counted and reported only once a cut is actually going to be tried.
      // Reporting a step for work that is about to be skipped makes the bar
      // race to the end and then sit still through the slow part.
      seen += 1;
      onProgress?.(seen, edits.length, "Taking the old words out");

      const outcome = await exciseTextRun(working, {
        page: edit.page,
        rect,
        baseline: baselineDrop(edit, rect),
        text: original,
      });
      if (outcome.ok) {
        working = outcome.bytes;
        cutKeys.add(keyOf(edit));
      }
      if (seen % BREATHE_EVERY === 0) await breathe();
    }
  }

  const doc = await loadPdf(working);
  const grouped = groupByPage(edits, doc.getPageCount());

  const { rgb, degrees, pushGraphicsState, popGraphicsState, setCharacterSqueeze } =
    await pdfLib();
  const fonts = new Map<string, PDFFont>();
  const warnings: string[] = [];
  let applied = 0;
  let removed = 0;
  let covered = 0;
  let done = 0;

  for (const [index, group] of grouped) {
    const page = doc.getPage(index);
    const box = visibleBoxOf(page);

    for (const edit of group) {
      done += 1;
      const rect = normalizeRect(edit.rect);

      // A run with no area gives nothing to cover and no baseline to sit on.
      // Skipping it beats throwing, because the rest of the batch is fine.
      if (!(rect.width > 0) || !(rect.height > 0)) {
        warnings.push(
          `Page ${index + 1}: one of the runs picked has no size, so it was left alone.`,
        );
        onProgress?.(done, edits.length, "Replacing text");
        if (done % BREATHE_EVERY === 0) await breathe();
        continue;
      }

      // A run whose words were cut out needs nothing painted over it: there is
      // nothing left there to hide. Skipping the patch is what lets a
      // correction sit on a coloured background or an image without a white
      // box around it, which the covering path could never do.
      const wasCut = cutKeys.has(keyOf(edit));
      if (wasCut) removed += 1;
      else covered += 1;

      const cover = parseHexColor(edit.background ?? "#ffffff");
      // A quarter turn keeps an upright rectangle upright, it only swaps which
      // side is the width, and viewRectToUser has already done that swap. So
      // the cover needs no rotation of its own on any of the four pages.
      const patch = viewRectToUser(
        {
          x: rect.x - COVER_PAD,
          y: rect.y - COVER_PAD,
          width: rect.width + COVER_PAD * 2,
          height: rect.height + COVER_PAD * 2,
        },
        box,
      );
      if (!wasCut) {
        page.drawRectangle({
          x: patch.x,
          y: patch.y,
          width: patch.width,
          height: patch.height,
          color: rgb(cover.r, cover.g, cover.b),
        });
      }
      applied += 1;

      const text = cleanForDrawing(typeof edit.text === "string" ? edit.text : "");
      if (text === "") {
        onProgress?.(done, edits.length, "Replacing text");
        if (done % BREATHE_EVERY === 0) await breathe();
        continue;
      }

      const font = await fontFor(
        doc,
        fonts,
        familyOf(edit.font),
        edit.bold === true,
        edit.italic === true,
      );
      // Both the size and the baseline hang off this one number, which is why
      // it is worked out before either of them.
      const drop = baselineDrop(edit, rect);
      const asked = finite(edit.fontSize ?? drop, "The text size");
      if (!(asked > 0)) {
        throw new PdfOpError(
          "The text size has to be bigger than zero.",
          "Leave it blank to keep the size the old words were.",
        );
      }

      const squeeze = squeezeOf(edit.squeeze);
      const measure = (t: string, size: number) =>
        guardEncoding(() => font.widthOfTextAtSize(t, size)) * squeeze;

      let size = asked;
      const natural = measure(text, asked);
      if (natural > rect.width) {
        size = suggestFontSize(text, rect, asked, measure);
        const after = measure(text, size);
        const quote = quoteForMessage(text);
        warnings.push(
          after > rect.width
            ? `Page ${index + 1}: "${quote}" is ${round1(after - rect.width)}pt wider than the words it replaces even at ${round1(
                size,
              )}pt, the smallest this will shrink to. It will run into whatever comes next.`
            : `Page ${index + 1}: "${quote}" was wider than the words it replaces, so it was shrunk from ${round1(
                asked,
              )}pt to ${round1(size)}pt.`,
        );
      }

      const ink = parseHexColor(edit.color ?? "#000000");
      // pdf-lib anchors text at the start of the baseline, so the whole
      // placement question is one point: go down from the top of the box by the
      // baseline drop. Using the bottom of the box instead only happens to be
      // right when the box stops at the baseline, and a line box from
      // textblocks.ts does not: it is padded to 1.22 font sizes to cover
      // descenders, which would drop the new words a fifth of a line below the
      // rest of their line.
      const baseline = viewToUser({ x: rect.x, y: rect.y + drop }, box);

      // Tz is part of the graphics state, so setting it outside the text object
      // pdf-lib is about to write still applies to it, and the q/Q pair keeps it
      // from leaking onto the next edit.
      const condensed = squeeze !== 1;
      if (condensed) {
        page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze * 100));
      }
      guardEncoding(() =>
        page.drawText(text, {
          x: baseline.x,
          y: baseline.y,
          size,
          font,
          color: rgb(ink.r, ink.g, ink.b),
          rotate: degrees(box.rotation),
        }),
      );
      if (condensed) page.pushOperators(popGraphicsState());

      onProgress?.(done, edits.length, "Replacing text");
      if (done % BREATHE_EVERY === 0) await breathe();
    }
  }

  // COVER_NOT_REMOVED deliberately does NOT go in here. A warning means
  // something about the edit the person made needs their attention, and a
  // screen that shows warnings would start showing a standing disclaimer on
  // every run. `covered` is the fact; the UI decides what to say about it.
  return {
    bytes: await savePdf(doc),
    applied,
    removed,
    covered,
    warnings,
  };
}
