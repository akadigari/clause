/**
 * Combine several PDFs into one.
 *
 * This is the operation people search for more than any other, so the notes
 * below are longer than the code. Three things about it are worth knowing
 * before reading further.
 *
 * **Page sizes are left alone.** A US Letter contract followed by an A4 invoice
 * followed by a scanned receipt comes out as exactly those three sizes. Nothing
 * is scaled, padded, or rotated to match its neighbours. Tools that "helpfully"
 * normalize a merge are the reason scanned pages come back with white margins
 * and shrunken text, and it cannot be undone afterwards.
 *
 * **A bad file fails the whole merge, by name.** Skipping the broken one and
 * carrying on sounds friendlier, but it means someone downloads a 40 page
 * document believing it holds all 5 contracts when it holds 4. Every error out
 * of here names the file that caused it, because "merge failed" is worthless
 * advice when 20 files went in. A page number that does not exist is treated
 * the same way, for the same reason: quietly dropping page 100 of a 12 page
 * file hands back a document that is shorter than the person asked for.
 *
 * **Form fields are rescued by hand.** See the long note above `absorbFields`.
 * pdf-lib loses them otherwise, silently.
 *
 * **Internal links are rescued too.** See the note above
 * `copyPagesKeepingLinks`. pdf-lib's own copyPages points every widget and
 * every table of contents link at a page that is not in the merged document.
 *
 * **Bookmarks are not carried.** A merged file has no outline, even when the
 * inputs had one. pdf-lib has no API for the outline tree and building one by
 * hand is a bigger job than this operation. Saying so here beats letting
 * someone find out from a missing sidebar.
 */

import type { PDFAcroForm, PDFDict, PDFRef } from "pdf-lib";
import {
  blankPdf,
  breathe,
  checkSize,
  LIMITS,
  loadPdf,
  PdfOpError,
  pdfLib,
  requirePages,
  savePdf,
  type PDFDocument,
  type PDFPage,
  type Progress,
} from "./common";

/**
 * One file going into the merge.
 *
 * `pages` is a list of zero based page indexes. Leaving it off means every page
 * of that file, in its own order. Passing it takes those pages **in document
 * order**, not in the order they were typed: `[4, 0]` gives page 1 then page 5.
 * Rearranging pages is a different job with a different undo step, and doing it
 * quietly inside a merge makes the result impossible to reason about.
 */
export type MergeInput = {
  name: string;
  bytes: Uint8Array;
  pages?: number[];
};

export type MergeResult = {
  bytes: Uint8Array;
  pageCount: number;
  sources: Array<{ name: string; pages: number }>;
};

/** Goes in the Producer field so the merged file says what made it. */
const PRODUCER = "Clause (in-browser PDF workbench)";

/**
 * Merge two or more PDFs, in the order given.
 *
 * `onProgress` fires once per input, after that input's pages have landed, so
 * a caller can count files rather than pages. Between inputs the loop hands
 * control back to the browser, which is what keeps a 30 file merge from
 * freezing the tab and stalling the very progress bar it is feeding.
 */
export async function mergePdfs(
  inputs: MergeInput[],
  onProgress?: Progress,
): Promise<MergeResult> {
  if (inputs.length < 2) {
    throw new PdfOpError(
      inputs.length === 0
        ? "There are no files to merge."
        : "Merging needs at least two files, and only one was given.",
      "Add another PDF to the list, then try again.",
    );
  }

  const out = await blankPdf();
  const sources: MergeResult["sources"] = [];
  const fields = newFieldState();
  let firstDoc: PDFDocument | null = null;
  let running = 0;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    if (!input) {
      // A hole in the list is a caller bug, and skipping it would hand back a
      // merge that is quietly missing a file while still reporting success.
      throw new PdfOpError(
        `File ${i + 1} of ${inputs.length} in the list is missing.`,
        "Remove the empty slot from the list and try again.",
      );
    }
    const label = input.name.trim() || `file ${i + 1}`;

    const src = await openInput(input, label);
    if (!firstDoc) firstDoc = src;

    const indexes = choosePages(input, src, label);
    running += indexes.length;
    if (running > LIMITS.maxPages) {
      throw new PdfOpError(
        `Adding "${label}" pushes this past ${LIMITS.maxPages} pages, which is more than a browser tab can hold open.`,
        "Merge these in two batches, then merge the two results.",
      );
    }

    let copied: PDFPage[];
    try {
      copied = await copyPagesKeepingLinks(out, src, indexes);
    } catch (err) {
      throw new PdfOpError(
        `"${label}" opened, but its pages could not be copied out of it.`,
        detailOf(err),
      );
    }
    for (const page of copied) out.addPage(page);

    await absorbFields(out, src, copied, fields);

    sources.push({ name: label, pages: indexes.length });
    onProgress?.(i + 1, inputs.length, label);
    await breathe();
  }

  if (fields.renamed > 0) {
    // MergeResult has no room for this and the shape is fixed, so the console
    // is where it goes. Better a line in the log than a rename nobody was told
    // about at all.
    console.warn(
      "[clause]",
      `${fields.renamed} form ${fields.renamed === 1 ? "field" : "fields"} were renamed during the merge because more than one file used the same field name.`,
    );
  }

  if (fields.form && fields.needAppearances) {
    // Set by forms whose field values were written without matching appearance
    // streams, telling the reader to draw them itself. Like /DA and /DR it
    // lives on the form rather than the page, so nothing copies it, and a form
    // that relied on it comes out of a merge showing empty boxes.
    const { PDFName, PDFBool } = await pdfLib();
    fields.form.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  }

  if (firstDoc) carryMetadata(out, firstDoc);
  out.setProducer(PRODUCER);
  out.setModificationDate(new Date());

  const bytes = await savePdf(out);
  return { bytes, pageCount: out.getPageCount(), sources };
}

