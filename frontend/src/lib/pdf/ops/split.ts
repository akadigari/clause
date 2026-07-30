/**
 * Cutting one document into several.
 *
 * The three entry points here are the same operation wearing different
 * clothes. Each one works out a list of page groups, and every group becomes
 * one new PDF. `splitAt` is the one the UI drives, because the page strip
 * shows cut marks in the gaps between pages and a cut mark is exactly "cut
 * after this page".
 *
 * The one number worth being careful about is what a cut point means.
 * `cutAfter` holds page indexes, and the cut lands after that page, so
 * splitting a 10 page document at [2, 5] gives pages 1-3, then 4-6, then
 * 7-10. Index 2 is the third page, and it is the last page of the first part,
 * not the first page of the second.
 *
 * **A part is cleaned up before it is written.** `copyPages` copies a page by
 * following every reference on it, and two of those references point at other
 * pages: a link annotation names the page it jumps to, and a form widget names
 * the page it sits on. Following them drags whole pages, text and all, into a
 * file that was supposed to have been cut away from them. See `dropStrayPages`
 * and `dropUnreachable`, which is the pair that makes "split off page 1 and
 * send it" mean what it says.
 *
 * **Form fields are put back by hand**, the same way `merge.ts` does it and for
 * the same reason: nothing copies the /AcroForm, so without this the boxes in
 * every part look right and are dead.
 *
 * What a part does not get: bookmarks, page labels, the tagged reading order,
 * and named destinations. Those live on the source catalog and cannot be
 * carried over a cut without deciding what a bookmark to a page in another part
 * should mean. Links that point outside a part are left in place but made
 * inert, so nothing in a part claims to lead somewhere it does not.
 */

import type { PDFObject, PDFRef } from "pdf-lib";
import { pageNo, plural, safeName } from "../../format";
import {
  blankPdf,
  breathe,
  checkSize,
  loadPdf,
  LIMITS,
  PdfOpError,
  pdfLib,
  requirePages,
  savePdf,
  type PDFDocument,
  type PDFPage,
  type Progress,
} from "./common";

/** One finished piece: a file name, the bytes, and which source pages it holds. */
export type SplitPart = { name: string; bytes: Uint8Array; pages: number[] };

/** Goes in the Producer field, which means "the tool that wrote this file". */
const PRODUCER = "Clause (in-browser PDF workbench)";

/**
 * Cut after each of the given page indexes.
 *
 * Cut points are cleaned up rather than rejected, because they come from
 * clicks in the page strip and the user does not think of them as a sorted
 * list. Duplicates collapse, order does not matter, and a cut after the last
 * page is dropped because there are no pages behind it to put in a part.
 */
export async function splitAt(
  bytes: Uint8Array,
  cutAfter: number[],
  baseName: string,
  onProgress?: Progress,
): Promise<SplitPart[]> {
  const src = await openSource(bytes);
  const count = src.getPageCount();

  const cuts = [...new Set(cutAfter)]
    .filter((cut) => Number.isInteger(cut) && cut >= 0 && cut < count - 1)
    .sort((a, b) => a - b);

  const groups: number[][] = [];
  let start = 0;
  for (const cut of cuts) {
    groups.push(pageRange(start, cut));
    start = cut + 1;
  }
  // Every surviving cut is before the last page, so there is always one more
  // part after the final cut and it always has something in it.
  groups.push(pageRange(start, count - 1));

  return partsFrom(src, groups, baseName, onProgress);
}

/**
 * Break the document into runs of `size` pages.
 *
 * A size of 1 is the common "one file per page" case, and the last part is
 * short whenever the page count does not divide evenly.
 */
export async function splitEvery(
  bytes: Uint8Array,
  size: number,
  baseName: string,
  onProgress?: Progress,
): Promise<SplitPart[]> {
  if (!Number.isInteger(size) || size < 1) {
    throw new PdfOpError(
      `A part cannot be ${size} pages long.`,
      "Use a whole number of pages, one or more.",
    );
  }

  const src = await openSource(bytes);
  const count = src.getPageCount();

  const groups: number[][] = [];
  for (let start = 0; start < count; start += size) {
    groups.push(pageRange(start, Math.min(start + size - 1, count - 1)));
  }

  return partsFrom(src, groups, baseName, onProgress);
}

