import { readFileSync } from "node:fs";
// Type only. The classes themselves come from the lazy pdfLib() loader, the
// same way the module under test gets them.
import type { PDFArray, PDFDict } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { blankPdf, loadPdf, PdfOpError, pdfLib, savePdf } from "./common";
import { mergePdfs, type MergeInput } from "./merge";

/**
 * Build a document with a page per entry in `sizes`, each stamped with its own
 * label so the order of the merged result can be checked by reading it back.
 */
async function makeDoc(
  label: string,
  sizes: Array<[number, number]>,
  meta?: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string;
    creator?: string;
  },
): Promise<Uint8Array> {
  const { StandardFonts } = await pdfLib();
  const doc = await blankPdf();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`${label}-${i + 1}`, { x: 20, y: h - 40, size: 14, font });
  });
  if (meta?.title) doc.setTitle(meta.title);
  if (meta?.author) doc.setAuthor(meta.author);
  if (meta?.subject) doc.setSubject(meta.subject);
  if (meta?.keywords) doc.setKeywords([meta.keywords]);
  if (meta?.creator) doc.setCreator(meta.creator);
  return savePdf(doc);
}

/** A document with one text field per name, all on a single page. */
async function makeFormDoc(names: string[]): Promise<Uint8Array> {
  const doc = await blankPdf();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  names.forEach((n, i) => {
    const field = form.createTextField(n);
    field.setText(`value-of-${n}`);
    field.addToPage(page, { x: 20, y: 340 - i * 40, width: 250, height: 24 });
  });
  return savePdf(doc);
}

/** Page sizes of a saved document, rounded so float noise does not matter. */
async function sizesOf(bytes: Uint8Array): Promise<Array<[number, number]>> {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((p) => {
    const s = p.getSize();
    return [Math.round(s.width), Math.round(s.height)] as [number, number];
  });
}

const LETTER: [number, number] = [612, 792];
const A4: [number, number] = [595, 842];
const WIDE: [number, number] = [1000, 300];