/**
 * Copy pages the way `PDFDocument.copyPages` should have.
 *
 * pdf-lib hands its copier the page *object*, while the copier only remembers
 * what it has already copied by *reference*. So when it later meets a reference
 * to that same page, and it always does - a widget's /P saying which page it
 * sits on, a contents link whose /Dest names the page to jump to - it does not
 * recognise it and copies the page a second time. The merged file ends up
 * holding two copies of every page that carries an annotation: the one in the
 * page tree, and a stranded duplicate that every internal reference points at.
 *
 * Measured on pdf-lib 1.17.1, merging a two page file whose page 1 links to its
 * page 2: the merged document's pages are objects 7, 8 and 9, and the link's
 * destination reads `[6 0 R /Fit]`, which is not a page of the document at all.
 * A merged table of contents clicks through to nothing, and every form widget
 * claims to live on a page no reader can find. Neither shows up in a page
 * count, a thumbnail strip, or a visual check, which is why this survives.
 *
 * Copying by reference fixes all of it in one move: the copier writes down the
 * mapping the first time it sees the page, so every later reference to it
 * resolves to the object that actually gets added to the document.
 */
async function copyPagesKeepingLinks(
  out: PDFDocument,
  src: PDFDocument,
  indexes: number[],
): Promise<PDFPage[]> {
  const lib = await pdfLib();
  // What copyPages does first: anything the source has embedded but not yet
  // written out has to land before it can be copied.
  await src.flush();

  const copier = lib.PDFObjectCopier.for(src.context, out.context);
  const srcPages = src.getPages();
  const pages: PDFPage[] = [];

  // indexes comes from requirePages, so it is sorted and has no repeats. That
  // matters here: asking for the same page twice returns the same reference
  // twice, and the same object cannot sit in the page tree in two places.
  for (const index of indexes) {
    const srcPage = srcPages[index];
    if (!srcPage) throw new Error(`page ${index + 1} went missing between counting and copying`);

    const ref = copier.copy(srcPage.ref);
    const node = out.context.lookup(ref);
    if (!(node instanceof lib.PDFPageLeaf)) {
      throw new Error(`page ${index + 1} did not come back from the copier as a page`);
    }
    pages.push(lib.PDFPage.of(node, ref, out));
  }

  return pages;
}

/** Open one input, and make sure any complaint carries its file name. */
async function openInput(input: MergeInput, label: string): Promise<PDFDocument> {
  try {
    checkSize(input.bytes);
    return await loadPdf(input.bytes);
  } catch (err) {
    if (err instanceof PdfOpError) {
      throw new PdfOpError(`"${label}" could not be opened. ${err.message}`, err.hint);
    }
    throw new PdfOpError(
      `"${label}" could not be opened, and the reason was not one this app knows how to explain.`,
      "Take that file out of the list and merge the rest, or re-export it from whatever made it.",
    );
  }
}

