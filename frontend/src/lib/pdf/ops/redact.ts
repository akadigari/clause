/**
 * Redaction, meaning the words are gone.
 *
 * Read this part before changing anything in this file.
 *
 * A black rectangle drawn over text with pdf-lib is a picture of a redaction.
 * The letters are still in the content stream underneath it, so they are still
 * selectable, still searchable, still copy and pasteable, and still returned by
 * every text extractor ever written. Courts, police departments and government
 * ministries have all published documents redacted that way and then had the
 * names read straight out of them. It keeps happening because the file looks
 * right on screen. A tool that ships that and calls it redaction is worse than
 * a tool with no redaction at all, because the user stops being careful.
 *
 * So this does the only thing a browser can do that actually works: it paints
 * the boxes onto the rendered pixels of the page, before the image exists, and
 * then rebuilds that page in the output as that image. The text objects are not
 * hidden. They are not in the file. There is nothing left to extract because
 * the page is now a picture, and the part of the picture that held the words is
 * flat black.
 *
 * What that costs, on the redacted pages only:
 *
 *   - No selectable text. No search, no copy, no Clause citations.
 *   - No screen reader. The page is an image with no text behind it, so it is
 *     unreadable to anyone using assistive tech. This is a real accessibility
 *     loss and it is not undoable.
 *   - Vector sharpness is gone. At normal reading zoom a 200 dpi page looks
 *     like a document. Zoom a long way in and it looks like a scan.
 *   - The file gets bigger. Text is a few kilobytes of instructions and a
 *     picture of that text is a few hundred.
 *   - Annotations, comments and form fields on those pages do not come across.
 *
 * Every one of those is the price of the words being gone, and `redactionCost`
 * exists so the user is told all of it before they commit, not after.
 *
 * Pages with no boxes on them are copied through untouched, so a 90 page
 * contract with two redacted pages keeps 88 pages of real, selectable text.
 * One thing those pages do lose: the output is built as a fresh document, and
 * a fresh document has no /AcroForm, so a form field on a kept page keeps its
 * value and its drawn appearance but stops being fillable. That is data loss
 * on a page nobody asked to change, and `redactionCost` says so out loud.
 *
 * Two things this deliberately does NOT inherit from the original: the document
 * metadata and the outline. Titles and bookmarks routinely carry the exact name
 * being removed, so a fresh document is the safe start.
 */

import type { Rect } from "../geometry";
import type { OpenPdf, PDFDocumentProxy } from "../viewer";
import {
  LIMITS,
  PdfOpError,
  blankPdf,
  breathe,
  checkSize,
  copyBytes,
  loadPdf,
  savePdf,
  type Progress,
} from "./common";

/**
 * One rectangle to destroy, in VIEW space points: origin at the top left of the
 * page as the reader sees it, y growing downwards, /Rotate already folded in.
 * That is the space the mouse works in, so nothing has to be converted before
 * calling this. `page` is a zero based index, like everywhere else in the app.
 */
export type RedactBox = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RedactOptions = {
  boxes: RedactBox[];
  /** Dots per inch for the pages that get redrawn. Defaults to 200. */
  dpi?: number;
  onProgress?: Progress;
};

export type RedactResult = {
  bytes: Uint8Array;
  /** Zero based indexes of the pages that are now pictures. */
  pagesRasterized: number[];
  /**
   * True only when the output was reopened and every rasterized page came back
   * with no letters and no digits in it. False means either something survived
   * or the check could not be run, and in both cases the UI must not tell the
   * user the file is safe. `verifyRedaction` is the fuller receipt.
   */
  textRemoved: boolean;
};

/**
 * 200 dpi. High enough that the page still reads as a document rather than a
 * fax, low enough that a Letter page is 1700 by 2200 and not a memory problem.
 */
export const DEFAULT_REDACT_DPI = 200;

/** Below 72 the page is unreadable. Above 400 one page can blow the canvas. */
const DPI_RANGE = { min: 72, max: 400 } as const;

/** Browsers refuse to allocate a canvas with a side longer than this. */
const MAX_CANVAS_SIDE = 16384;

