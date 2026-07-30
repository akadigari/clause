/**
 * Making files smaller, honestly.
 *
 * Read this before believing any compression claim, including this one.
 *
 * pdf-lib cannot recompress the image streams that are already inside a PDF.
 * It can read the structure of a file and write it back out, but it does not
 * decode a JPEG or a JBIG2 and it does not re-encode one. So there is no
 * lossless "compress" button available in a browser tab. A tool that promises
 * 70 percent off with no quality loss is either rewriting the images behind
 * your back or it is lying to you.
 *
 * What is actually on offer here is two different things, and the difference
 * matters enough that they are two functions with two names:
 *
 *   tidy     Lossless for everything on the page. Re-save the file with object
 *            streams so its internal bookkeeping is packed tighter, and rebuild
 *            it through copyPages so objects nothing points at anymore are
 *            dropped. Every pixel and every letter survives. On a file full of
 *            leftovers this saves real space. On a file that was already
 *            written well it saves nothing, and it says so.
 *
 *            The rebuild half carries pages and nothing above them, so a file
 *            holding anything at the document level that a reader would miss
 *            (form fields, bookmarks, attachments, layers, accessibility tags,
 *            roman-numeral page numbering) skips the rebuild and gets the plain
 *            re-save instead. See wouldBeLostByRebuild for the full list and
 *            for the two entries deliberately left off it.
 *
 *   flatten  Lossy, and permanent. Every page is rendered to a JPEG and the
 *            document is rebuilt out of those pictures. On a scan or anything
 *            image heavy this is the only thing in the browser that makes a
 *            genuine dent. On a text document it usually makes the file BIGGER,
 *            because the text was a few kilobytes of instructions and a picture
 *            of that text is a megabyte of pixels. It also destroys selectable
 *            text in every case, so search, copy and the Clause engine all stop
 *            working on the result.
 *
 * Both functions end at the same guard: if the new file is not smaller than the
 * one that came in, the original bytes are returned untouched and the warning
 * explains why. Nothing here ever hands back something bigger than it was
 * given and calls it a saving.
 */

import type { PDFDict } from "pdf-lib";

import { PAGE_SIZES } from "../geometry";
import {
  LIMITS,
  PdfOpError,
  blankPdf,
  breathe,
  checkSize,
  copyBytes,
  loadPdf,
  looksLikePdf,
  pdfLib,
  savePdf,
  type PDFDocument,
  type Progress,
} from "./common";

export type CompressResult = {
  /** The bytes to keep. Never larger than what was passed in. */
  bytes: Uint8Array;
  /** Size of the input, in bytes. */
  before: number;
  /** Size of `bytes`. Equal to `before` when the original was kept. */
  after: number;
  method: "tidy" | "flatten";
  /** Something the user needs to know before trusting the number. */
  warning?: string;
};

/** What flatten uses when the caller does not say. */
export const FLATTEN_DEFAULTS = { dpi: 120, quality: 0.7 } as const;

/**
 * Below this much saved, the result is smaller on paper and identical in
 * practice. Still worth keeping, not worth celebrating.
 */
export const BARELY_WORTH_IT = 0.01;

/** Browsers refuse to allocate a canvas with a side longer than this. */
const MAX_CANVAS_SIDE = 16384;

/** Sane dpi range for flattening. Past the top a single page blows the canvas. */
const DPI_RANGE = { min: 36, max: 400 } as const;

/**
 * Rough bytes per pixel for a JPEG of a document page at quality 0.7. Measured
 * off ordinary scans and text pages, and it is only a ballpark: a photo heavy
 * page runs about double this and a mostly white page about half. It exists so
 * the UI can say "about 40MB" before someone starts a ten minute job.
 */
const JPEG_BYTES_PER_PIXEL = 0.12;

/** PDF structure around each embedded image. Small, but not zero. */
const PAGE_OVERHEAD_BYTES = 1024;

