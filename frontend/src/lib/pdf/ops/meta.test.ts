import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import { PdfOpError, blankPdf, loadPdf, savePdf } from "./common";
import { readMetadata, stripMetadata, writeMetadata } from "./meta";

const CREATED = new Date("2020-05-04T10:00:00.000Z");
const MODIFIED = new Date("2021-06-05T11:30:00.000Z");

/** A document with every property filled in, built with pdf-lib itself. */
async function metaFixture(pages = 1): Promise<Uint8Array> {
  const doc = await blankPdf();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  doc.setTitle("Apartment Lease");
  doc.setAuthor("A. Kadigari");
  doc.setSubject("Rental terms for 2026");
  doc.setKeywords(["lease", "rental", "2026"]);
  doc.setCreator("Clause");
  doc.setProducer("Clause 1.0");
  doc.setCreationDate(CREATED);
  doc.setModificationDate(MODIFIED);
  return savePdf(doc);
}

/**
 * Is this text still in the saved file at all?
 *
 * Taking a pointer out of the catalog makes a reader stop showing something.
 * It does not take the bytes out: pdf-lib writes every object it holds, so an
 * object nothing points at is still in the file for anyone who runs `strings`
 * on it or opens it with a parser. Small objects also travel inside compressed
 * object streams, so this looks at the parsed objects rather than the raw
 * bytes.
 */
async function stillInFile(bytes: Uint8Array, text: string): Promise<boolean> {
  if (new TextDecoder("latin1").decode(bytes).includes(text)) return true;
  const doc = await loadPdf(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (String(object).includes(text)) return true;
  }
  return false;
}

