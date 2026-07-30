/**
 * Document properties: the title, author and dates a reader shows under
 * "Document Properties", plus the one button people actually come here for,
 * which is stripping the lot.
 *
 * Reading is defensive on purpose. The Info dictionary is the oldest and
 * sloppiest part of a PDF, so a file can carry a date that is not a date and a
 * title that is a number, and pdf-lib throws on both. A metadata viewer that
 * dies on a bad date is worse than one that shows the fields it could read.
 */

import type { PDFDocument, PDFName as PDFNameType } from "pdf-lib";
import { PdfOpError, loadPdf, pdfLib, savePdf } from "./common";

export type Metadata = {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  creator: string;
  producer: string;
  created: Date | null;
  modified: Date | null;
  /** Read only. Passing it to writeMetadata does nothing. */
  pageCount: number;
  /** Read only, and true only for files with a real /Encrypt dictionary. */
  encrypted: boolean;
};

/** Any of the getters can throw on a malformed entry, and none of them matter
 *  enough to lose the rest of the panel over. */
function safeRead<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Keywords are one string in the file and a list in the app.
 *
 * There is no agreed separator. Acrobat writes commas, pdf-lib writes single
 * spaces, and plenty of tools write semicolons. Commas and semicolons win when
 * they appear because they can hold multi word keywords, otherwise the string
 * is split on whitespace.
 */
function splitKeywords(raw: string | undefined): string[] {
  if (!raw) return [];
  const parts = /[,;]/.test(raw) ? raw.split(/[,;]/) : raw.split(/\s+/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The Info dictionary, only if the file already has one. */
async function existingInfo(doc: PDFDocument) {
  const { PDFDict } = await pdfLib();
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof PDFDict ? info : undefined;
}

/**
 * Take entries out of the Info dictionary and out of the file.
 *
 * Dropping the key is not enough on its own. Most writers put the value
 * straight into the dictionary, but some give it its own numbered object and
 * point at it, and pdf-lib writes every object it is holding whether or not
 * anything still points at one. An orphaned object is invisible to a reader
 * and still sitting there for anyone who parses the file, so the object goes
 * too.
 */
async function deleteInfoNames(doc: PDFDocument, names: PDFNameType[]): Promise<void> {
  const { PDFRef } = await pdfLib();
  const info = await existingInfo(doc);
  if (!info) return;
  for (const name of names) {
    const entry = info.get(name);
    info.delete(name);
    if (entry instanceof PDFRef) doc.context.delete(entry);
  }
}

async function deleteInfoKeys(doc: PDFDocument, keys: readonly string[]): Promise<void> {
  const { PDFName } = await pdfLib();
  await deleteInfoNames(
    doc,
    keys.map((key) => PDFName.of(key)),
  );
}

/** Every entry in the Info dictionary, including the ones this app does not
 *  show. Word writes /Company, Distiller writes /SourceModified and macOS
 *  writes /AAPL:Keywords, and none of those are in the list of six. */
async function clearInfo(doc: PDFDocument): Promise<void> {
  const info = await existingInfo(doc);
  if (!info) return;
  await deleteInfoNames(doc, info.keys());
}

/**
 * Remove the XMP packets, properly.
 *
 * XMP is a block of XML holding a second copy of the title, the author and the
 * dates, and it is the copy readers prefer when the two disagree. Taking the
 * catalog's pointer to it out makes the document look clean to a reader and to
 * readMetadata below, but pdf-lib writes out every object it is holding, so
 * the packet itself would still be in the saved bytes in plain text where
 * `strings file.pdf` finds it. The object is deleted as well as the pointer.
 * Pages can carry their own packet too, so those are swept the same way.
 */
async function dropXmp(doc: PDFDocument): Promise<void> {
  const { PDFName, PDFRef } = await pdfLib();
  const key = PDFName.of("Metadata");
  const holders = [doc.catalog, ...doc.getPages().map((page) => page.node)];
  for (const holder of holders) {
    const entry = holder.get(key);
    if (entry === undefined) continue;
    holder.delete(key);
    if (entry instanceof PDFRef) doc.context.delete(entry);
  }
}

/**
 * Everything a properties panel shows, with nothing left undefined.
 *
 * This reads the Info dictionary, which is what pdf-lib exposes. A file can
 * also carry an XMP packet with a second copy of the same properties, and when
 * the two disagree most readers believe the XMP one. Nothing here parses XML,
 * so a file whose XMP has drifted from its Info dictionary reads back as its
 * Info dictionary. writeMetadata and stripMetadata both delete the packet
 * rather than leave that disagreement in place.
 */
export async function readMetadata(bytes: Uint8Array): Promise<Metadata> {
  const doc = await loadPdf(bytes);
  return {
    title: safeRead(() => doc.getTitle()) ?? "",
    author: safeRead(() => doc.getAuthor()) ?? "",
    subject: safeRead(() => doc.getSubject()) ?? "",
    keywords: splitKeywords(safeRead(() => doc.getKeywords())),
    creator: safeRead(() => doc.getCreator()) ?? "",
    producer: safeRead(() => doc.getProducer()) ?? "",
    created: safeRead(() => doc.getCreationDate()) ?? null,
    modified: safeRead(() => doc.getModificationDate()) ?? null,
    pageCount: doc.getPageCount(),
    encrypted: doc.isEncrypted,
  };
}

function checkDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PdfOpError(
      `The ${label} date is not a real date.`,
      "Dates come out of a date picker as a Date. A half typed one parses to nothing.",
    );
  }
}