/** Work out which pages of one input to take, or say why none of them work. */
function choosePages(input: MergeInput, src: PDFDocument, label: string): number[] {
  const count = src.getPageCount();
  if (count === 0) {
    throw new PdfOpError(
      `"${label}" is a valid PDF with no pages in it.`,
      "Some export tools produce these. Open it in a reader to check there is anything to merge.",
    );
  }
  if (!input.pages) return src.getPageIndices();

  const has = count === 1 ? "It has 1 page." : `It has ${count} pages.`;
  const hint = `Pages are counted from 1 in the page box, so the last one here is page ${count}.`;

  if (input.pages.length === 0) {
    throw new PdfOpError(
      `No pages were picked for "${label}".`,
      `Pick at least one page, or leave the selection off entirely to take all ${count}.`,
    );
  }

  // A page number that is not in the file is a typo, and dropping it quietly
  // is the same silent shortfall as skipping a broken file: the merge succeeds
  // and the result is missing something the person asked for. So the bad ones
  // are named and the merge stops, exactly as it does for a bad file.
  const bad = input.pages.filter((p) => !Number.isInteger(p) || p < 0 || p >= count);
  if (bad.length > 0) {
    if (bad.length === input.pages.length) {
      throw new PdfOpError(`None of the pages picked for "${label}" exist. ${has}`, hint);
    }
    const shown = bad.map((p) => (Number.isInteger(p) && p >= 0 ? p + 1 : p)).join(", ");
    throw new PdfOpError(
      `"${label}" has no ${bad.length === 1 ? "page" : "pages"} ${shown}. ${has}`,
      hint,
    );
  }

  try {
    return requirePages(input.pages, count);
  } catch (err) {
    if (err instanceof PdfOpError) {
      throw new PdfOpError(`None of the pages picked for "${label}" exist. ${has}`, hint);
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
 * Form fields
 * ------------------------------------------------------------------------ */

type FieldState = {
  /** Root field refs already registered, so a field with a widget on several
   *  pages gets registered once instead of once per page. */
  seen: Set<string>;
  /** Top level field names already spoken for. */
  taken: Set<string>;
  /** The merged form, built the first time a field actually turns up. */
  form: PDFAcroForm | null;
  /** How many fields had to be renamed to stay independent. */
  renamed: number;
  /** True once any donor form asked the reader to draw its own appearances. */
  needAppearances: boolean;
};

function newFieldState(): FieldState {
  return { seen: new Set(), taken: new Set(), form: null, renamed: 0, needAppearances: false };
}

/**
 * Put copied form fields back into a form, and keep colliding names apart.
 *
 * This is the trap in merging, and it is worth spelling out because the failure
 * is invisible. Measured against pdf-lib 1.17.1:
 *
 *   1. `copyPages` deep copies the page dictionary, which includes its widget
 *      annotations and, through their /Parent links, the field dictionaries
 *      behind them. So the fields do come across.
 *   2. Nothing copies the source catalog's /AcroForm. The merged document ends
 *      up with no /AcroForm at all, so those fields are attached to nothing.
 *      They still draw, because their appearance streams came along, so the
 *      file looks perfect. But `getForm().getFields()` returns an empty list,
 *      readers will not let anyone fill them, and the values already in them
 *      cannot be read back out. Filling in a merged tax form and finding the
 *      boxes dead is the shape this bug takes for a real person.
 *   3. Rebuilding the form is not enough on its own. Two inputs that each have
 *      a field called "name" produce two top level fields with the same fully
 *      qualified name, and by the spec that means one field with two widgets.
 *      Readers link them, so typing a name on page 1 fills it in on page 4 too.
 *      pdf-lib's own API disagrees and edits only the first of the two, which
 *      is exactly what makes this hard to catch: it tests clean and corrupts in
 *      Acrobat.
 *
 * So: register the root of each copied field, and when a name is already taken
 * by an earlier file, rename the newcomer to "name (2)". A visibly renamed
 * field is a small annoyance somebody can see and work around. Two fields
 * silently wired together is data loss nobody notices until it matters.
 *
 * A widget stored inline instead of behind a reference cannot be registered
 * this way and is left as pdf-lib leaves it. That form is vanishingly rare and
 * skipping it is no worse than the default behaviour.
 */
async function absorbFields(
  out: PDFDocument,
  src: PDFDocument,
  copied: PDFPage[],
  state: FieldState,
): Promise<void> {
  // The common case is files with no forms at all, and it should cost nothing.
  // A file whose /AcroForm is the wrong type makes this getter throw, and a
  // rescue that cannot run is not a reason to lose the merge.
  const donorForm = quietly(() => src.catalog.getAcroForm());
  if (!donorForm) return;

  const lib = await pdfLib();
  const Dict = lib.PDFDict;
  const Ref = lib.PDFRef;
  const Name = lib.PDFName;
  const Hex = lib.PDFHexString;
  const Str = lib.PDFString;
  const Bool = lib.PDFBool;

  // Read before anything else, because a donor can set this and still put no
  // fields on the pages that were picked. It is applied to the merged form at
  // the end of the merge, if a form was built at all.
  const wants = donorForm.dict.lookup(Name.of("NeedAppearances"));
  if (wants instanceof Bool && wants.asBoolean()) state.needAppearances = true;

  const T = Name.of("T");
  const FT = Name.of("FT");
  const KIDS = Name.of("Kids");
  const TYPE = Name.of("Type");
  const PARENT = Name.of("Parent");
  const SUBTYPE = Name.of("Subtype");
  // PDFName.of hands back a pooled instance, so these compare by identity.
  const WIDGET = Name.of("Widget");
  const PAGE = Name.of("Page");
  const PAGES = Name.of("Pages");

  /** A page or a page tree node is never a form field, whatever keys it has. */
  const isField = (value: unknown): value is PDFDict => {
    if (!(value instanceof Dict)) return false;
    const kind = value.lookup(TYPE);
    if (kind === PAGE || kind === PAGES) return false;
    return value.has(T) || value.has(FT) || value.has(KIDS);
  };

  /** Climb /Parent to the top of a field tree. A widget can sit several levels
   *  below the field that owns the name, and only the top one gets registered. */
  const rootOf = (start: PDFRef): PDFRef | undefined => {
    let ref: PDFRef = start;
    // A broken file can point /Parent in a circle, so the climb is bounded.
    for (let hop = 0; hop < 32; hop++) {
      const dict = out.context.lookup(ref);
      if (!(dict instanceof Dict)) return undefined;
      const up = dict.get(PARENT);
      if (!(up instanceof Ref) || !isField(out.context.lookup(up))) {
        return isField(dict) ? ref : undefined;
      }
      ref = up;
    }
    return undefined;
  };

  for (const page of copied) {
    const annots = page.node.Annots();
    if (!annots) continue;

    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (!(ref instanceof Ref)) continue;

      // /Annots also holds links and comments, and neither belongs in a form.
      const annot = out.context.lookup(ref);
      if (!(annot instanceof Dict)) continue;
      if (annot.lookup(SUBTYPE) !== WIDGET) continue;

      const root = rootOf(ref);
      if (!root) continue;
      const key = root.toString();
      if (state.seen.has(key)) continue;
      state.seen.add(key);

      const dict = out.context.lookup(root);
      if (!(dict instanceof Dict)) continue;

      const rawName = dict.lookup(T);
      const had = rawName instanceof Str || rawName instanceof Hex ? rawName.decodeText() : "";

      // A root field with no /T has a fully qualified name of "". Two of those
      // from two different files therefore share a name, which is the same
      // silent linkage the renaming below exists to prevent, so a nameless leaf
      // is given a name. A nameless node that has /Kids is left alone: there
      // the children carry the names, and putting one on the parent would
      // change the full name of every child under it.
      const name = had || (dict.has(KIDS) ? "" : "Field");

      if (name) {
        let settled = name;
        if (state.taken.has(settled)) {
          let n = 2;
          while (state.taken.has(`${name} (${n})`)) n++;
          settled = `${name} (${n})`;
          // Only a field that arrived with a name of its own counts as renamed.
          // One that arrived with none was named, not renamed, and saying so
          // would send someone looking for a change that never happened.
          if (had) state.renamed++;
        }
        if (settled !== had) dict.set(T, Hex.fromText(settled));
        state.taken.add(settled);
      }

      if (!state.form) {
        state.form = out.catalog.getOrCreateAcroForm();
        // /DA and /DR are the default font and the resources it names. They
        // live on the form, not the page, so copyPages never sees them. Taking
        // them from the first file that actually contributes a field is the
        // best guess available: merging several /DR dictionaries would just
        // move the name collision from fields onto fonts.
        const copier = lib.PDFObjectCopier.for(src.context, out.context);
        for (const which of ["DA", "DR"] as const) {
          const value = donorForm.dict.get(Name.of(which));
          if (value) state.form.dict.set(Name.of(which), copier.copy(value));
        }
      }
      state.form.addField(root);
    }
  }
}

/* ---------------------------------------------------------------------------
 * Metadata
 * ------------------------------------------------------------------------ */

/**
 * Take the first file's details onto the result.
 *
 * The first file is the one the merge is named after in every UI worth using,
 * so its title and author are the ones people expect to survive. Creator stays
 * as whatever wrote the original, because that is what the field means, and
 * Producer is overwritten by the caller because that is this tool's job.
 */
function carryMetadata(out: PDFDocument, first: PDFDocument): void {
  const title = quietly(() => first.getTitle());
  if (title) out.setTitle(title);

  const author = quietly(() => first.getAuthor());
  if (author) out.setAuthor(author);

  const subject = quietly(() => first.getSubject());
  if (subject) out.setSubject(subject);

  // getKeywords hands back one string and setKeywords wants a list it joins
  // with spaces, so a single element array is what survives the round trip
  // with its commas intact.
  const keywords = quietly(() => first.getKeywords());
  if (keywords) out.setKeywords([keywords]);

  const creator = quietly(() => first.getCreator());
  out.setCreator(creator || PRODUCER);

  const created = quietly(() => first.getCreationDate());
  if (created) out.setCreationDate(created);
}

/**
 * pdf-lib throws on metadata that breaks the spec, and plenty of real files
 * carry a mangled date string or a title stored as the wrong type. None of that
 * is a reason to lose the merge.
 */
function quietly<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    ? `The library reported: ${message}`
    : "No further detail came back from the library.";
}
