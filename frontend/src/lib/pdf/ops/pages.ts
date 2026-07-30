/**
 * Page structure: turn, delete, reorder, move, duplicate, extract, and add a
 * blank sheet.
 *
 * This is the module the page strip drives, so it gets used more than anything
 * else here. Two rules run through all of it:
 *
 *   1. Anything that changes the ORDER of pages rebuilds the document from a
 *      fresh one and copies pages in the order it wants. Shuffling with
 *      removePage and insertPage on a live document means holding a correct
 *      picture of the page tree in your head while it changes underneath you,
 *      and it leaves the objects of dropped pages behind in the file. A rebuild
 *      cannot get the order wrong and drops the orphans for free.
 *
 *   2. Anything that only changes a page IN PLACE, like a rotation or an
 *      insert, edits the loaded document and saves it. A rebuild costs the
 *      document level extras that live outside the page tree, such as bookmarks
 *      and form definitions, so it is not worth paying when there is nothing to
 *      reorder.
 *
 * Every rebuild carries the metadata and the interactive form across. Wiping
 * someone's title and author because they deleted a page is a data loss bug
 * that nobody notices until the file is already sent, and silently emptying a
 * form they had already filled in is a worse one.
 *
 * What a rebuild still does NOT carry, said plainly so nobody has to find out
 * from a user: bookmarks, page labels, article threads, and XFA form
 * definitions. Every one of those points at page objects by reference, and the
 * rebuild gives each page a new object number that pdf-lib does not hand back,
 * so there is no honest way to repair those references from out here. A file
 * with bookmarks loses them when a page is deleted or reordered. Rotation and
 * blank inserts do not rebuild, so they keep everything.
 */

import { plural } from "../../format";
import { normalizeRotation } from "../geometry";
// Types only, so this is erased at build time and does not pull pdf-lib into
// the bundle ahead of the lazy import that pdfLib() does. Renamed because the
// runtime classes of the same name get pulled out of that import below.
import type { PDFDict as PdfDict, PDFRef as PdfRef } from "pdf-lib";
import {
  blankPdf,
  breathe,
  LIMITS,
  loadPdf,
  pageBoxOf,
  PdfOpError,
  pdfLib,
  requirePages,
  savePdf,
  type PDFDocument,
} from "./common";

/** Pages to get through between yields. Enough work to be worth a frame. */
const CHUNK = 25;

/**
 * Page count, with both broken cases named.
 *
 * A PDF with no pages is not a legal file, so anything that loads with zero
 * pages is damaged. Saying that is more useful than letting the selection
 * check report "no pages were selected", which points the user at the wrong
 * thing entirely.
 *
 * Counting can also throw outright. A file with a correct header but a
 * truncated body loads without complaint, because the loader is told not to
 * throw on invalid objects, and only falls over here when something asks it
 * for the page tree it never got. Left alone that comes out as a TypeError,
 * which the UI treats as a bug in this app rather than a problem with the
 * file, so it is caught and named.
 */
function totalPages(doc: PDFDocument): number {
  let total: number;
  try {
    total = doc.getPageCount();
  } catch {
    throw new PdfOpError(
      "This PDF is damaged: it has a PDF header but no readable list of pages.",
      "The file is probably truncated or was only partly downloaded. Try getting a fresh copy.",
    );
  }
  if (total === 0) {
    throw new PdfOpError(
      "This PDF has no pages in it.",
      "A PDF with no pages is not a valid file. Whatever wrote it did so incorrectly.",
    );
  }
  return total;
}

/**
 * A damaged info dictionary can hold the wrong kind of object under a metadata
 * key, and pdf-lib throws rather than guessing. Losing one field is not worth
 * failing the whole edit, so every read goes through here.
 */
function readMeta<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Carry title, author, subject, keywords, creator and producer to a rebuild. */
function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  const title = readMeta(() => from.getTitle());
  if (title !== undefined) to.setTitle(title);

  const author = readMeta(() => from.getAuthor());
  if (author !== undefined) to.setAuthor(author);

  const subject = readMeta(() => from.getSubject());
  if (subject !== undefined) to.setSubject(subject);

  const creator = readMeta(() => from.getCreator());
  if (creator !== undefined) to.setCreator(creator);

  const producer = readMeta(() => from.getProducer());
  if (producer !== undefined) to.setProducer(producer);

  // pdf-lib writes keywords by joining the array with a space, so handing the
  // stored string back as a single item reproduces it exactly. Splitting it
  // first would be lossy for any keyword that has a space in it.
  const keywords = readMeta(() => from.getKeywords());
  if (keywords !== undefined) to.setKeywords([keywords]);

  const created = readMeta(() => from.getCreationDate());
  if (created !== undefined) to.setCreationDate(created);

  // The document really was changed just now, so this one is not copied.
  to.setModificationDate(new Date());
}