/**
 * Build parts from explicit groups of page indexes.
 *
 * Groups are allowed to overlap. Wanting the signature page in both the
 * summary and the full copy is a real thing people do, so the same page can
 * land in more than one output. Inside a group the pages always come out in
 * document order, since reordering pages is its own operation.
 *
 * Unlike `splitAt`, a page number that does not exist is an error rather than
 * something to quietly drop. These groups are typed or built by a caller, not
 * clicked, so `[0, 99]` on a three page document means somebody counted wrong,
 * and handing back a part with one page in it would hide that.
 */
export async function splitByRanges(
  bytes: Uint8Array,
  ranges: number[][],
  baseName: string,
  onProgress?: Progress,
): Promise<SplitPart[]> {
  if (ranges.length === 0) {
    throw new PdfOpError(
      "No parts were given.",
      "Say at least one group of pages to pull out.",
    );
  }

  const src = await openSource(bytes);
  const count = src.getPageCount();

  const groups = ranges.map((group, i) => {
    // An empty part would write a zero page PDF, which most readers refuse to
    // open. It is a mistake in the caller, so it is worth saying out loud.
    if (group.length === 0) {
      throw new PdfOpError(
        `Part ${i + 1} has no pages in it.`,
        "Every part needs at least one page.",
      );
    }
    const missing = group.filter(
      (page) => !Number.isInteger(page) || page < 0 || page >= count,
    );
    if (missing.length > 0) {
      throw new PdfOpError(
        `Part ${i + 1} asks for ${plural(missing.length, "a page", "pages")} this document does not have.`,
        `This document has ${count} ${plural(count, "page")}, numbered 1 to ${count}.`,
      );
    }
    // Everything is in range by now, so this only sorts and removes repeats.
    return requirePages(group, count);
  });

  return partsFrom(src, groups, baseName, onProgress);
}

/**
 * Open the source once and hold it open.
 *
 * Every part copies out of this same document, so parsing it once instead of
 * once per part is the whole saving. pdf-lib builds a fresh copier for every
 * `copyPages` call, so nothing is cached between parts and each part carries
 * its own copy of any font it uses.
 */
async function openSource(bytes: Uint8Array): Promise<PDFDocument> {
  checkSize(bytes);
  const src = await loadPdf(bytes);
  const count = src.getPageCount();

  if (count === 0) {
    throw new PdfOpError(
      "That PDF has no pages, so there is nothing to split.",
      "The file opened, but it is empty. The tool that wrote it may have failed part way.",
    );
  }
  if (count > LIMITS.maxPages) {
    throw new PdfOpError(
      `That PDF has ${count} pages, past the ${LIMITS.maxPages} this can split at once.`,
      "Split it in halves with a page range first, then split each half.",
    );
  }
  return src;
}

/** Every index from `from` to `to`, both ends included. */
function pageRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** Turn each group of pages into a finished PDF. */
async function partsFrom(
  src: PDFDocument,
  groups: number[][],
  base: string,
  onProgress?: Progress,
): Promise<SplitPart[]> {
  const total = groups.length;
  const out: SplitPart[] = [];
  onProgress?.(0, total);

  for (const [i, pages] of groups.entries()) {
    // Writing a PDF is the slow part, so let the tab paint between parts.
    if (i > 0) await breathe();

    const doc = await blankPdf();
    // copyPages is the only way to move a page between documents. Handing the
    // page object over directly leaves its fonts and images behind.
    const copied = await doc.copyPages(src, pages);
    for (const page of copied) doc.addPage(page);

    await dropStrayPages(doc, copied);
    await rescueFields(doc, src, copied);
    carryMetadata(src, doc, base, i, total);
    // Last, so that everything above has had its say about what is in use.
    await dropUnreachable(doc);

    const name = partName(base, i, total);
    out.push({ name, bytes: await savePdf(doc), pages: [...pages] });
    onProgress?.(i + 1, total, name);
  }

  return out;
}