/**
 * Change only the properties that were passed in.
 *
 * A key left out is left alone, which is what makes this safe to call from a
 * form that only edits the title. An empty string or an empty keyword list
 * means remove the entry, so clearing a box in the UI clears it in the file
 * rather than leaving an empty value behind. A date passed as null clears the
 * date the same way.
 *
 * Changing anything here also drops the file's XMP packet. XMP holds a second
 * copy of these same properties, readers trust it over the Info dictionary,
 * and rewriting XML well enough to edit it in place is a different job. Left
 * alone it would quietly undo the edit: you change the author to "Anonymous",
 * the panel agrees, and Acrobat still shows the old name because it read the
 * packet instead.
 *
 * pageCount and encrypted are part of Metadata because readMetadata reports
 * them. They are not settable and are ignored here: page count comes from the
 * page tree, and pdf-lib cannot encrypt anything at all.
 */
export async function writeMetadata(
  bytes: Uint8Array,
  meta: Partial<Metadata>,
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const clear: string[] = [];
  const touched =
    meta.title !== undefined ||
    meta.author !== undefined ||
    meta.subject !== undefined ||
    meta.creator !== undefined ||
    meta.producer !== undefined ||
    meta.keywords !== undefined ||
    meta.created !== undefined ||
    meta.modified !== undefined;

  if (meta.title !== undefined) {
    if (meta.title === "") clear.push("Title");
    else doc.setTitle(meta.title);
  }
  if (meta.author !== undefined) {
    if (meta.author === "") clear.push("Author");
    else doc.setAuthor(meta.author);
  }
  if (meta.subject !== undefined) {
    if (meta.subject === "") clear.push("Subject");
    else doc.setSubject(meta.subject);
  }
  if (meta.creator !== undefined) {
    if (meta.creator === "") clear.push("Creator");
    else doc.setCreator(meta.creator);
  }
  if (meta.producer !== undefined) {
    if (meta.producer === "") clear.push("Producer");
    else doc.setProducer(meta.producer);
  }

  if (meta.keywords !== undefined) {
    if (!Array.isArray(meta.keywords)) {
      throw new PdfOpError(
        "Keywords have to be a list of words.",
        "Split what was typed on commas before saving it.",
      );
    }
    const words = meta.keywords.map((k) => String(k).trim()).filter((k) => k.length > 0);
    if (words.length === 0) clear.push("Keywords");
    // pdf-lib joins on a single space, which loses the boundary between two
    // word keywords. Commas survive the round trip through splitKeywords.
    else doc.setKeywords([words.join(", ")]);
  }

  if (meta.created !== undefined) {
    if (meta.created === null) clear.push("CreationDate");
    else {
      checkDate(meta.created, "created");
      doc.setCreationDate(meta.created);
    }
  }
  if (meta.modified !== undefined) {
    if (meta.modified === null) clear.push("ModDate");
    else {
      checkDate(meta.modified, "modified");
      doc.setModificationDate(meta.modified);
    }
  }

  if (clear.length > 0) await deleteInfoKeys(doc, clear);
  if (touched) await dropXmp(doc);

  return savePdf(doc);
}

/**
 * Remove the document properties.
 *
 * This is the privacy feature, and it is why anyone opens a metadata editor in
 * the first place. A PDF exported from Word carries your account name in
 * /Author, the file's original creation time in /CreationDate, and often a
 * second copy of both in an XMP block that nobody thinks to check. This clears
 * every Info entry, deletes the XMP packets, and sets both dates to the epoch
 * rather than deleting them, so a reader cannot fall back to a file timestamp
 * and the scrub is obvious to anyone who looks.
 *
 * Every entry, not the six this app shows. Word also writes /Company, Distiller
 * writes /SourceModified, macOS writes /AAPL:Keywords, and a template can put
 * anything it likes in there. Clearing only the properties with a box in the UI
 * would leave the rest of somebody's employer sitting in the file.
 *
 * What it does NOT remove: anything that lives inside the page content. A
 * scanner's watermark, a "printed by" line in a footer, a company logo, or
 * EXIF that was baked into a photo before it was embedded are all page
 * content, not metadata, and they survive this untouched. Redaction and the
 * image tools handle those. Attachments, form field values and digital
 * signatures also stay, since they are the document, not data about it.
 */
export async function stripMetadata(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);

  await clearInfo(doc);
  await dropXmp(doc);

  const epoch = new Date(0);
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);

  return savePdf(doc);
}