/** Past this much rasterizing, the job needs a progress bar and a cancel. */
const SLOW_PIXELS = 100_000_000;

/**
 * The size comparison every compression path ends with.
 *
 * This is separated out and exported because it is the part that decides
 * whether the user gets a real saving or a polite refusal, and it is the only
 * part of compression that can be tested without a canvas.
 *
 * The rule is short: a candidate that is not strictly smaller is thrown away
 * and the original is handed back. `after` then equals `before`, so the UI
 * shows no change rather than a fake win.
 */
export function keepSmaller(
  original: Uint8Array,
  candidate: Uint8Array,
  method: CompressResult["method"],
  notes: {
    /** The candidate came out bigger or the same, so the original was kept. */
    worse: string;
    /** It did shrink, by an amount not worth the word "compressed". */
    barely?: string;
    /** It worked. Used to say what the saving cost, if anything. */
    better?: string;
  },
): CompressResult {
  const before = original.byteLength;
  const after = candidate.byteLength;

  if (after >= before) {
    // A copy, not the caller's own array. Whoever gets this may hand it to a
    // Worker or to pdf.js, and both of those detach the buffer they are given.
    return { bytes: copyBytes(original), before, after: before, method, warning: notes.worse };
  }

  const saved = (before - after) / before;
  const warning = saved < BARELY_WORTH_IT ? notes.barely : notes.better;
  return warning
    ? { bytes: candidate, before, after, method, warning }
    : { bytes: candidate, before, after, method };
}

/**
 * The lossless option: re-save and drop the leftovers.
 *
 * Two things happen, and neither one touches the content of a single page.
 * Object streams pack the file's bookkeeping into compressed blocks instead of
 * writing every small object out in the open. Rebuilding through copyPages
 * carries over only what the pages actually point at, so an object that some
 * earlier editor abandoned in the file does not make the trip.
 *
 * That second half is skipped for files with form fields or bookmarks, because
 * copyPages does not bring either one across. A file that loses its fillable
 * fields is not a smaller file, it is a broken one.
 */
export async function tidy(bytes: Uint8Array): Promise<CompressResult> {
  checkSize(bytes);
  const src = await loadPdf(bytes);
  const pages = src.getPageCount();
  if (pages === 0) {
    throw new PdfOpError(
      "This PDF has no pages, so there is nothing to tidy.",
      "The file may have been written incorrectly by whatever made it.",
    );
  }

  const fragile = await wouldBeLostByRebuild(src);
  let candidate: Uint8Array;
  let cost = "";

  if (fragile) {
    // Re-saving alone still gets the object stream win, which is most of it.
    candidate = await savePdf(src);
    cost = ` This file has ${fragile}, which a rebuild would throw away, so it was only re-saved.`;
  } else {
    candidate = await rebuild(src, pages);
  }

  // A signature is checked against the exact bytes it was made over, and both
  // paths above write new bytes. This is the one loss tidy cannot avoid by
  // taking a safer route, so it gets said out loud rather than filed under
  // "form fields".
  //
  // It is deliberately kept off the `worse` note. That branch hands the
  // original back untouched, and telling someone their signature broke when
  // nothing was replaced would be a lie in the frightening direction.
  const signed = (await hasSignature(src))
    ? " This file is digitally signed, and saving a PDF again always breaks the" +
      " signature, so the smaller copy will open as unsigned. Keep the original" +
      " if the signature is the point of the document."
    : "";

  return keepSmaller(bytes, candidate, "tidy", {
    worse: `Tidying came out bigger than the original, so the original was kept.${cost}`,
    barely: `Tidying saved almost nothing. This file was already packed tight, and the pictures inside a PDF cannot be recompressed in a browser without redrawing them.${cost}${signed}`,
    better: `${cost}${signed}`.trim() || undefined,
  });
}