/** Entries of an AcroForm that describe the document, not any one field. */
const FORM_ATTRIBUTES = ["DA", "DR", "NeedAppearances", "SigFlags", "Q"] as const;

/** A damaged file can point a field's /Parent at itself. Cap the climb. */
const MAX_FIELD_DEPTH = 32;

/**
 * Carry the interactive form across a rebuild.
 *
 * copyPages brings each page's annotations with it, and a form field's widget
 * is an annotation, so the boxes and the values the user typed do land in the
 * new document. What does not is the /AcroForm entry in the catalog, which is
 * the only place a reader looks to find out that the file has a form at all.
 * Without it every field is a dead drawing: not focusable, not fillable, and
 * invisible to anything that reads form data. Delete one page of a filled in
 * lease and the tenant's name is still on the paper but gone from the form.
 *
 * The fields themselves do not need copying, because a widget points at its
 * field through /Parent and copyPages follows that. So this walks the pages
 * that actually survived, climbs from each widget to the top of its field, and
 * lists those. Building the list from the surviving pages rather than from the
 * old /Fields array is what keeps a deleted page's fields out of it.
 *
 * /XFA is deliberately left behind. It carries its own copy of the form as XML
 * that names the original fields, and half of that is worse than none of it.
 */
async function carryForm(source: PDFDocument, out: PDFDocument): Promise<void> {
  const { PDFArray, PDFDict, PDFName, PDFObjectCopier, PDFRef } = await pdfLib();

  const sourceForm = source.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!sourceForm) return;

  const SUBTYPE = PDFName.of("Subtype");
  const WIDGET = PDFName.of("Widget");
  const PARENT = PDFName.of("Parent");

  const roots: PdfRef[] = [];
  const seen = new Set<string>();

  for (const page of out.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof PDFRef)) continue;
      const annot = out.context.lookupMaybe(ref, PDFDict);
      // PDFName.of hands back the same object for the same name, so this is a
      // real comparison and not an accidental reference check.
      if (!annot || annot.get(SUBTYPE) !== WIDGET) continue;

      // A widget is either the field itself, which is how a single widget
      // field is usually written, or a child of one. Climb to the top either
      // way, because /Fields lists roots and nothing below them.
      let root: PdfRef = ref;
      let field: PdfDict = annot;
      for (let depth = 0; depth < MAX_FIELD_DEPTH; depth++) {
        const parent = field.get(PARENT);
        if (!(parent instanceof PDFRef)) break;
        const above = out.context.lookupMaybe(parent, PDFDict);
        if (!above) break;
        root = parent;
        field = above;
      }

      const key = root.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    }
  }

  // Every page carrying a field was dropped, so there is no form left to name.
  if (roots.length === 0) return;

  const form = PDFDict.withContext(out.context);
  const copier = PDFObjectCopier.for(source.context, out.context);
  for (const key of FORM_ATTRIBUTES) {
    const name = PDFName.of(key);
    const value = sourceForm.get(name);
    if (value === undefined) continue;
    // /DR holds the fonts a reader needs to redraw a field after it is edited,
    // and it lives in the old document, so it has to be copied rather than
    // pointed at.
    form.set(name, copier.copy(value));
  }

  const fields = PDFArray.withContext(out.context);
  for (const ref of roots) fields.push(ref);
  form.set(PDFName.of("Fields"), fields);

  out.catalog.set(PDFName.of("AcroForm"), out.context.register(form));
}

/**
 * Build a new document holding the source's pages in the given order.
 *
 * The order is read literally: repeats give repeated pages, and anything left
 * out is dropped. copyPages is the only correct way to move a page between
 * documents, because it brings the fonts, images and annotations the page
 * points at. Copying the page object alone gives you a page with no resources.
 */
async function rebuildInOrder(source: PDFDocument, order: number[]): Promise<Uint8Array> {
  const out = await blankPdf();
  const copied = await out.copyPages(source, order);
  let done = 0;
  for (const page of copied) {
    out.addPage(page);
    done += 1;
    if (done % CHUNK === 0) await breathe();
  }
  copyMetadata(source, out);
  await carryForm(source, out);
  return savePdf(out);
}