/* ---------------------------------------------------------------------------
 * Cleaning up after copyPages
 * ------------------------------------------------------------------------ */

/**
 * Take the pages that were cut away back out of the part.
 *
 * This is the one in here worth reading, because the failure is invisible and
 * it is a privacy failure rather than a cosmetic one. Measured against pdf-lib
 * 1.17.1:
 *
 *   1. `copyPages` copies a page by cloning its dictionary and then following
 *      every reference it holds. That is what makes fonts and images work.
 *   2. Two ordinary things on a page hold a reference to another page: a link
 *      annotation names the page it jumps to, and a form widget names the page
 *      it sits on in /P.
 *   3. Following one of those copies that whole page, content stream included,
 *      into the new document. It is not in the page tree, so it does not show
 *      and the page count is right, but every word of it is sitting in the file
 *      and comes straight back out of any PDF reader. Cutting page 1 off a
 *      contract to send to somebody, and shipping page 12 inside it because
 *      page 1 had a link to it, is the shape this bug takes for a real person.
 *   4. It happens to a page copied onto itself as well: a widget's /P makes a
 *      second copy of its own page, so files with forms get quietly bigger.
 *
 * A stray page that shares a content stream with a page this part kept is a
 * second copy of that page, so whatever pointed at it is pointed at the real
 * one instead. That is what keeps a link inside a part working, and what keeps
 * a widget's /P correct. Everything else becomes null, which is a link that
 * does nothing rather than a link that lies. `dropUnreachable` then takes the
 * strays themselves out of the file.
 *
 * Two kept pages that share one content stream are indistinguishable here, and
 * a link to one may land on the other. They are the same page to look at, so
 * that is the cheap end of a trade worth making.
 */
async function dropStrayPages(part: PDFDocument, kept: PDFPage[]): Promise<void> {
  const lib = await pdfLib();
  const { PDFArray, PDFDict, PDFName, PDFNull, PDFPageLeaf, PDFRef, PDFStream } = lib;
  const CONTENTS = PDFName.of("Contents");

  /** What a page's content stream is called, as a key. Blank pages have none. */
  const contentsKey = (value: PDFObject | undefined): string | null => {
    if (value instanceof PDFRef) return value.toString();
    // A page can hold its content in several streams, listed in an array.
    if (value instanceof PDFArray && value.size() > 0) {
      const first = value.get(0);
      return first instanceof PDFRef ? first.toString() : null;
    }
    return null;
  };

  const mine = new Set(kept.map((page) => page.ref.toString()));
  const realPageFor = new Map<string, PDFRef>();
  for (const page of kept) {
    const key = contentsKey(page.node.get(CONTENTS));
    if (key) realPageFor.set(key, page.ref);
  }

  // null in here means "this page is gone", as opposed to a missing key, which
  // means "this reference is not a page at all and must be left alone".
  const strays = new Map<string, PDFRef | null>();
  for (const [ref, object] of part.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFPageLeaf)) continue;
    if (mine.has(ref.toString())) continue;
    const key = contentsKey(object.get(CONTENTS));
    strays.set(ref.toString(), (key && realPageFor.get(key)) || null);
  }
  if (strays.size === 0) return;

  const swapFor = (value: PDFObject): PDFObject | undefined => {
    if (!(value instanceof PDFRef)) return undefined;
    const key = value.toString();
    if (!strays.has(key)) return undefined;
    return strays.get(key) ?? PDFNull;
  };

  const seen = new Set<PDFObject>();
  const visit = (object: PDFObject): void => {
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFStream) {
      visit(object.dict);
      return;
    }
    if (object instanceof PDFDict) {
      for (const [key, value] of object.entries()) {
        const swap = swapFor(value);
        if (swap) object.set(key, swap);
        else visit(value);
      }
      return;
    }
    if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) {
        const value = object.get(i);
        const swap = swapFor(value);
        if (swap) object.set(i, swap);
        else visit(value);
      }
    }
  };

  for (const [, object] of part.context.enumerateIndirectObjects()) visit(object);
}