/**
 * Rebuild a document from its pages, with the document level information that
 * matters carried across by hand.
 *
 * copyPages brings a page and everything the page points at. It does not bring
 * the Info dictionary, so without this the file would come out with a blank
 * title and pdf-lib's name stamped on it as the producer.
 */
async function rebuild(src: PDFDocument, pages: number): Promise<Uint8Array> {
  const out = await blankPdf();
  const indexes = Array.from({ length: pages }, (_, i) => i);
  const copied = await out.copyPages(src, indexes);
  for (const page of copied) out.addPage(page);
  carryMetadata(src, out);
  return savePdf(out);
}

/** Copy the Info dictionary fields, ignoring any the source wrote badly. */
function carryMetadata(src: PDFDocument, out: PDFDocument): void {
  const text = (read: () => string | undefined, write: (value: string) => void) => {
    try {
      const value = read();
      if (value) write(value);
    } catch {
      // A mis-encoded string in the source is not a reason to fail the whole
      // operation. Losing one field is the smaller loss.
    }
  };

  const when = (read: () => Date | undefined, write: (value: Date) => void) => {
    try {
      const value = read();
      if (value) write(value);
    } catch {
      // Same for a date written in a format the spec does not allow.
    }
  };

  text(() => src.getTitle(), (v) => out.setTitle(v));
  text(() => src.getAuthor(), (v) => out.setAuthor(v));
  text(() => src.getSubject(), (v) => out.setSubject(v));
  text(() => src.getCreator(), (v) => out.setCreator(v));
  text(() => src.getProducer(), (v) => out.setProducer(v));
  // Keywords go in as one string because that is how they come out. Splitting
  // on spaces would turn "force majeure" into two unrelated keywords.
  text(() => src.getKeywords(), (v) => out.setKeywords([v]));
  when(() => src.getCreationDate(), (v) => out.setCreationDate(v));
  when(() => src.getModificationDate(), (v) => out.setModificationDate(v));
}

/**
 * Name what a copyPages rebuild would silently drop, or null if nothing.
 *
 * copyPages copies a page and everything the page points at. Everything the
 * CATALOG points at is left behind, and that was measured, not assumed: a
 * document carrying attachments, page labels, a structure tree and optional
 * content came back out of a rebuild with a catalog holding /Type and /Pages
 * and nothing else. So each of those has to be looked for by hand, and a file
 * that has any of them takes the re-save path instead.
 *
 * Annotations ride along with their page, so links and comments are safe.
 *
 * Two catalog entries are knowingly left off this list, because guarding them
 * would push nearly every file made by Word or Acrobat onto the slow path and
 * neither one loses content:
 *
 *   /OpenAction, /PageLayout  where the file asks to be opened. Cosmetic.
 *   /Metadata                 the XMP copy of the Info dictionary. The Info
 *                             dictionary itself is carried by carryMetadata,
 *                             so the title and author survive either way.
 *
 * A signed file lands on the safe path already, because a signature lives in
 * an AcroForm field. That does not make the signature survive: pdf-lib rewrites
 * the whole file, and any full re-save breaks the byte ranges a signature is
 * computed over. There is no way to re-save a signed PDF and keep it signed.
 */