/** Stop a growing operation before the tab does it for us. */
function checkCeiling(wanted: number): void {
  if (wanted > LIMITS.maxPages) {
    throw new PdfOpError(
      `That would make a ${wanted} page document, past the ${LIMITS.maxPages} page ceiling.`,
      "Page operations stop being responsive in a browser tab somewhere around there.",
    );
  }
}

/**
 * Turn pages by a relative amount.
 *
 * `turn` ADDS to whatever the page already carries, which is what the two
 * rotate buttons in the strip mean. A page sitting at 270 turned by 90 ends at
 * 0, not 360, and a page at 0 turned by -90 ends at 270. Both the existing
 * angle and the sum are folded into 0/90/180/270, because a PDF is allowed to
 * store any multiple of 90 including negatives and multiples of 360.
 */
export async function rotatePages(
  bytes: Uint8Array,
  indexes: number[],
  turn: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(turn) || turn % 90 !== 0) {
    throw new PdfOpError(
      `A turn has to be a whole quarter turn, and ${turn} is not one.`,
      "Use 90, 180, 270, or -90.",
    );
  }

  const doc = await loadPdf(bytes);
  const total = totalPages(doc);
  const targets = requirePages(indexes, total);
  const { degrees } = await pdfLib();

  let done = 0;
  for (const index of targets) {
    const page = doc.getPage(index);
    page.setRotation(degrees(normalizeRotation(pageBoxOf(page).rotation + turn)));
    done += 1;
    if (done % CHUNK === 0) await breathe();
  }

  return savePdf(doc);
}

/**
 * Drop pages.
 *
 * Deleting every page is refused rather than obeyed. The result would be a
 * file no reader will open, and the user would find that out later, after the
 * original was gone.
 */
export async function deletePages(bytes: Uint8Array, indexes: number[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);
  const doomed = new Set(requirePages(indexes, total));

  if (doomed.size >= total) {
    throw new PdfOpError(
      `That would delete all ${total} ${plural(total, "page")}, and a PDF with no pages is not a valid file.`,
      "Keep at least one page. To get rid of the whole document, close it instead.",
    );
  }

  const keep: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!doomed.has(i)) keep.push(i);
  }
  return rebuildInOrder(doc, keep);
}

/**
 * Shuffle the whole document into a new order.
 *
 * `order` is complete and reads as `order[newPosition] = oldIndex`, so
 * [2, 0, 1] means the third page moves to the front. Anything that is not a
 * genuine permutation of 0..n-1 is rejected with the reason, and nothing is
 * quietly repaired: a caller that hands over a broken order has a bug, and
 * patching it here would hide the bug behind a document whose pages moved in a
 * way nobody asked for.
 */
export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);

  if (order.length !== total) {
    throw new PdfOpError(
      `The new order lists ${order.length} ${plural(order.length, "position")} but the document has ${total} ${plural(total, "page")}.`,
      "A reorder has to account for every page, including the ones that are not moving.",
    );
  }

  const seen = new Set<number>();
  for (const value of order) {
    if (!Number.isInteger(value) || value < 0 || value >= total) {
      throw new PdfOpError(
        `The new order contains ${value}, which is not a page in a ${total} page document.`,
        `Pages are counted from 0 here, so the last one is ${total - 1}.`,
      );
    }
    if (seen.has(value)) {
      // Said the same way round as the message just above it. Numbering a page
      // from 0 in one sentence and from 1 in the next is how a caller ends up
      // chasing the wrong page.
      throw new PdfOpError(
        `The new order uses page ${value} more than once.`,
        "Pages are counted from 0 here. A reorder is a straight shuffle, so to repeat a page, duplicate it instead.",
      );
    }
    seen.add(value);
  }

  // Those three checks are the whole permutation test. With the right length,
  // no repeats and nothing out of range, there is no room left for a page to
  // be missing, so there is no fourth check to write.
  return rebuildInOrder(doc, order);
}

/**
 * Move one page to a new position, which is what a drag in the strip does.
 *
 * `to` is read after the page has been lifted out, so moving page 0 to
 * position n-1 in a 4 page document gives 1, 2, 3, 0. That matches what the
 * drop indicator shows.
 */