/**
 * Throw away every object nothing points at any more.
 *
 * pdf-lib writes out each object it is holding whether or not anything refers
 * to it, so cutting a reference is not the same as removing what it pointed
 * at. This walks out from the trailer, which is where a reader starts, and
 * deletes whatever it never reaches. Without it `dropStrayPages` would hide the
 * pages it took out rather than remove them, and hidden is not gone.
 */
async function dropUnreachable(part: PDFDocument): Promise<void> {
  const { PDFArray, PDFDict, PDFRef, PDFStream } = await pdfLib();
  const context = part.context;

  const live = new Set<string>();
  const seen = new Set<PDFObject>();
  const queue: PDFObject[] = [];
  const push = (value: PDFObject | undefined): void => {
    if (value) queue.push(value);
  };

  const trailer = context.trailerInfo;
  // The catalog is where a reader starts, so with no catalog to walk out from
  // everything would look unreachable and this would empty the file. That
  // cannot happen to a document this module just built, and the cost of being
  // sure is one line.
  if (!trailer.Root) return;
  push(trailer.Root);
  push(trailer.Info);
  push(trailer.Encrypt);
  push(trailer.ID);

  while (queue.length > 0) {
    const object = queue.pop();
    if (!object) continue;
    if (object instanceof PDFRef) {
      if (live.has(object.toString())) continue;
      live.add(object.toString());
      push(context.lookup(object));
      continue;
    }
    if (seen.has(object)) continue;
    seen.add(object);
    if (object instanceof PDFStream) {
      push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) push(value);
    } else if (object instanceof PDFArray) {
      for (let i = 0; i < object.size(); i++) push(object.get(i));
    }
  }

  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!live.has(ref.toString())) context.delete(ref);
  }
}

/**
 * Put the copied form fields back into a form.
 *
 * `merge.ts` explains this at length and it is the same trap here: the widget
 * annotations and the field dictionaries behind them come across with the page,
 * but nothing copies the catalog's /AcroForm, so the part ends up with no form
 * at all. The boxes still draw, because their appearance streams came along, so
 * the file looks perfect while `getForm().getFields()` is empty, no reader will
 * let anyone type in them, and the answers already filled in cannot be read
 * back out.
 *
 * Splitting is easier than merging in one way: every field comes from one
 * document, so two fields cannot arrive with the same name and there is nothing
 * to rename.
 *
 * A field whose other widgets sat on pages this part does not have is still
 * registered, with the value it was carrying. It shows up as a field with
 * nothing drawn for it, which is the honest answer: the data is real and the
 * box it was typed into is in a different file now.
 */