async function wouldBeLostByRebuild(doc: PDFDocument): Promise<string | null> {
  const { PDFName, PDFDict } = await pdfLib();
  const found: string[] = [];

  /** Present and worth worrying about. A missing or broken entry reads false. */
  const carries = (key: string, meaningful?: (value: PDFDict) => boolean): boolean => {
    try {
      const value = doc.catalog.lookupMaybe(PDFName.of(key), PDFDict);
      if (!value) return false;
      return meaningful ? meaningful(value) : true;
    } catch {
      // An entry written badly enough that it cannot be read is an entry a
      // reader cannot show either. Not a reason to fail, or to slow down.
      return false;
    }
  };

  try {
    const form = doc.catalog.getAcroForm();
    if ((form?.getAllFields().length ?? 0) > 0) found.push("form fields");
  } catch {
    // A broken AcroForm reads as no form. The rebuild path is still safe.
  }

  // An empty Outlines dictionary is common filler. Only a First entry means
  // there are bookmarks a reader would actually show.
  if (carries("Outlines", (o) => Boolean(o.get(PDFName.of("First"))))) {
    found.push("bookmarks");
  }

  // The name trees. EmbeddedFiles is the one that loses real user data: a lease
  // with its addendum attached comes back out as a lease.
  if (carries("Names", (n) => Boolean(n.get(PDFName.of("EmbeddedFiles"))))) {
    found.push("file attachments");
  }
  if (carries("Names", (n) => Boolean(n.get(PDFName.of("JavaScript"))))) {
    found.push("document scripts");
  }
  // Named destinations are what a link means by "go to Section 4". Losing the
  // tree leaves the links in place and pointing at nothing.
  if (carries("Names", (n) => Boolean(n.get(PDFName.of("Dests"))))) {
    found.push("named links");
  }
  if (carries("Dests")) found.push("named links");

  if (carries("StructTreeRoot")) found.push("accessibility tags");
  if (carries("OCProperties")) found.push("layers");
  if (carries("PageLabels")) found.push("page numbering");

  if (found.length === 0) return null;
  return listWords([...new Set(found)]);
}

/**
 * True if any form field is a signature field.
 *
 * Read non-destructively, the same way the check above is: doc.getForm() would
 * create an AcroForm on a file that has none, which is a write dressed up as a
 * read. FT is inheritable, so a signature field that leaves it to its parent
 * still has to be found.
 */
async function hasSignature(doc: PDFDocument): Promise<boolean> {
  const { PDFName } = await pdfLib();
  try {
    const form = doc.catalog.getAcroForm();
    if (!form) return false;
    return form
      .getAllFields()
      .some(([field]) => String(field.getInheritableAttribute(PDFName.of("FT"))) === "/Sig");
  } catch {
    return false;
  }
}

/** "a", "a and b", "a, b and c". Used inside a sentence shown to the user. */
function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The lossy option: turn every page into a picture.
 *
 * This is the only thing in this app that makes a scan meaningfully smaller,
 * and it is also the only operation here that cannot be undone by re-running
 * it. The text is gone afterwards. Not hidden, not covered: gone, because the
 * output has no text in it at all, only pixels.
 *
 * Sizes are taken from pdf.js at scale 1, which already folds in the page's
 * /Rotate. So each rendered image is upright and each new page is built at the
 * size the reader was looking at, with no rotation of its own.
 */