export async function movePage(bytes: Uint8Array, from: number, to: number): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);

  if (!Number.isInteger(from) || from < 0 || from >= total) {
    throw new PdfOpError(
      `There is no page ${from} to move in a ${total} page document.`,
      `Pages are counted from 0 here, so the last one is ${total - 1}.`,
    );
  }
  if (!Number.isInteger(to) || to < 0 || to >= total) {
    throw new PdfOpError(
      `Position ${to} is not somewhere a page can land in a ${total} page document.`,
      `Positions are counted from 0 here, so the last one is ${total - 1}.`,
    );
  }
  if (from === to) return savePdf(doc);

  const order = doc.getPageIndices();
  order.splice(from, 1);
  order.splice(to, 0, from);
  return rebuildInOrder(doc, order);
}

/**
 * Copy pages, each copy landing directly after its original.
 *
 * Putting the copies at the end instead would be less work, but it is not what
 * the button means: duplicating page 3 should give you two page 3s side by
 * side, ready to edit one of them.
 */
export async function duplicatePages(bytes: Uint8Array, indexes: number[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);
  const chosen = new Set(requirePages(indexes, total));
  checkCeiling(total + chosen.size);

  const order: number[] = [];
  for (let i = 0; i < total; i++) {
    order.push(i);
    if (chosen.has(i)) order.push(i);
  }
  return rebuildInOrder(doc, order);
}

/**
 * Pull pages out into a new document.
 *
 * The order given is the order kept, so [4, 0, 2] really does put the fifth
 * page first. Repeats are honoured for the same reason.
 */
export async function extractPages(bytes: Uint8Array, indexes: number[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);

  // requirePages sorts and dedupes, which is right everywhere else and wrong
  // here. It is still the gate, so the wording for an empty selection stays
  // the same across every operation.
  requirePages(indexes, total);
  const wanted = indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  checkCeiling(wanted.length);

  return rebuildInOrder(doc, wanted);
}

/**
 * Add an empty page.
 *
 * `atIndex` is where the new page ends up, so 0 puts it first and the page
 * count puts it last. With no size given it copies the box AND the rotation of
 * the page it lands next to, which is the page it pushes down, or the last page
 * when it is going on the end. A blank Letter sheet in the middle of an A4
 * document is a bug people do not notice until they print it, and by then it is
 * a stack of paper.
 *
 * The MediaBox origin is copied too. It is usually (0, 0) but not always, and a
 * blank page whose origin disagrees with its neighbours means anything stamped
 * onto it later lands offset by that difference. So is the CropBox, because
 * that is the rectangle a reader actually shows and prints.
 *
 * The turn is always written out, even when it is 0. /Rotate is an inheritable
 * attribute, so a page tree whose top node carries a turn hands that turn to
 * every new page put under it. Leaving it unset does not mean 0, it means
 * "whatever the tree says", which on those files is the wrong shape.
 */
export async function insertBlankPage(
  bytes: Uint8Array,
  atIndex: number,
  size?: { width: number; height: number },
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const total = totalPages(doc);

  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > total) {
    throw new PdfOpError(
      `Position ${atIndex} is not somewhere a page can go in a ${total} page document.`,
      `Positions run from 0 to ${total}, where ${total} means the end.`,
    );
  }
  checkCeiling(total + 1);

  const { degrees } = await pdfLib();

  if (size) {
    if (
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      throw new PdfOpError(
        `A page cannot be ${size.width} by ${size.height} points.`,
        "Both sides have to be a positive number of points. Letter is 612 by 792.",
      );
    }
    const sized = doc.insertPage(atIndex, [size.width, size.height]);
    // An explicit size is a request for exactly that shape, so the turn is
    // pinned rather than left to whatever the page tree would lend it.
    sized.setRotation(degrees(0));
    return savePdf(doc);
  }

  const source = doc.getPage(atIndex < total ? atIndex : total - 1);
  const neighbour = pageBoxOf(source);
  const hasCrop = Boolean(source.node.CropBox());
  const crop = source.getCropBox();

  const page = doc.insertPage(atIndex, [neighbour.width, neighbour.height]);
  page.setMediaBox(neighbour.originX, neighbour.originY, neighbour.width, neighbour.height);
  if (hasCrop) {
    // Readers show and print the CropBox, so a neighbour that carries one has
    // to have it copied as well. Without this the blank sheet comes out at a
    // different size from every page around it, which is the exact bug this
    // whole branch exists to avoid.
    page.setCropBox(crop.x, crop.y, crop.width, crop.height);
  }
  // Same box and same turn means the reader sees the same shape. Copying the
  // box alone would give a portrait blank next to a landscape neighbour
  // whenever the landscape came from /Rotate rather than from the box. Written
  // even when it is 0, because unset is inherited, not zero.
  page.setRotation(degrees(neighbour.rotation));
  return savePdf(doc);
}