describe("mergePdfs", () => {
  it("joins three documents of different page counts and keeps input order", async () => {
    const inputs: MergeInput[] = [
      { name: "one.pdf", bytes: await makeDoc("A", [LETTER, LETTER, LETTER]) },
      { name: "two.pdf", bytes: await makeDoc("B", [A4]) },
      { name: "three.pdf", bytes: await makeDoc("C", [WIDE, WIDE]) },
    ];

    const result = await mergePdfs(inputs);

    expect(result.pageCount).toBe(6);
    expect(result.sources).toEqual([
      { name: "one.pdf", pages: 3 },
      { name: "two.pdf", pages: 1 },
      { name: "three.pdf", pages: 2 },
    ]);

    // The sizes tell the order: three Letters, then one A4, then two wides.
    expect(await sizesOf(result.bytes)).toEqual([LETTER, LETTER, LETTER, A4, WIDE, WIDE]);
  });

  it("keeps every page at its original size and does not normalize anything", async () => {
    const odd: Array<[number, number]> = [
      [200, 200],
      [1224, 792],
      [100, 1000],
    ];
    const result = await mergePdfs([
      { name: "square-and-friends.pdf", bytes: await makeDoc("A", odd) },
      { name: "letter.pdf", bytes: await makeDoc("B", [LETTER]) },
    ]);

    expect(await sizesOf(result.bytes)).toEqual([...odd, LETTER]);
  });

  it("takes only the chosen pages when an input names them", async () => {
    const six: Array<[number, number]> = [
      [100, 100],
      [200, 200],
      [300, 300],
      [400, 400],
      [500, 500],
      [600, 600],
    ];
    const result = await mergePdfs([
      { name: "big.pdf", bytes: await makeDoc("A", six), pages: [0, 2, 4] },
      { name: "small.pdf", bytes: await makeDoc("B", [[700, 700]]) },
    ]);

    expect(result.pageCount).toBe(4);
    expect(result.sources[0]).toEqual({ name: "big.pdf", pages: 3 });
    expect(await sizesOf(result.bytes)).toEqual([
      [100, 100],
      [300, 300],
      [500, 500],
      [700, 700],
    ]);
  });

  it("takes a page selection in document order, not in the order it was typed", async () => {
    // Documented behaviour: a selection is a set of pages, not a reordering.
    const result = await mergePdfs([
      {
        name: "backwards.pdf",
        bytes: await makeDoc("A", [
          [100, 100],
          [200, 200],
          [300, 300],
        ]),
        pages: [2, 0, 2],
      },
      { name: "tail.pdf", bytes: await makeDoc("B", [[900, 900]]) },
    ]);

    expect(await sizesOf(result.bytes)).toEqual([
      [100, 100],
      [300, 300],
      [900, 900],
    ]);
  });

  it("refuses a one input call, and an empty one", async () => {
    const only: MergeInput[] = [{ name: "alone.pdf", bytes: await makeDoc("A", [LETTER]) }];

    await expect(mergePdfs(only)).rejects.toBeInstanceOf(PdfOpError);
    await expect(mergePdfs(only)).rejects.toThrow(/at least two files/i);
    await expect(mergePdfs([])).rejects.toThrow(/no files to merge/i);
  });

  it("reports progress once per input, naming each one", async () => {
    const seen: Array<[number, number, string | undefined]> = [];
    const onProgress = vi.fn((done: number, total: number, label?: string) => {
      seen.push([done, total, label]);
    });

    await mergePdfs(
      [
        { name: "first.pdf", bytes: await makeDoc("A", [LETTER, LETTER]) },
        { name: "second.pdf", bytes: await makeDoc("B", [A4]) },
        { name: "third.pdf", bytes: await makeDoc("C", [WIDE]) },
      ],
      onProgress,
    );

    expect(seen).toEqual([
      [1, 3, "first.pdf"],
      [2, 3, "second.pdf"],
      [3, 3, "third.pdf"],
    ]);
  });

  it("fails the whole merge and names the file that broke it", async () => {
    const junk = new TextEncoder().encode("this is not a PDF, it is a note to self");
    const inputs: MergeInput[] = [
      { name: "good.pdf", bytes: await makeDoc("A", [LETTER]) },
      { name: "broken-invoice.pdf", bytes: junk },
      { name: "also-good.pdf", bytes: await makeDoc("C", [A4]) },
    ];

    await expect(mergePdfs(inputs)).rejects.toThrow(/broken-invoice\.pdf/);
    await expect(mergePdfs(inputs)).rejects.toBeInstanceOf(PdfOpError);
  });

  it("names the file when its page selection is entirely out of range", async () => {
    const inputs: MergeInput[] = [
      { name: "two-pager.pdf", bytes: await makeDoc("A", [LETTER, LETTER]), pages: [7, 8] },
      { name: "other.pdf", bytes: await makeDoc("B", [A4]) },
    ];

    await expect(mergePdfs(inputs)).rejects.toThrow(/two-pager\.pdf/);
    await expect(mergePdfs(inputs)).rejects.toThrow(/2 pages/);
  });

  it("stops and names the page numbers when only some of them exist", async () => {
    // The dangerous case: page 1 is real so the merge would succeed, and the
    // result would quietly be one page shorter than the person asked for.
    const inputs: MergeInput[] = [
      { name: "two-pager.pdf", bytes: await makeDoc("A", [LETTER, LETTER]), pages: [0, 99] },
      { name: "other.pdf", bytes: await makeDoc("B", [A4]) },
    ];

    await expect(mergePdfs(inputs)).rejects.toBeInstanceOf(PdfOpError);
    await expect(mergePdfs(inputs)).rejects.toThrow(/two-pager\.pdf/);
    // Named in the way the page box counts, so page index 99 reads as page 100.
    await expect(mergePdfs(inputs)).rejects.toThrow(/no page 100/);
    await expect(mergePdfs(inputs)).rejects.toThrow(/2 pages/);
  });

  it("stops on a negative or fractional page number", async () => {
    await expect(
      mergePdfs([
        { name: "three.pdf", bytes: await makeDoc("A", [LETTER, LETTER, LETTER]), pages: [-1, 1.5, 1] },
        { name: "other.pdf", bytes: await makeDoc("B", [A4]) },
      ]),
    ).rejects.toThrow(/no pages -1, 1\.5/);
  });

  it("says nothing was picked when the selection is empty", async () => {
    await expect(
      mergePdfs([
        { name: "two.pdf", bytes: await makeDoc("A", [LETTER, LETTER]), pages: [] },
        { name: "other.pdf", bytes: await makeDoc("B", [A4]) },
      ]),
    ).rejects.toThrow(/No pages were picked for "two\.pdf"/);
  });

  it("refuses a gap in the list rather than merging around it", async () => {
    // A hole here used to be skipped, which passed the two file check and then
    // returned a one file merge reporting success.
    const holed = [
      { name: "a.pdf", bytes: await makeDoc("A", [LETTER]) },
      undefined as unknown as MergeInput,
    ];
    await expect(mergePdfs(holed)).rejects.toThrow(/File 2 of 2 .*is missing/);
  });

  it("carries the first input's metadata and stamps its own producer", async () => {
    const result = await mergePdfs([
      {
        name: "lease.pdf",
        bytes: await makeDoc("A", [LETTER], {
          title: "Apartment Lease",
          author: "Ruhi",
          subject: "Tenancy",
          keywords: "lease, rent, 2026",
          creator: "Some Word Processor",
        }),
      },
      {
        name: "addendum.pdf",
        bytes: await makeDoc("B", [A4], { title: "Should Not Win", author: "Nobody" }),
      },
    ]);

    const doc = await loadPdf(result.bytes);
    expect(doc.getTitle()).toBe("Apartment Lease");
    expect(doc.getAuthor()).toBe("Ruhi");
    expect(doc.getSubject()).toBe("Tenancy");
    expect(doc.getKeywords()).toBe("lease, rent, 2026");
    expect(doc.getCreator()).toBe("Some Word Processor");
    expect(doc.getProducer()).toMatch(/Clause/);
  });

  it("survives an input whose metadata is missing", async () => {
    // pdf-lib stamps its own Creator and Producer on any document it makes, so
    // a genuinely bare file has to be built by clearing the Info dictionary.
    const { PDFDict } = await pdfLib();
    const bare = await blankPdf();
    bare.addPage([...LETTER]);
    const info = bare.context.lookup(bare.context.trailerInfo.Info);
    expect(info).toBeInstanceOf(PDFDict);
    if (info instanceof PDFDict) {
      for (const key of info.keys()) info.delete(key);
    }

    const result = await mergePdfs([
      { name: "bare.pdf", bytes: await savePdf(bare) },
      { name: "also-bare.pdf", bytes: await makeDoc("B", [A4]) },
    ]);

    const doc = await loadPdf(result.bytes);
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getProducer()).toMatch(/Clause/);
    // With no creator to carry, the file should credit this tool rather than
    // whatever library happened to write the bytes.
    expect(doc.getCreator()).toMatch(/Clause/);
  });

  it("keeps rotation and a non-zero MediaBox origin exactly as they were", async () => {
    const { degrees, StandardFonts } = await pdfLib();
    const src = await blankPdf();
    const font = await src.embedFont(StandardFonts.Helvetica);
    const odd = src.addPage([400, 250]);
    odd.setMediaBox(12, 30, 400, 250);
    odd.setRotation(degrees(90));
    odd.drawText("rotated", { x: 20, y: 40, size: 12, font });
    src.addPage([300, 300]);

    const result = await mergePdfs([
      { name: "rotated.pdf", bytes: await savePdf(src) },
      { name: "plain.pdf", bytes: await makeDoc("B", [LETTER]) },
    ]);

    const doc = await loadPdf(result.bytes);
    const first = doc.getPages()[0];
    expect(first).toBeDefined();
    const box = first!.getMediaBox();
    expect(box.x).toBe(12);
    expect(box.y).toBe(30);
    expect(box.width).toBe(400);
    expect(box.height).toBe(250);
    expect(first!.getRotation().angle).toBe(90);

    const third = doc.getPages()[2];
    expect(third!.getRotation().angle).toBe(0);
    expect(Math.round(third!.getSize().width)).toBe(612);
  });

  it("does not touch the caller's byte arrays", async () => {
    const a = await makeDoc("A", [LETTER]);
    const b = await makeDoc("B", [A4]);
    const beforeA = a.slice();
    const beforeB = b.slice();

    await mergePdfs([
      { name: "a.pdf", bytes: a },
      { name: "b.pdf", bytes: b },
    ]);

    expect(a).toEqual(beforeA);
    expect(b).toEqual(beforeB);
  });

  it("handles a one page document on both sides", async () => {
    const result = await mergePdfs([
      { name: "single-a.pdf", bytes: await makeDoc("A", [LETTER]) },
      { name: "single-b.pdf", bytes: await makeDoc("B", [A4]) },
    ]);

    expect(result.pageCount).toBe(2);
    expect(await sizesOf(result.bytes)).toEqual([LETTER, A4]);
  });

  it("merges the two real sample PDFs", async () => {
    const dir = new URL("../../../../../backend/samples/", import.meta.url).pathname;
    const lease = new Uint8Array(readFileSync(`${dir}sample-apartment-lease.pdf`));
    const terms = new Uint8Array(readFileSync(`${dir}sample-terms-of-service.pdf`));

    const result = await mergePdfs([
      { name: "sample-apartment-lease.pdf", bytes: lease },
      { name: "sample-terms-of-service.pdf", bytes: terms },
    ]);

    expect(result.pageCount).toBe(5);
    expect(result.sources).toEqual([
      { name: "sample-apartment-lease.pdf", pages: 3 },
      { name: "sample-terms-of-service.pdf", pages: 2 },
    ]);
    expect(await sizesOf(result.bytes)).toEqual([
      LETTER,
      LETTER,
      LETTER,
      LETTER,
      LETTER,
    ]);
  });

  describe("form fields", () => {
    it("keeps fields fillable instead of orphaning them, which is what pdf-lib does alone", async () => {
      const result = await mergePdfs([
        { name: "form-a.pdf", bytes: await makeFormDoc(["tenant", "start-date"]) },
        { name: "form-b.pdf", bytes: await makeFormDoc(["landlord"]) },
      ]);

      const doc = await loadPdf(result.bytes);
      const names = doc
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names).toEqual(["tenant", "start-date", "landlord"]);
      expect(doc.getForm().getTextField("tenant").getText()).toBe("value-of-tenant");
      expect(doc.getForm().getTextField("landlord").getText()).toBe("value-of-landlord");
    });

    it("renames a colliding field so the two stay independent", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await mergePdfs([
          { name: "form-a.pdf", bytes: await makeFormDoc(["name", "date"]) },
          { name: "form-b.pdf", bytes: await makeFormDoc(["name", "email"]) },
          { name: "form-c.pdf", bytes: await makeFormDoc(["name"]) },
        ]);

        const doc = await loadPdf(result.bytes);
        const form = doc.getForm();
        expect(form.getFields().map((f) => f.getName())).toEqual([
          "name",
          "date",
          "name (2)",
          "email",
          "name (3)",
        ]);

        // The point of the rename: typing in one must not fill the others.
        form.getTextField("name").setText("Ruhi");
        const again = await loadPdf(await savePdf(doc));
        const back = again.getForm();
        expect(back.getTextField("name").getText()).toBe("Ruhi");
        expect(back.getTextField("name (2)").getText()).toBe("value-of-name");
        expect(back.getTextField("name (3)").getText()).toBe("value-of-name");

        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it("leaves a plain merge with no form alone", async () => {
      const { PDFName } = await pdfLib();
      const result = await mergePdfs([
        { name: "a.pdf", bytes: await makeDoc("A", [LETTER]) },
        { name: "b.pdf", bytes: await makeDoc("B", [A4]) },
      ]);

      const doc = await loadPdf(result.bytes);
      expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
    });

    it("does not mistake a link annotation for a form field", async () => {
      const { PDFName, PDFString } = await pdfLib();
      const src = await blankPdf();
      const page = src.addPage([400, 400]);
      // A link annotation lives in /Annots next to widgets, and registering it
      // as a field would produce a nameless entry in the merged form.
      const link = src.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com") },
      });
      page.node.set(PDFName.of("Annots"), src.context.obj([src.context.register(link)]));

      const result = await mergePdfs([
        { name: "linky.pdf", bytes: await savePdf(src) },
        { name: "form.pdf", bytes: await makeFormDoc(["signature"]) },
      ]);

      const doc = await loadPdf(result.bytes);
      expect(doc.getForm().getFields().map((f) => f.getName())).toEqual(["signature"]);
    });

    it("keeps two nameless fields apart instead of merging them into one", async () => {
      const { PDFName, PDFString } = await pdfLib();
      // A widget that is its own field but carries no /T. Its fully qualified
      // name is the empty string, so two of them from two files are one field
      // with two widgets as far as a reader is concerned.
      async function nameless(): Promise<Uint8Array> {
        const doc = await blankPdf();
        const page = doc.addPage([400, 400]);
        const widget = doc.context.obj({
          Type: "Annot",
          Subtype: "Widget",
          FT: "Tx",
          V: PDFString.of("typed here"),
          Rect: [20, 300, 270, 324],
        });
        const ref = doc.context.register(widget);
        page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
        doc.catalog.getOrCreateAcroForm().addField(ref);
        return savePdf(doc);
      }

      const result = await mergePdfs([
        { name: "a.pdf", bytes: await nameless() },
        { name: "b.pdf", bytes: await nameless() },
      ]);

      const doc = await loadPdf(result.bytes);
      expect(doc.getForm().getFields().map((f) => f.getName())).toEqual(["Field", "Field (2)"]);
    });

    it("carries NeedAppearances so a form that relies on it is not blank", async () => {
      const { PDFName, PDFBool } = await pdfLib();
      const src = await loadPdf(await makeFormDoc(["notes"]));
      src.catalog.getOrCreateAcroForm().dict.set(PDFName.of("NeedAppearances"), PDFBool.True);

      const result = await mergePdfs([
        { name: "needs-it.pdf", bytes: await savePdf(src) },
        { name: "plain.pdf", bytes: await makeDoc("B", [A4]) },
      ]);

      const doc = await loadPdf(result.bytes);
      const acro = doc.catalog.getAcroForm();
      expect(acro?.dict.lookup(PDFName.of("NeedAppearances"))).toBe(PDFBool.True);
    });

    it("carries the donor form's default font and resources", async () => {
      // pdf-lib's own forms carry neither /DA nor /DR, so a form built by any
      // other tool is the only way to actually exercise this.
      const { PDFName, PDFString, PDFDict, StandardFonts } = await pdfLib();
      const src = await blankPdf();
      const page = src.addPage([400, 400]);
      const form = src.getForm();
      const field = form.createTextField("amount");
      field.setText("42");
      field.addToPage(page, { x: 20, y: 300, width: 200, height: 24 });

      const helv = await src.embedFont(StandardFonts.Helvetica);
      const acro = src.catalog.getOrCreateAcroForm();
      acro.dict.set(PDFName.of("DA"), PDFString.of("/Helv 12 Tf 0 g"));
      acro.dict.set(PDFName.of("DR"), src.context.obj({ Font: { Helv: helv.ref } }));

      const result = await mergePdfs([
        { name: "acrobat-ish.pdf", bytes: await savePdf(src) },
        { name: "plain.pdf", bytes: await makeDoc("B", [A4]) },
      ]);

      const doc = await loadPdf(result.bytes);
      const merged = doc.catalog.getAcroForm();
      expect(merged?.dict.lookup(PDFName.of("DA"))?.toString()).toBe("(/Helv 12 Tf 0 g)");

      // /DR has to arrive with the font behind it, not just the name of one.
      const dr = merged?.dict.lookup(PDFName.of("DR"));
      expect(dr).toBeInstanceOf(PDFDict);
      const fonts = (dr as PDFDict).lookup(PDFName.of("Font"));
      expect(fonts).toBeInstanceOf(PDFDict);
      const carried = (fonts as PDFDict).lookup(PDFName.of("Helv"));
      expect(carried).toBeInstanceOf(PDFDict);
      expect((carried as PDFDict).lookup(PDFName.of("BaseFont"))?.toString()).toBe(
        "/Helvetica",
      );
    });
  });

  /**
   * pdf-lib's copyPages copies a page twice when anything inside it refers back
   * to that page: once into the page tree, and once as a stranded duplicate
   * that the reference then points at. Nothing about it is visible in a page
   * count or a thumbnail, so these check the object graph directly.
   */
  describe("internal references", () => {
    /** Refs of every /Type /Page object in the file, and which are real pages. */
    async function pageObjects(bytes: Uint8Array) {
      const { PDFName, PDFDict } = await pdfLib();
      const doc = await loadPdf(bytes);
      const inTree = new Set(doc.getPages().map((p) => p.ref.toString()));
      const all: string[] = [];
      for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of("Type")) === PDFName.of("Page")) {
          all.push(ref.toString());
        }
      }
      return { doc, all, inTree };
    }

    it("leaves a link's destination pointing at a page that is really there", async () => {
      const { PDFName, PDFArray } = await pdfLib();
      const src = await blankPdf();
      const first = src.addPage([400, 400]);
      const second = src.addPage([400, 400]);
      // A table of contents entry: click on page 1, land on page 2.
      const link = src.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        P: first.ref,
        Dest: [second.ref, PDFName.of("Fit")],
      });
      first.node.set(PDFName.of("Annots"), src.context.obj([src.context.register(link)]));

      const result = await mergePdfs([
        { name: "contents.pdf", bytes: await savePdf(src) },
        { name: "appendix.pdf", bytes: await makeDoc("B", [A4]) },
      ]);

      const { doc, all, inTree } = await pageObjects(result.bytes);
      expect(all.length).toBe(3);
      expect(inTree.size).toBe(3);

      const annots = doc.getPages()[0]!.node.Annots()!;
      const annot = doc.context.lookup(annots.get(0));
      const dest = (annot as PDFDict).lookup(PDFName.of("Dest"));
      expect(dest).toBeInstanceOf(PDFArray);
      const target = (dest as PDFArray).get(0).toString();

      // The whole point: the destination is the merged document's second page,
      // not a copy of it that lives outside the page tree.
      expect(inTree.has(target)).toBe(true);
      expect(target).toBe(doc.getPages()[1]!.ref.toString());
    });

    it("points every widget at the page it is actually sitting on", async () => {
      const { PDFName } = await pdfLib();
      const result = await mergePdfs([
        { name: "form-a.pdf", bytes: await makeFormDoc(["one"]) },
        { name: "form-b.pdf", bytes: await makeFormDoc(["two"]) },
      ]);

      const { doc, all } = await pageObjects(result.bytes);
      // Two pages in, two page objects out. Four means the duplicates are back.
      expect(all.length).toBe(2);

      doc.getPages().forEach((page) => {
        const annots = page.node.Annots()!;
        expect(annots.size()).toBe(1);
        const widget = doc.context.lookup(annots.get(0)) as PDFDict;
        expect(widget.get(PDFName.of("P"))?.toString()).toBe(page.ref.toString());
      });
    });

    it("does not duplicate a page just because it carries any annotation", async () => {
      const { PDFName, PDFString } = await pdfLib();
      const src = await blankPdf();
      const page = src.addPage([400, 400]);
      const link = src.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        P: page.ref,
        A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com") },
      });
      page.node.set(PDFName.of("Annots"), src.context.obj([src.context.register(link)]));

      const result = await mergePdfs([
        { name: "linky.pdf", bytes: await savePdf(src) },
        { name: "plain.pdf", bytes: await makeDoc("B", [A4]) },
      ]);

      const { all, inTree } = await pageObjects(result.bytes);
      expect(all.length).toBe(2);
      expect(inTree.size).toBe(2);
    });

    it("does not smuggle an unpicked page into the result through a link", async () => {
      // Page 1 links to page 3, and only pages 1 and 2 are taken. The target
      // gets copied because the link names it, but it must not turn into a page
      // of the merged document. A link to somewhere that was left out is a dead
      // link, which is the honest outcome, not a surprise fourth page.
      const { PDFName } = await pdfLib();
      const src = await blankPdf();
      const first = src.addPage([400, 400]);
      src.addPage([500, 500]);
      const third = src.addPage([600, 600]);
      const link = src.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        P: first.ref,
        Dest: [third.ref, PDFName.of("Fit")],
      });
      first.node.set(PDFName.of("Annots"), src.context.obj([src.context.register(link)]));

      const result = await mergePdfs([
        { name: "part.pdf", bytes: await savePdf(src), pages: [0, 1] },
        { name: "tail.pdf", bytes: await makeDoc("B", [[300, 300]]) },
      ]);

      expect(result.pageCount).toBe(3);
      expect(await sizesOf(result.bytes)).toEqual([
        [400, 400],
        [500, 500],
        [300, 300],
      ]);
    });

    it("keeps the two copies apart when the same file is merged with itself", async () => {
      // Copying by reference is what makes links land, and the risk it carries
      // is that the second copy reuses the first copy's pages. It must not:
      // each half of the result gets its own pages and its own links.
      const { PDFName } = await pdfLib();
      const src = await blankPdf();
      const first = src.addPage([400, 400]);
      const second = src.addPage([500, 500]);
      const link = src.context.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [10, 10, 100, 40],
        P: first.ref,
        Dest: [second.ref, PDFName.of("Fit")],
      });
      first.node.set(PDFName.of("Annots"), src.context.obj([src.context.register(link)]));
      const bytes = await savePdf(src);

      const result = await mergePdfs([
        { name: "twice.pdf", bytes },
        { name: "twice.pdf", bytes },
      ]);

      const doc = await loadPdf(result.bytes);
      expect(doc.getPageCount()).toBe(4);
      const refs = doc.getPages().map((p) => p.ref.toString());
      expect(new Set(refs).size).toBe(4);

      // Each copy's link points at its own next page, not at the other copy's.
      for (const start of [0, 2]) {
        const annots = doc.getPages()[start]!.node.Annots()!;
        const annot = doc.context.lookup(annots.get(0)) as PDFDict;
        const dest = annot.lookup(PDFName.of("Dest")) as PDFArray;
        expect(dest.get(0).toString()).toBe(refs[start + 1]);
      }
    });
  });
});