export async function flatten(
  bytes: Uint8Array,
  options: { dpi?: number; quality?: number; onProgress?: Progress } = {},
): Promise<CompressResult> {
  checkSize(bytes);
  if (!looksLikePdf(bytes)) {
    throw new PdfOpError(
      "That file is not a PDF.",
      "It may have a .pdf name but different contents. Try opening it in another app to check.",
    );
  }

  const dpi = clamp(options.dpi, FLATTEN_DEFAULTS.dpi, DPI_RANGE.min, DPI_RANGE.max);
  const quality = clamp(options.quality, FLATTEN_DEFAULTS.quality, 0.2, 1);
  const { onProgress } = options;

  // pdf.js is about a megabyte and only the raster path needs it, so tidy and
  // the size guard never pay for loading it.
  const { openForViewing, pageViewSize, renderPageToBlob } = await import("../viewer");

  // openForViewing hands back the document AND the handle that shuts it down,
  // because a PDFDocumentProxy has no destroy of its own and dropping one leaks
  // a worker thread per file. Read doc off the handle, close the handle.
  const open = await openForViewing(copyBytes(bytes));
  const doc = open.doc;
  try {
    const total = doc.numPages;
    if (total === 0) {
      throw new PdfOpError(
        "This PDF has no pages, so there is nothing to flatten.",
        "The file may have been written incorrectly by whatever made it.",
      );
    }
    if (total > LIMITS.maxPages) {
      throw new PdfOpError(
        `This file has ${total} pages, past the ${LIMITS.maxPages} that can be flattened at once.`,
        "Split it into smaller files first, then flatten each one.",
      );
    }

    const out = await blankPdf();

    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const size = pageViewSize(page, 1);
      const wide = Math.round((size.width / 72) * dpi);
      const tall = Math.round((size.height / 72) * dpi);
      if (wide > MAX_CANVAS_SIDE || tall > MAX_CANVAS_SIDE) {
        throw new PdfOpError(
          `Page ${n} would be ${wide} by ${tall} pixels at ${dpi} dpi, which is more than a browser will draw.`,
          "Try a lower dpi. 150 is plenty for reading and printing.",
        );
      }

      const blob = await renderPageToBlob(page, {
        dpi,
        type: "image/jpeg",
        quality,
        background: "#ffffff",
      });
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const image = await out.embedJpg(jpeg);
      const fresh = out.addPage([size.width, size.height]);
      fresh.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });

      page.cleanup();
      onProgress?.(n, total, `Page ${n} of ${total}`);
      await breathe();
    }

    const candidate = await savePdf(out);
    return keepSmaller(bytes, candidate, "flatten", {
      worse:
        "Flattening made this file bigger, so the original was kept. That is what happens to a text document: the text was a few kilobytes of instructions, and pictures of the same text are not.",
      barely:
        "Flattening saved almost nothing here, and the text is no longer selectable. Undo is probably the better call.",
      better:
        "Every page is a picture now, so the text can no longer be selected, searched or copied.",
    });
  } catch (err) {
    if (err instanceof PdfOpError) throw err;
    throw new PdfOpError(
      "This file could not be flattened.",
      "Flattening draws every page, and something on one of these pages defeated the drawing step. Tidy is the lossless option and it does not need to draw anything.",
    );
  } finally {
    // pdf.js keeps page data in the worker until the loading task is torn down,
    // and flattening a long document parks a lot of it there. close() swallows
    // its own failures, which matters: a throw in here would replace whatever
    // the try block was returning or throwing, and the user would get a
    // teardown error instead of the real one.
    await open.close();
  }
}

/**
 * What flattening is about to cost, before anyone commits to it.
 *
 * Page size is assumed to be Letter, because the count is all the UI has
 * before the file is open. A4 is within four percent of it, so the answer is
 * the right order of magnitude either way, which is all a warning needs.
 */
export function estimateFlatten(
  pageCount: number,
  dpi: number,
): { pixels: number; roughBytes: number; slow: boolean } {
  const pages = Number.isFinite(pageCount) ? Math.max(0, Math.floor(pageCount)) : 0;
  const clean = Number.isFinite(dpi) && dpi > 0 ? dpi : FLATTEN_DEFAULTS.dpi;

  const wideInches = PAGE_SIZES.letter.width / 72;
  const tallInches = PAGE_SIZES.letter.height / 72;
  const perPage = wideInches * clean * tallInches * clean;

  const pixels = Math.round(pages * perPage);
  const roughBytes = Math.round(pixels * JPEG_BYTES_PER_PIXEL + pages * PAGE_OVERHEAD_BYTES);
  const slow = pixels > SLOW_PIXELS || pages > LIMITS.warnRasterPages;

  return { pixels, roughBytes, slow };
}

/**
 * Hold a setting inside its range, falling back on nonsense.
 *
 * The fallback is the default, not the bottom of the range. Those are not the
 * same thing: a caller who passes a NaN dpi through from an empty text box
 * wants the setting it would have had, not 36 dpi output that looks like a fax,
 * and estimateFlatten falls back the same way so the size the UI promised is
 * the size the render aims at.
 */
function clamp(value: number | undefined, fallback: number, low: number, high: number): number {
  const start = Number.isFinite(value) ? (value as number) : fallback;
  return Math.min(Math.max(start, low), high);
}