function sample(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../../../../backend/samples/${name}`, import.meta.url)),
  );
}

describe("readMetadata", () => {
  it("reads every property back out of a file it wrote", async () => {
    const meta = await readMetadata(await metaFixture(3));
    expect(meta.title).toBe("Apartment Lease");
    expect(meta.author).toBe("A. Kadigari");
    expect(meta.subject).toBe("Rental terms for 2026");
    expect(meta.keywords).toEqual(["lease", "rental", "2026"]);
    expect(meta.creator).toBe("Clause");
    expect(meta.producer).toBe("Clause 1.0");
    expect(meta.created?.getTime()).toBe(CREATED.getTime());
    expect(meta.modified?.getTime()).toBe(MODIFIED.getTime());
    expect(meta.pageCount).toBe(3);
    expect(meta.encrypted).toBe(false);
  });

  it("gives empty strings and nulls for a document with no properties", async () => {
    // Not blankPdf(): PDFDocument.create() stamps itself into the file, so a
    // truly bare document has to be asked for explicitly.
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]);
    const meta = await readMetadata(await savePdf(doc));
    expect(meta.title).toBe("");
    expect(meta.author).toBe("");
    expect(meta.keywords).toEqual([]);
    expect(meta.created).toBeNull();
    expect(meta.modified).toBeNull();
    expect(meta.pageCount).toBe(1);
  });

  it("sees the stamp pdf-lib puts on every document it creates", async () => {
    // Worth pinning down: anything built from blankPdf(), which is every
    // split, merge and extract result, comes out claiming pdf-lib made it and
    // carrying today's date. That is a privacy leak the ops that build new
    // documents have to clean up, and this test is where the fact is recorded.
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    const meta = await readMetadata(await savePdf(doc));
    expect(meta.producer).toContain("pdf-lib");
    expect(meta.creator).toContain("pdf-lib");
    expect(meta.created).not.toBeNull();

    // stripMetadata is the fix, and it works on a fresh document too.
    const cleaned = await readMetadata(await stripMetadata(await savePdf(doc)));
    expect(cleaned.producer).toBe("");
    expect(cleaned.creator).toBe("");
    expect(cleaned.created?.getTime()).toBe(0);
  });

  it("reads the real sample PDFs", async () => {
    for (const name of ["sample-apartment-lease.pdf", "sample-terms-of-service.pdf"]) {
      const meta = await readMetadata(sample(name));
      expect(meta.pageCount).toBeGreaterThan(0);
      expect(typeof meta.title).toBe("string");
      expect(Array.isArray(meta.keywords)).toBe(true);
    }
  });

  it("leaves the caller's bytes alone", async () => {
    const bytes = await metaFixture();
    const before = bytes.slice();
    await readMetadata(bytes);
    expect(bytes).toEqual(before);
  });
});

describe("the ugly file", () => {
  /**
   * The Info dictionary is the loosest part of a PDF and real files carry
   * junk in it: a date that was never a date, a title written as a number.
   * pdf-lib throws on both. A properties panel that dies on one bad entry is
   * worse than one that shows the entries it could read, so this checks the
   * good values still come through.
   */
  async function junkFixture(): Promise<Uint8Array> {
    const doc = await blankPdf();
    doc.addPage([300, 300]);
    doc.setAuthor("Real Author");
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of("CreationDate"), PDFString.of("last Tuesday"));
    info.set(PDFName.of("Title"), PDFNumber.of(42));
    return savePdf(doc);
  }

  it("skips the entries it cannot parse and keeps the rest", async () => {
    const meta = await readMetadata(await junkFixture());
    expect(meta.author).toBe("Real Author");
    expect(meta.title).toBe("");
    expect(meta.created).toBeNull();
    expect(meta.pageCount).toBe(1);
  });
});

describe("writeMetadata", () => {
  it("changes only what was passed in", async () => {
    const out = await writeMetadata(await metaFixture(2), { title: "Lease, signed" });
    const meta = await readMetadata(out);
    expect(meta.title).toBe("Lease, signed");
    expect(meta.author).toBe("A. Kadigari");
    expect(meta.subject).toBe("Rental terms for 2026");
    expect(meta.producer).toBe("Clause 1.0");
    expect(meta.created?.getTime()).toBe(CREATED.getTime());
    expect(meta.pageCount).toBe(2);
  });

  it("round trips keywords that have spaces in them", async () => {
    const out = await writeMetadata(await metaFixture(), {
      keywords: ["annual report", "2026 Q1", "draft"],
    });
    expect((await readMetadata(out)).keywords).toEqual(["annual report", "2026 Q1", "draft"]);
  });

  it("removes the entry when given an empty value", async () => {
    const out = await writeMetadata(await metaFixture(), {
      title: "",
      keywords: [],
      created: null,
    });
    const meta = await readMetadata(out);
    expect(meta.title).toBe("");
    expect(meta.keywords).toEqual([]);
    expect(meta.created).toBeNull();
    // Cleared means gone, not an empty string left sitting in the file.
    const doc = await loadPdf(out);
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    expect(info.get(PDFName.of("Title"))).toBeUndefined();
    expect(info.get(PDFName.of("CreationDate"))).toBeUndefined();
    // The properties that were not mentioned survive.
    expect(meta.author).toBe("A. Kadigari");
    expect(meta.modified?.getTime()).toBe(MODIFIED.getTime());
  });

  it("sets both dates when asked", async () => {
    const created = new Date("1999-12-31T23:00:00.000Z");
    const modified = new Date("2026-07-29T08:15:00.000Z");
    const meta = await readMetadata(
      await writeMetadata(await metaFixture(), { created, modified }),
    );
    expect(meta.created?.getTime()).toBe(created.getTime());
    expect(meta.modified?.getTime()).toBe(modified.getTime());
  });

  it("refuses a date that is not a date", async () => {
    const bytes = await metaFixture();
    await expect(writeMetadata(bytes, { created: new Date("nonsense") })).rejects.toThrow(
      PdfOpError,
    );
    await expect(writeMetadata(bytes, { modified: new Date("nonsense") })).rejects.toThrow(
      /not a real date/,
    );
  });

  it("ignores the read only properties instead of pretending to set them", async () => {
    const meta = await readMetadata(
      await writeMetadata(await metaFixture(2), { pageCount: 99, encrypted: true }),
    );
    expect(meta.pageCount).toBe(2);
    expect(meta.encrypted).toBe(false);
  });

  it("does not leave the old name behind in the XMP copy", async () => {
    // Changing the author has to mean changing it. Acrobat reads the XMP
    // packet in preference to the Info dictionary, so a packet left in place
    // quietly puts the old name back on screen.
    const doc = await loadPdf(await metaFixture());
    const packet = doc.context.stream(
      '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
        "<dc:creator>A. Kadigari</dc:creator><dc:title>Apartment Lease</dc:title>" +
        "</x:xmpmeta>",
      { Type: "Metadata", Subtype: "XML" },
    );
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(packet));
    const bytes = await savePdf(doc);

    const out = await writeMetadata(bytes, { author: "Anonymous" });
    expect((await readMetadata(out)).author).toBe("Anonymous");
    expect((await loadPdf(out)).catalog.get(PDFName.of("Metadata"))).toBeUndefined();
    expect(await stillInFile(out, "A. Kadigari")).toBe(false);
    // The properties nobody asked to change are still there.
    expect((await readMetadata(out)).subject).toBe("Rental terms for 2026");
  });

  it("leaves the file alone when only the read only fields are passed", async () => {
    const doc = await loadPdf(await metaFixture());
    const packet = doc.context.stream("<?xpacket begin=\"\"?>keep me", {
      Type: "Metadata",
      Subtype: "XML",
    });
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(packet));
    const out = await writeMetadata(await savePdf(doc), { pageCount: 9 });
    expect((await loadPdf(out)).catalog.get(PDFName.of("Metadata"))).toBeDefined();
  });

  it("works on a file that had no properties at all", async () => {
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    const meta = await readMetadata(
      await writeMetadata(await savePdf(doc), { title: "Untitled no more" }),
    );
    expect(meta.title).toBe("Untitled no more");
    expect(meta.author).toBe("");
  });
});

describe("stripMetadata", () => {
  /** The same fixture plus an XMP packet, which is where the second copy hides. */
  async function xmpFixture(): Promise<Uint8Array> {
    const doc = await loadPdf(await metaFixture());
    const packet = doc.context.stream(
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
        "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><dc:creator>A. Kadigari</dc:creator></x:xmpmeta>" +
        "<?xpacket end=\"w\"?>",
      { Type: "Metadata", Subtype: "XML" },
    );
    doc.catalog.set(PDFName.of("Metadata"), doc.context.register(packet));
    return savePdf(doc);
  }

  it("clears every property and sets both dates to the epoch", async () => {
    const meta = await readMetadata(await stripMetadata(await metaFixture(4)));
    expect(meta.title).toBe("");
    expect(meta.author).toBe("");
    expect(meta.subject).toBe("");
    expect(meta.keywords).toEqual([]);
    expect(meta.creator).toBe("");
    expect(meta.producer).toBe("");
    expect(meta.created?.getTime()).toBe(0);
    expect(meta.modified?.getTime()).toBe(0);
    // The document itself is untouched.
    expect(meta.pageCount).toBe(4);
  });

  it("leaves no entry behind in the Info dictionary", async () => {
    const doc = await loadPdf(await stripMetadata(await metaFixture()));
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    for (const key of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"]) {
      expect(info.get(PDFName.of(key))).toBeUndefined();
    }
  });

  it("drops the XMP packet, which is the copy people forget", async () => {
    const before = await xmpFixture();
    expect((await loadPdf(before)).catalog.get(PDFName.of("Metadata"))).toBeDefined();
    expect(await stillInFile(before, "A. Kadigari")).toBe(true);

    const after = await stripMetadata(before);
    expect((await loadPdf(after)).catalog.get(PDFName.of("Metadata"))).toBeUndefined();
    expect((await readMetadata(after)).author).toBe("");
    // The pointer being gone is not the same as the packet being gone. Left in
    // the file, the name comes straight back out of `strings`.
    expect(await stillInFile(after, "A. Kadigari")).toBe(false);
    expect(await stillInFile(after, "xpacket")).toBe(false);
  });

  it("drops a packet that hangs off a page as well as the catalog one", async () => {
    const doc = await loadPdf(await metaFixture(2));
    const packet = doc.context.stream(
      '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
        "<dc:creator>Scanner Operator</dc:creator></x:xmpmeta>",
      { Type: "Metadata", Subtype: "XML" },
    );
    doc.getPage(1).node.set(PDFName.of("Metadata"), doc.context.register(packet));
    const out = await stripMetadata(await savePdf(doc));

    expect(await stillInFile(out, "Scanner Operator")).toBe(false);
    expect((await loadPdf(out)).getPageCount()).toBe(2);
  });

  it("clears the entries no panel shows, not just the six with a box", async () => {
    // Word writes /Company, Distiller writes /SourceModified, macOS writes
    // /AAPL:Keywords. None of them are in the list of six.
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    doc.setAuthor("A. Kadigari");
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of("Company"), PDFString.of("Acme Corp"));
    info.set(PDFName.of("SourceModified"), PDFString.of("D:20260101120000"));
    info.set(PDFName.of("AAPL:Keywords"), PDFString.of("tax return"));
    const out = await stripMetadata(await savePdf(doc));

    const after = await loadPdf(out);
    const left = after.context
      .lookup(after.context.trailerInfo.Info, PDFDict)
      .keys()
      .map((k) => k.asString())
      .sort();
    // Only the two dates this puts back on purpose.
    expect(left).toEqual(["/CreationDate", "/ModDate"]);
    expect(await stillInFile(out, "Acme Corp")).toBe(false);
    expect(await stillInFile(out, "tax return")).toBe(false);
  });

  it("removes a property that was stored as its own object", async () => {
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of("Author"), doc.context.register(PDFString.of("Jane Q. Private")));
    const out = await stripMetadata(await savePdf(doc));

    expect((await readMetadata(out)).author).toBe("");
    expect(await stillInFile(out, "Jane Q. Private")).toBe(false);
  });

  it("works on a file that had nothing to strip", async () => {
    const doc = await blankPdf();
    doc.addPage([200, 200]);
    const meta = await readMetadata(await stripMetadata(await savePdf(doc)));
    expect(meta.title).toBe("");
    expect(meta.created?.getTime()).toBe(0);
    expect(meta.pageCount).toBe(1);
  });

  it("strips the real sample PDFs and keeps their pages", async () => {
    const before = await readMetadata(sample("sample-apartment-lease.pdf"));
    const after = await readMetadata(await stripMetadata(sample("sample-apartment-lease.pdf")));
    expect(after.pageCount).toBe(before.pageCount);
    expect(after.producer).toBe("");
    expect(after.creator).toBe("");
    expect(after.created?.getTime()).toBe(0);
  });
});