async function rescueFields(
  part: PDFDocument,
  src: PDFDocument,
  copied: PDFPage[],
): Promise<void> {
  // Most files have no form at all, and that case should cost nothing. A file
  // whose /AcroForm is the wrong type makes this getter throw, and a rescue
  // that cannot run is not a reason to lose the split.
  const donor = read(() => src.catalog.getAcroForm());
  if (!donor) return;

  const lib = await pdfLib();
  const { PDFDict, PDFName, PDFRef } = lib;
  const T = PDFName.of("T");
  const FT = PDFName.of("FT");
  const KIDS = PDFName.of("Kids");
  const TYPE = PDFName.of("Type");
  const PARENT = PDFName.of("Parent");
  const SUBTYPE = PDFName.of("Subtype");
  // PDFName.of hands back a pooled instance, so these compare by identity.
  const WIDGET = PDFName.of("Widget");
  const PAGE = PDFName.of("Page");
  const PAGES = PDFName.of("Pages");

  /** A page or a page tree node is never a form field, whatever keys it has. */
  const isField = (value: unknown): boolean => {
    if (!(value instanceof PDFDict)) return false;
    const kind = value.lookup(TYPE);
    if (kind === PAGE || kind === PAGES) return false;
    return value.has(T) || value.has(FT) || value.has(KIDS);
  };

  /** Climb /Parent to the top of a field tree. Only the top one is registered,
   *  because that is the one holding the name the reader shows. */
  const rootOf = (start: PDFRef): PDFRef | undefined => {
    let ref = start;
    // A damaged file can point /Parent in a circle, so the climb is bounded.
    for (let hop = 0; hop < 32; hop++) {
      const dict = part.context.lookup(ref);
      if (!(dict instanceof PDFDict)) return undefined;
      const up = dict.get(PARENT);
      if (!(up instanceof PDFRef) || !isField(part.context.lookup(up))) {
        return isField(dict) ? ref : undefined;
      }
      ref = up;
    }
    return undefined;
  };

  const roots = new Map<string, PDFRef>();
  for (const page of copied) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      // A widget stored inline instead of behind a reference cannot be
      // registered, and that form is rare enough to leave as pdf-lib leaves it.
      if (!(ref instanceof PDFRef)) continue;
      // /Annots also holds links and comments, and neither belongs in a form.
      const annot = part.context.lookup(ref);
      if (!(annot instanceof PDFDict)) continue;
      if (annot.lookup(SUBTYPE) !== WIDGET) continue;

      const root = rootOf(ref);
      if (root) roots.set(root.toString(), root);
    }
  }
  if (roots.size === 0) return;

  const form = part.catalog.getOrCreateAcroForm();
  // /DA and /DR are the default font and the resources it names. They live on
  // the form, not the page, so copyPages never sees them, and without them a
  // reader has nothing to redraw a field with once somebody edits it.
  const copier = lib.PDFObjectCopier.for(src.context, part.context);
  for (const which of ["DA", "DR", "NeedAppearances"] as const) {
    const value = donor.dict.get(PDFName.of(which));
    if (value) form.dict.set(PDFName.of(which), copier.copy(value));
  }
  for (const root of roots.values()) form.addField(root);
}

/* ---------------------------------------------------------------------------
 * Names and metadata
 * ------------------------------------------------------------------------ */

/**
 * Name the parts so a file manager sorts them the way they were cut.
 *
 * The padding is the whole point: with 10 parts, "-10" sorts before "-2" by
 * name, and "-02" does not. A base name that came straight off a file keeps its
 * ".pdf" otherwise, and "lease.pdf-1.pdf" is not a name anybody meant to make.
 */
function partName(base: string, index: number, total: number): string {
  const stem =
    safeName(base.replace(/\.pdf$/i, ""))
      // safeName turns every character a file system refuses into a dash, so a
      // name with punctuation in it comes out with runs of dashes and stray
      // spaces around them. Nothing here can collide, since the number keeps
      // the parts apart, so tidying is free.
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "document";
  return `${stem}-${pageNo(index, total)}.pdf`;
}

/**
 * Give the part the source document's details, plus a title that says which
 * part it is.
 *
 * The reads are guarded because a damaged Info dictionary can hold something
 * that is not text, and losing the author of a part is not worth failing the
 * whole split over.
 */
function carryMetadata(
  src: PDFDocument,
  part: PDFDocument,
  base: string,
  index: number,
  total: number,
): void {
  const title = read(() => src.getTitle()) ?? base;
  part.setTitle(`${title} (part ${index + 1} of ${total})`);

  const author = read(() => src.getAuthor());
  if (author) part.setAuthor(author);

  const subject = read(() => src.getSubject());
  if (subject) part.setSubject(subject);

  // getKeywords hands back the one string that was stored, and setKeywords
  // joins its array with spaces, so a single entry round trips unchanged.
  const keywords = read(() => src.getKeywords());
  if (keywords) part.setKeywords([keywords]);

  // Creator means the program the document was originally written in, which is
  // still true of a part. Producer means the program that wrote this file, and
  // that is this tool, not whatever made the original.
  const creator = read(() => src.getCreator());
  part.setCreator(creator || PRODUCER);
  part.setProducer(PRODUCER);

  const created = read(() => src.getCreationDate());
  if (created) part.setCreationDate(created);

  // The part is a new file as of now, whatever the source says.
  part.setModificationDate(new Date());
}

function read<T>(get: () => T | undefined): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}
