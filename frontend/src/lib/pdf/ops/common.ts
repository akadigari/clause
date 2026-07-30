/**
 * The shape every edit in this app takes.
 *
 * An operation is a plain function: bytes in, bytes out. It never mutates its
 * input and never touches the UI. That buys three things worth more than the
 * memory it costs:
 *
 *   - Undo is a stack of byte arrays, with no diffing and nothing to get wrong.
 *   - Every operation can be tested on its own, with no browser.
 *   - Two operations can never corrupt each other by sharing a document.
 *
 * pdf-lib is about 400KB, so like pdf.js it is loaded the first time an edit
 * actually happens rather than on page load.
 */

import type { PDFDocument, PDFFont, PDFImage, PDFPage } from "pdf-lib";

type PdfLibModule = typeof import("pdf-lib");

let modulePromise: Promise<PdfLibModule> | null = null;

/** Load pdf-lib once, on first use. */
export function pdfLib(): Promise<PdfLibModule> {
  if (!modulePromise) modulePromise = import("pdf-lib");
  return modulePromise;
}

export type { PDFDocument, PDFFont, PDFImage, PDFPage };

/**
 * A problem worth showing the user, in words they can act on.
 *
 * Anything thrown from an operation that is not one of these is a bug, and the
 * UI says so rather than pretending it was the file's fault.
 */
export class PdfOpError extends Error {
  constructor(
    message: string,
    /** What the user can do about it, if anything. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PdfOpError";
  }
}

/**
 * Copy bytes before handing them to a library.
 *
 * Both pdf.js and any Worker transfer will detach the ArrayBuffer they are
 * given, which silently turns the caller's copy into a zero length array. The
 * bug that causes shows up much later, as an empty document, so every entry
 * point copies first.
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

/** True if these bytes actually start with a PDF header. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  );
}

/**
 * Open a PDF for editing.
 *
 * `ignoreEncryption` is on so the load itself does not throw, which lets us
 * tell the user something specific about the file instead of a parser message.
 * It is NOT permission to edit an encrypted document, and the check below is
 * the reason why.
 *
 * pdf-lib can parse past an encryption dictionary but it cannot decrypt the
 * page contents and it cannot re-encrypt on save. Editing anyway writes a file
 * with still-encrypted content streams and no /Encrypt dictionary saying so:
 * no error, no warning, and a document no reader on earth can open. Losing
 * someone's file that quietly is worse than refusing the job, so this refuses
 * the job.
 */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!looksLikePdf(bytes)) {
    throw new PdfOpError(
      "That file is not a PDF.",
      "It may have a .pdf name but different contents. Try opening it in another app to check.",
    );
  }
  const { PDFDocument } = await pdfLib();
  try {
    const doc = await PDFDocument.load(copyBytes(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    if (doc.isEncrypted) {
      throw new PdfOpError(
        "This PDF is protected, so editing it here would break it.",
        "Open it in a reader, save an unprotected copy, and bring that back. Nothing was changed.",
      );
    }
    return doc;
  } catch (err) {
    if (err instanceof PdfOpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/password|encrypt/i.test(message)) {
      throw new PdfOpError(
        "This PDF is password protected, so it cannot be edited.",
        "Open it in a reader, enter the password, and save an unprotected copy first.",
      );
    }
    throw new PdfOpError(
      "This PDF is damaged badly enough that it cannot be read.",
      "Some files are written incorrectly by the tool that made them. Re-exporting it often fixes this.",
    );
  }
}

/** Write a document back out to bytes. */
export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  // Object streams pack the file's internal bookkeeping more tightly. It is
  // the one size win available without touching the page content itself.
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}

/** Make a new empty document. */
export async function blankPdf(): Promise<PDFDocument> {
  const { PDFDocument } = await pdfLib();
  return PDFDocument.create();
}

/** How many pages, without loading the whole editing model twice. */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await loadPdf(bytes);
  return doc.getPageCount();
}

/**
 * Read a page's box and turn the same way, in the form geometry.ts expects.
 *
 * pdf-lib reports rotation as an object, and a page can legally carry any
 * multiple of 90 including negatives, so it is folded into the four values
 * the rest of the code handles.
 */
export function pageBoxOf(page: PDFPage): {
  originX: number;
  originY: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
} {
  const media = page.getMediaBox();
  const angle = page.getRotation().angle;
  const wrapped = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return {
    originX: media.x,
    originY: media.y,
    width: media.width,
    height: media.height,
    rotation: wrapped as 0 | 90 | 180 | 270,
  };
}

/**
 * Guard rails, so a hostile or simply enormous file fails with a sentence
 * instead of a frozen tab. These are deliberately generous: the point of this
 * tool is that it does not gate you the way the paid ones do.
 */
export const LIMITS = {
  /** Refuse to open beyond this. Browsers run out of memory well before it. */
  maxBytes: 500 * 1024 * 1024,
  /** Page operations stay responsive to about here. */
  maxPages: 5000,
  /** Rasterizing every page is slow, so warn past this instead of refusing. */
  warnRasterPages: 120,
};

export function checkSize(bytes: Uint8Array): void {
  if (bytes.byteLength > LIMITS.maxBytes) {
    throw new PdfOpError(
      `That file is ${Math.round(bytes.byteLength / 1048576)}MB, past the ${
        LIMITS.maxBytes / 1048576
      }MB this can handle.`,
      "Everything here runs in the browser tab, which has a memory ceiling a desktop app does not.",
    );
  }
}

/**
 * Yield to the browser between units of work.
 *
 * Any operation that loops over pages must call this every few pages,
 * otherwise the tab stops responding and the progress bar it is trying to
 * update never paints.
 */
export function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Progress reporting shared by every long operation. */
export type Progress = (done: number, total: number, label?: string) => void;

/**
 * Turn a validated page selection into indexes, or explain why it is empty.
 * Every operation that takes a page selection funnels through this so the
 * error wording is the same everywhere.
 */
export function requirePages(indexes: number[], total: number): number[] {
  const clean = [...new Set(indexes)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < total)
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    throw new PdfOpError(
      "No pages were selected.",
      "Pick at least one page in the strip on the left, or type a range like 1-3.",
    );
  }
  return clean;
}