/**
 * JPEG at 0.92, not PNG.
 *
 * The worry people raise is whether a lossy encoder can leak what was under the
 * box. It cannot. The pixels were already destroyed on the canvas, so the
 * encoder never saw the words at all. What it does see is a flat black
 * rectangle, which is the cheapest thing in the world to encode. JPEG is here
 * because PNG on a scanned page runs to many megabytes each, and file size is
 * one of the costs the user is being asked to accept.
 */
const JPEG_QUALITY = 0.92;

/** Rough size of one redrawn page, per pixel. Measured on text pages at 0.92. */
const JPEG_BYTES_PER_PIXEL = 0.12;

// ---------------------------------------------------------------------------
// The pure parts. All the geometry and all the decisions live here, with no
// canvas and no document, so they can be tested without a browser.
// ---------------------------------------------------------------------------

/** Fold a drag into a rectangle with positive sides. */
export function normalizeRedactBox(box: RedactBox): RedactBox {
  return {
    page: box.page,
    x: box.width < 0 ? box.x + box.width : box.x,
    y: box.height < 0 ? box.y + box.height : box.y,
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

function requireFinite(box: RedactBox): void {
  const bad = [box.x, box.y, box.width, box.height].some((n) => !Number.isFinite(n));
  if (bad) {
    throw new PdfOpError(
      "One of the areas marked for redaction has a bad position or size.",
      "Nothing was changed. Clear the marks and draw them again.",
    );
  }
}

/**
 * Boxes sorted into the pages they belong to.
 *
 * A box on a page that does not exist is an error rather than something to drop
 * quietly. The whole failure mode this file exists to prevent is the user
 * believing something was removed when it was not, and silently ignoring a box
 * is that failure with extra steps. A box with no size is different: it covers
 * nothing on screen either, so nobody can believe it did anything, and it is
 * dropped.
 */
export function groupBoxesByPage(
  boxes: RedactBox[],
  pageCount: number,
): Map<number, RedactBox[]> {
  if (boxes.length === 0) {
    throw new PdfOpError(
      "Nothing is marked for redaction.",
      "Drag a box over the text you want removed, then run it again.",
    );
  }

  const grouped = new Map<number, RedactBox[]>();
  for (const raw of boxes) {
    if (!Number.isInteger(raw.page) || raw.page < 0 || raw.page >= pageCount) {
      const shown = Number.isInteger(raw.page) ? raw.page + 1 : String(raw.page);
      throw new PdfOpError(
        `An area is marked on page ${shown}, and this document has ${pageCount}.`,
        "Nothing was changed. A mark that cannot be applied is never dropped quietly, because you would go on believing it had been applied.",
      );
    }
    requireFinite(raw);
    const box = normalizeRedactBox(raw);
    if (box.width <= 0 || box.height <= 0) continue;
    const list = grouped.get(box.page);
    if (list) list.push(box);
    else grouped.set(box.page, [box]);
  }

  if (grouped.size === 0) {
    throw new PdfOpError(
      "Every area marked for redaction has no size.",
      "A click on its own does not mark anything. Drag across the text instead.",
    );
  }
  return grouped;
}

/** Which pages a set of boxes turns into pictures, in order. */
export function affectedPages(boxes: RedactBox[], pageCount: number): number[] {
  return [...groupBoxesByPage(boxes, pageCount).keys()].sort((a, b) => a - b);
}

/**
 * A box cut down to the part of it that is actually on the page. Null when it
 * misses the page entirely, which happens with a drag that ran off the edge.
 */
export function clipBoxToPage(
  box: RedactBox,
  view: { width: number; height: number },
): Rect | null {
  const b = normalizeRedactBox(box);
  const left = Math.max(0, b.x);
  const top = Math.max(0, b.y);
  const right = Math.min(view.width, b.x + b.width);
  const bottom = Math.min(view.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Every box on one page, clipped, with the ones that miss thrown away. */
export function clipBoxesToPage(
  boxes: RedactBox[],
  view: { width: number; height: number },
): Rect[] {
  const out: Rect[] = [];
  for (const box of boxes) {
    const clipped = clipBoxToPage(box, view);
    if (clipped) out.push(clipped);
  }
  return out;
}

/**
 * View space points to canvas pixels.
 *
 * Every edge is rounded outwards, so a box that lands halfway across a pixel
 * takes the whole pixel. Rounding the other way would leave a one pixel sliver
 * of the original letters showing along the edge of the black, which at 200 dpi
 * is enough to read a capital letter's crossbar off. Covering one pixel too
 * many costs nothing. Covering one too few costs the whole point of this file.
 */
export function toCanvasRects(
  rects: Rect[],
  scale: number,
  canvas: { width: number; height: number },
): Rect[] {
  const out: Rect[] = [];
  for (const r of rects) {
    const left = Math.max(0, Math.floor(r.x * scale));
    const top = Math.max(0, Math.floor(r.y * scale));
    const right = Math.min(canvas.width, Math.ceil((r.x + r.width) * scale));
    const bottom = Math.min(canvas.height, Math.ceil((r.y + r.height) * scale));
    if (right <= left || bottom <= top) continue;
    out.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return out;
}

/**
 * The pages that will actually be painted, and the pages whose marks landed
 * nowhere.
 *
 * `missed` is a page the user marked whose every box clipped away to nothing,
 * because the whole box was off the edge of the paper. That page is not the
 * same as a page nobody marked. Nobody marked page 4, so nobody expects page 4
 * to change. Somebody marked page 3, so somebody expects page 3 to change, and
 * shipping a file where it did not is the failure this module exists to stop.
 */
export type RedactPlan = {
  paint: Map<number, Rect[]>;
  /** Zero based, ascending. Marked pages where nothing landed on the paper. */
  missed: number[];
};

/**
 * Grouped boxes plus each page's view size, turned into the plan.
 *
 * Split out from `redact` and kept pure so the decision that a page is going to
 * be skipped can be tested without a canvas. A page with no view size at all is
 * counted as missed rather than silently skipped, for the same reason.
 */
export function planRedaction(
  grouped: Map<number, RedactBox[]>,
  views: Map<number, { width: number; height: number }>,
): RedactPlan {
  const paint = new Map<number, Rect[]>();
  const missed: number[] = [];
  for (const index of [...grouped.keys()].sort((a, b) => a - b)) {
    const view = views.get(index);
    const rects = view ? clipBoxesToPage(grouped.get(index) ?? [], view) : [];
    if (rects.length > 0) paint.set(index, rects);
    else missed.push(index);
  }
  return { paint, missed };
}

/**
 * True when a page that is supposed to be nothing but a picture still has a
 * letter or a digit in it.
 *
 * An image only page has no text at all, so this is a structural check rather
 * than a search for particular words. Anything coming back means a page did not
 * get replaced the way it should have.
 */
export function pageStillHasText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export type RedactionCost = {
  pagesRasterized: number;
  pagesKept: number;
  roughBytes: number;
  /** True when this is going to take long enough to need a warning. */
  slow: boolean;
  /** Plain English, meant to be shown before the user commits. */
  note: string;
};

/**
 * What this is about to cost, in words the user can act on.
 *
 * Page size is assumed to be Letter, because a count is all the UI has before
 * the file has been walked. A4 is within four percent of that, which is close
 * enough for a warning.
 */
export function redactionCost(
  pagesRasterized: number,
  totalPages: number,
  dpi: number = DEFAULT_REDACT_DPI,
): RedactionCost {
  const hit = Number.isFinite(pagesRasterized) ? Math.max(0, Math.floor(pagesRasterized)) : 0;
  const total = Number.isFinite(totalPages) ? Math.max(0, Math.floor(totalPages)) : 0;
  const clean = Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_REDACT_DPI;
  const kept = Math.max(0, total - hit);

  const perPage = (8.5 * clean) * (11 * clean);
  const roughBytes = Math.round(hit * perPage * JPEG_BYTES_PER_PIXEL);

  const parts = [
    `${hit} of ${total} ${hit === 1 ? "page becomes" : "pages become"} a picture at ${Math.round(clean)} dpi.`,
    "On those pages the words are gone for good: nothing left to select, search or copy, nothing for a screen reader to read out, and the page turns soft if you zoom a long way in.",
    "Comments and form fields on those pages go with them.",
  ];
  if (kept > 0) {
    parts.push(
      `The other ${kept} ${kept === 1 ? "page keeps its" : "pages keep their"} real text.`,
    );
    parts.push(
      "Form fields anywhere in the file stop being fillable, because the output is written as a fresh document and a fresh document has no form attached. The boxes still show what was typed in them.",
    );
  }
  parts.push(`Expect the redacted pages to add roughly ${Math.round(roughBytes / 1024)} KB.`);

  const slow = hit > LIMITS.warnRasterPages;
  if (slow) {
    parts.push(
      `Redrawing ${hit} pages takes a while, and the tab will be busy the whole time.`,
    );
  }

  return { pagesRasterized: hit, pagesKept: kept, roughBytes, slow, note: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Text matching for the receipt.
// ---------------------------------------------------------------------------

/**
 * Invisible characters that would otherwise break a match: soft hyphen, the
 * zero width family, word joiner, byte order mark.
 *
 * All four of these classes are written as escapes rather than literals. Half
 * of them are invisible on screen and the other half are impossible to tell
 * apart from plain ASCII quotes and hyphens, so a literal here is a character
 * nobody can review.
 */
const INVISIBLE = /[\u00ad\u200b\u200c\u200d\u2060\ufeff]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;
/** Hyphen through horizontal bar, plus the minus sign. */
const DASHES = /[\u2010-\u2015\u2212]/g;

/**
 * Flatten text so a phrase still matches the way a PDF actually stores it.
 *
 * PDF text comes out of pdf.js in runs, and a line break, a justified space or
 * a kerning gap can land anywhere. So all whitespace is removed rather than
 * collapsed, case is folded, ligatures and full width forms are normalised by
 * NFKC, curly quotes become straight ones and every dash becomes a hyphen.
 *
 * This is deliberately loose. It will occasionally say a phrase is present when
 * a human would say it is only nearly present. For a leak check that is the
 * right direction to be wrong in.
 */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, "")
    .toLowerCase();
}

type Haystack = { plain: string; dashless: string };

function makeHaystack(text: string): Haystack {
  const plain = normalizeForSearch(text);
  return { plain, dashless: plain.replace(/-/g, "") };
}

function inHaystack(hay: Haystack, phrase: string): boolean {
  const needle = normalizeForSearch(phrase);
  if (!needle) return false;
  if (hay.plain.includes(needle)) return true;
  // A word split across a line break leaves a stray hyphen behind once the
  // whitespace is gone, so "confid-ential" has to still match "confidential".
  const bare = needle.replace(/-/g, "");
  return bare.length > 0 && hay.dashless.includes(bare);
}

/** True when the phrase is readable in that text, allowing for PDF spacing. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  return inHaystack(makeHaystack(haystack), phrase);
}

/**
 * Phrases that were never in the original document to begin with.
 *
 * This matters more than it looks. Checking that a phrase is absent from the
 * output proves nothing if it was absent from the input too, and the usual
 * reasons for that are a typo, a different kind of apostrophe, or text that was
 * only ever a picture. A pass on one of those is a pass that could never have
 * failed, and reporting it as a clean bill of health is exactly the false
 * comfort this module exists to avoid.
 */
export function phrasesMissingFromSource(
  originalText: string[],
  phrases: string[],
): string[] {
  const hay = makeHaystack(originalText.join("\n"));
  const missing: string[] = [];
  for (const phrase of phrases) {
    if (!inHaystack(hay, phrase) && !missing.includes(phrase)) missing.push(phrase);
  }
  return missing;
}

/**
 * Every readable string pdf.js hangs off a page's annotations.
 *
 * This exists because `getTextContent` does not return any of it. A form field
 * value, a sticky note, a text callout and a link target all live in the
 * annotation list instead, and none of them show up in page text. So a document
 * whose tenant name is a filled in form field, on a page nobody marked and so a
 * page copied through untouched, came out of `verifyRedaction` reported clean
 * while the name was still sitting in the file for any form aware reader to
 * pull out. Confirmed against pdf-lib: `copyPages` brings the widget and its
 * parent field dictionary, value and all, into the output.
 *
 * Kept pure and separate from the document so it can be tested without pdf.js.
 * The shapes are pdf.js's: `getAnnotations` is typed `any[]`, and which keys are
 * present depends on the annotation subtype, so everything is probed by hand.
 */
export function annotationText(annotations: readonly unknown[]): string {
  const parts: string[] = [];

  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) parts.push(value);
    // A multi select field's value is an array of the chosen strings.
    else if (Array.isArray(value)) for (const item of value) push(item);
  };
  const pushStr = (holder: unknown): void => {
    if (typeof holder === "object" && holder !== null) {
      push((holder as Record<string, unknown>).str);
    }
  };

  for (const raw of annotations) {
    if (typeof raw !== "object" || raw === null) continue;
    const a = raw as Record<string, unknown>;

    // Form fields: what was typed, what the default was, which button is on,
    // and the field's own name, which is routinely the person.
    push(a.fieldValue);
    push(a.defaultFieldValue);
    push(a.buttonValue);
    push(a.fieldName);
    // Comments, callouts, stamps, and the accessibility text on all of them.
    push(a.alternativeText);
    push(a.url);
    push(a.unsafeUrl);
    pushStr(a.contentsObj);
    pushStr(a.titleObj);
    pushStr(a.richText);

    // Dropdown and list box choices.
    const options = a.options;
    if (Array.isArray(options)) {
      for (const option of options) {
        if (typeof option !== "object" || option === null) continue;
        push((option as Record<string, unknown>).exportValue);
        push((option as Record<string, unknown>).displayValue);
      }
    }
  }

  return parts.join("\n");
}

/**
 * The rule behind `clean`.
 *
 * Clean means: you asked about at least one phrase, every one of them really
 * was in the document before, and none of them is in it now. Anything short of
 * that is not a receipt, so it is not clean.
 */
export function isVerdictClean(
  phrases: string[],
  found: string[],
  missingFromSource: string[],
): boolean {
  return phrases.length > 0 && found.length === 0 && missingFromSource.length === 0;
}

// ---------------------------------------------------------------------------
// The browser part. Needs a canvas, so it cannot run under a node test.
// ---------------------------------------------------------------------------

function clampDpi(value: number | undefined): number {
  const wanted = value ?? DEFAULT_REDACT_DPI;
  if (!Number.isFinite(wanted)) return DEFAULT_REDACT_DPI;
  return Math.min(Math.max(wanted, DPI_RANGE.min), DPI_RANGE.max);
}

/**
 * Destroy the marked areas and rebuild those pages as images.
 *
 * Order of work matters here. The boxes are checked and the document is opened
 * with pdf-lib first, so a bad selection fails before a megabyte of pdf.js is
 * fetched and before anything is drawn.
 *
 * Everything from the pdf.js import onwards sits inside the guard, so that a
 * password protected file, a worker script that will not load, or a file
 * pdf-lib accepts and pdf.js refuses all come back as a sentence the user can
 * read. Outside the guard they came back as a raw library exception, which the
 * UI is required to treat as a bug in this app rather than a problem with the
 * file, so the user got blamed for the wrong thing.
 */
export async function redact(
  bytes: Uint8Array,
  options: RedactOptions,
): Promise<RedactResult> {
  checkSize(bytes);
  const dpi = clampDpi(options.dpi);
  const { onProgress } = options;

  const src = await loadPdf(bytes);
  const total = src.getPageCount();
  if (total > LIMITS.maxPages) {
    throw new PdfOpError(
      `This file has ${total} pages, past the ${LIMITS.maxPages} that can be worked on at once.`,
      "Split it into smaller files first, then redact each one.",
    );
  }
  const grouped = groupBoxesByPage(options.boxes, total);

  let opened: OpenPdf | null = null;
  try {
    // pdf.js is about a megabyte and only this path needs it.
    const { openForViewing, pageViewSize, renderPageToBlob } = await import("../viewer");
    opened = await openForViewing(copyBytes(bytes));
    const viewDoc = opened.doc;

    // First pass: measure every marked page, then decide from the measurements.
    const views = new Map<number, { width: number; height: number }>();
    for (const index of [...grouped.keys()].sort((a, b) => a - b)) {
      const page = await viewDoc.getPage(index + 1);
      const view = pageViewSize(page, 1);
      page.cleanup();
      views.set(index, view);

      const wide = Math.round((view.width / 72) * dpi);
      const tall = Math.round((view.height / 72) * dpi);
      if (wide > MAX_CANVAS_SIDE || tall > MAX_CANVAS_SIDE) {
        throw new PdfOpError(
          `Page ${index + 1} would be ${wide} by ${tall} pixels at ${dpi} dpi, which is more than a browser will draw.`,
          "Try a lower dpi. 150 still reads and prints fine.",
        );
      }
    }

    const { paint, missed } = planRedaction(grouped, views);
    if (missed.length > 0) {
      // This used to skip the page and carry on, which is the same mistake
      // groupBoxesByPage refuses to make one screen up: the summary counted the
      // page as redacted, the file kept its text, and nothing said so.
      const shown = missed.map((i) => i + 1).join(", ");
      throw new PdfOpError(
        missed.length === 1
          ? `Every area marked on page ${shown} is off the edge of the paper.`
          : `Every area marked on pages ${shown} is off the edge of the paper.`,
        "Nothing was changed. Those marks cover nothing, so the page would have kept all of its text while the summary told you it had been redacted.",
      );
    }
    if (paint.size === 0) {
      throw new PdfOpError(
        "None of the marked areas land on a page.",
        "Nothing was changed. The marks are off the edge of the paper, so there is nothing under them to remove.",
      );
    }

    const pagesRasterized = [...paint.keys()].sort((a, b) => a - b);
    const untouched: number[] = [];
    for (let i = 0; i < total; i++) {
      if (!paint.has(i)) untouched.push(i);
    }

    // One copyPages call for the whole document. Calling it per page would copy
    // the shared fonts again each time and bloat the output.
    const out = await blankPdf();
    const copied = untouched.length > 0 ? await out.copyPages(src, untouched) : [];
    let nextCopy = 0;

    for (let i = 0; i < total; i++) {
      const rects = paint.get(i);
      if (rects) {
        const page = await viewDoc.getPage(i + 1);
        const view = pageViewSize(page, 1);

        const blob = await renderPageToBlob(page, {
          dpi,
          type: "image/jpeg",
          quality: JPEG_QUALITY,
          background: "#ffffff",
          // This callback is the redaction. It runs after the page has been
          // drawn and before the image is made, so the black goes onto the
          // pixels themselves and what was underneath is not recoverable from
          // anything downstream.
          overpaint: (ctx, scale) => {
            const canvas = { width: ctx.canvas.width, height: ctx.canvas.height };
            const painted = toCanvasRects(rects, scale, canvas);
            if (painted.length === 0) {
              throw new PdfOpError(
                `The marked areas on page ${i + 1} did not land on the page that was drawn.`,
                "Nothing was written. Stopping is the only safe move here, because the alternative is a page saved as a picture with the words still showing in it.",
              );
            }

            ctx.save();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            ctx.fillStyle = "#000000";
            for (const r of painted) ctx.fillRect(r.x, r.y, r.width, r.height);
            ctx.restore();

            // Read the middle of every rectangle back off the canvas.
            //
            // This is the one failure that nothing downstream can catch. If the
            // fill did not land, the page still becomes a picture, the picture
            // still has no text in it, and so every text based check that
            // follows, including verifyRedaction, calls it clean while the
            // words sit there in plain sight. A pixel that is not black means
            // stop. So does a pixel that cannot be read at all, which is why
            // undefined fails this test too.
            for (const r of painted) {
              const px = Math.min(canvas.width - 1, r.x + Math.floor(r.width / 2));
              const py = Math.min(canvas.height - 1, r.y + Math.floor(r.height / 2));
              const dot = ctx.getImageData(px, py, 1, 1).data;
              if (dot[0] !== 0 || dot[1] !== 0 || dot[2] !== 0) {
                throw new PdfOpError(
                  `The black did not take on page ${i + 1}.`,
                  "Nothing was written. The browser accepted the drawing and then did not do it, so the file was not saved.",
                );
              }
            }
          },
        });

        const jpeg = new Uint8Array(await blob.arrayBuffer());
        const image = await out.embedJpg(jpeg);
        // Sizes come from pdf.js at scale 1, which already folds in /Rotate and
        // the page's own box offset. So the image is upright and the new page
        // is built at the size the reader was looking at, with no rotation and
        // no MediaBox origin of its own.
        const fresh = out.addPage([view.width, view.height]);
        fresh.drawImage(image, { x: 0, y: 0, width: view.width, height: view.height });

        page.cleanup();
        onProgress?.(i + 1, total, `Redrawing page ${i + 1} of ${total}`);
        await breathe();
      } else {
        const page = copied[nextCopy++];
        if (!page) throw new Error("redact: copied page missing, page plan is out of step");
        out.addPage(page);
        onProgress?.(i + 1, total, `Page ${i + 1} of ${total}`);
        if (i % 8 === 7) await breathe();
      }
    }

    const outBytes = await savePdf(out);
    const verdict = await rasterPagesTextCheck(outBytes, pagesRasterized);
    if (verdict === "words-survived") {
      // Not a "we are not sure". The file was reopened, a page that is meant to
      // be nothing but a picture was read, and there were words in it. That is
      // a redaction that did not happen, so it is a throw for the same reason
      // the pixel read back is a throw, and the bytes are not handed out.
      throw new PdfOpError(
        "A page that was redrawn as a picture still has readable text in it.",
        "Nothing was saved. The words were meant to be gone from that page and they are still there, so handing you the file would be handing you a document that looks redacted and is not.",
      );
    }
    return { bytes: outBytes, pagesRasterized, textRemoved: verdict === "clean" };
  } catch (err) {
    if (err instanceof PdfOpError) throw err;
    throw new PdfOpError(
      "These pages could not be redacted.",
      "Redaction has to draw every page it touches, and something on one of them defeated the drawing step. Nothing was changed, and the original is untouched.",
    );
  } finally {
    // pdf.js keeps a worker alive per document until the loading task is torn
    // down, so a long session leaks one thread per file without this.
    await opened?.close();
  }
}

/**
 * What happened when the finished file was reopened and the redrawn pages read.
 *
 *   - `clean`          every redrawn page came back with no text at all.
 *   - `words-survived` a redrawn page came back with words in it. Proven bad.
 *   - `unknown`        the check itself could not run. Not proven either way.
 *
 * These used to be one boolean, with `words-survived` and `unknown` both
 * reported as false. They are not the same thing and they do not deserve the
 * same handling: one is a file that must never be saved, the other is a file
 * that may well be fine but cannot be vouched for.
 */
export type RasterTextCheck = "clean" | "words-survived" | "unknown";

/** Reopen what was just written and read the redrawn pages back. */
async function rasterPagesTextCheck(
  outBytes: Uint8Array,
  indexes: number[],
): Promise<RasterTextCheck> {
  try {
    const { openForViewing, pageText } = await import("../viewer");
    const opened = await openForViewing(copyBytes(outBytes));
    try {
      for (const index of indexes) {
        const page = await opened.doc.getPage(index + 1);
        const text = await pageText(page);
        page.cleanup();
        if (pageStillHasText(text)) return "words-survived";
      }
      return "clean";
    } finally {
      await opened.close();
    }
  } catch {
    // Could not check. That is a "do not know", and a "do not know" reported as
    // a "yes" is the exact failure this whole file is built to prevent.
    return "unknown";
  }
}

/**
 * The receipt. Reopen the finished file and look for the words that were meant
 * to disappear.
 *
 * It reads every page, not only the redacted ones, because the same sentence is
 * often repeated in a header, a summary or an appendix and covering it once
 * proves nothing. It reads three things off each of those pages:
 *
 *   - The page text, which is what a reader selects and copies.
 *   - The annotations, which is where form field values, sticky notes, text
 *     callouts and link targets live. `getTextContent` returns none of that, so
 *     a version of this that only read page text called a document clean while
 *     the tenant's name sat in a filled in form field on a page that was copied
 *     through untouched. `copyPages` carries that field and its value into the
 *     output, so it really was still there and really was still extractable.
 *   - The document information dictionary and the XMP metadata, because a file
 *     whose title is "Complaint against Jane Roe" has not been redacted no
 *     matter what the pages say.
 *
 * What it cannot see, and nobody should claim otherwise:
 *
 *   - A word that is still visible as pixels. This is the important one. Every
 *     check in this file is a check on extractable text, and a redacted page is
 *     a picture, so a box in the wrong place leaves the word plainly readable
 *     and this function still says clean. Whether the black is over the right
 *     words is a question only a human looking at the output can answer.
 *   - Words inside an embedded attachment.
 *   - Words that were only ever pixels in a scan, which no extractor can read.
 *
 * Old revisions are not a worry here, because pdf-lib writes a whole new file
 * rather than appending to the original the way an incremental save would.
 *
 * `clean` is true only when every phrase asked about was genuinely in the
 * original and is genuinely gone now. See `isVerdictClean`.
 */
export async function verifyRedaction(
  originalText: string[],
  redactedBytes: Uint8Array,
  phrases: string[],
): Promise<{ clean: boolean; found: string[] }> {
  let haystack: Haystack;
  try {
    // Inside the guard, so that a viewer chunk that will not load fails as the
    // honest "could not be checked" below instead of as a raw module error.
    const { openForViewing, allPageText } = await import("../viewer");
    const opened = await openForViewing(copyBytes(redactedBytes));
    try {
      const pages = await allPageText(opened.doc);
      const annots = await allAnnotationText(opened.doc);
      const meta = await metadataText(opened.doc);
      haystack = makeHaystack(`${pages.join("\n")}\n${annots}\n${meta}`);
    } finally {
      await opened.close();
    }
  } catch {
    // The one thing that must never happen here is a quiet clean bill of
    // health, so a check that could not run is an error the user sees rather
    // than a result they act on.
    throw new PdfOpError(
      "The redacted file could not be checked.",
      "It was written, but it could not be reopened and read back, so nothing here can tell you whether the words are gone. Do not send it until you have opened it yourself and tried to select them.",
    );
  }

  const found: string[] = [];
  for (const phrase of phrases) {
    if (inHaystack(haystack, phrase) && !found.includes(phrase)) found.push(phrase);
  }

  const missing = phrasesMissingFromSource(originalText, phrases);
  return { clean: isVerdictClean(phrases, found, missing), found };
}

/**
 * Every annotation on every page, as one searchable string.
 *
 * A page whose annotations cannot be read is deliberately allowed to throw
 * rather than contribute an empty string. `verifyRedaction` turns that into
 * "could not be checked", which is the truth. Swallowing it would produce a
 * clean verdict built on a part of the file nobody actually looked at.
 */
async function allAnnotationText(doc: PDFDocumentProxy): Promise<string> {
  const parts: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    parts.push(annotationText(await page.getAnnotations()));
    page.cleanup();
  }
  return parts.join("\n");
}

/**
 * Title, author, keywords and the raw XMP packet, as one searchable string.
 *
 * No try/catch here on purpose. This is part of a receipt, and a receipt that
 * quietly reports an unread section as empty is how a clean verdict gets issued
 * over a part of the file nobody looked at. A failure belongs to the caller's
 * "could not be checked" path.
 */
async function metadataText(doc: PDFDocumentProxy): Promise<string> {
  const { info, metadata } = await doc.getMetadata();
  const parts: string[] = [];
  for (const value of Object.values(info as unknown as Record<string, unknown>)) {
    if (typeof value === "string") parts.push(value);
  }
  const raw: unknown = metadata?.getRaw();
  if (typeof raw === "string") parts.push(raw);
  return parts.join("\n");
}
