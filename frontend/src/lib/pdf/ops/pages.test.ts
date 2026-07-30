import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { blankPdf, loadPdf, pageBoxOf, PdfOpError, pdfLib, savePdf } from "./common";
import {
  deletePages,
  duplicatePages,
  extractPages,
  insertBlankPage,
  movePage,
  reorderPages,
  rotatePages,
} from "./pages";

/**
 * Pages are told apart by width. Page i is (200 + i) points wide, so after any
 * shuffle the widths read straight back as the old page numbers. pdf-lib has no
 * text extraction, so this is the identity check that works without pdf.js.
 */
async function makeDoc(count: number): Promise<Uint8Array> {
  const doc = await blankPdf();
  const { StandardFonts } = await pdfLib();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([200 + i, 400]);
    page.drawText(`page ${i + 1}`, { x: 20, y: 40, size: 12, font });
  }
  doc.setTitle("Apartment lease");
  doc.setAuthor("Ada Byron");
  doc.setSubject("Tenancy");
  doc.setKeywords(["lease", "rent"]);
  doc.setCreator("Clause");
  doc.setProducer("Clause web");
  return savePdf(doc);
}

/** The old page number of every page, in order, read back from the widths. */
async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await loadPdf(bytes);
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

async function rotationOf(bytes: Uint8Array, index: number): Promise<number> {
  const doc = await loadPdf(bytes);
  return pageBoxOf(doc.getPage(index)).rotation;
}

// Relative to this file, not to whoever's machine wrote it. An absolute path
// here passes locally and fails on every other computer, including CI.
const SAMPLE = fileURLToPath(
  new URL("../../../../../backend/samples/sample-apartment-lease.pdf", import.meta.url),
);

describe("rotatePages", () => {
  it("composes through all four quadrants and folds 360 back to 0", async () => {
    let bytes = await makeDoc(1);
    expect(await rotationOf(bytes, 0)).toBe(0);

    bytes = await rotatePages(bytes, [0], 90);
    expect(await rotationOf(bytes, 0)).toBe(90);

    bytes = await rotatePages(bytes, [0], 90);
    expect(await rotationOf(bytes, 0)).toBe(180);

    bytes = await rotatePages(bytes, [0], 90);
    expect(await rotationOf(bytes, 0)).toBe(270);

    // The one that catches a naive implementation: 270 + 90 must be 0.
    bytes = await rotatePages(bytes, [0], 90);
    expect(await rotationOf(bytes, 0)).toBe(0);
  });

  it("adds to whatever the page already carries", async () => {
    let bytes = await makeDoc(1);
    bytes = await rotatePages(bytes, [0], 180);
    bytes = await rotatePages(bytes, [0], 270);
    expect(await rotationOf(bytes, 0)).toBe(90);
  });

  it("goes backwards for a negative turn", async () => {
    let bytes = await makeDoc(1);
    bytes = await rotatePages(bytes, [0], -90);
    expect(await rotationOf(bytes, 0)).toBe(270);
    bytes = await rotatePages(bytes, [0], -90);
    expect(await rotationOf(bytes, 0)).toBe(180);
  });

  it("starts from an angle the file already had, including a negative one", async () => {
    const doc = await blankPdf();
    const { degrees } = await pdfLib();
    const page = doc.addPage([200, 400]);
    page.setRotation(degrees(-90));
    const bytes = await rotatePages(await savePdf(doc), [0], 90);
    expect(await rotationOf(bytes, 0)).toBe(0);
  });

  it("leaves the pages that were not selected alone", async () => {
    const bytes = await rotatePages(await makeDoc(3), [1], 90);
    expect(await rotationOf(bytes, 0)).toBe(0);
    expect(await rotationOf(bytes, 1)).toBe(90);
    expect(await rotationOf(bytes, 2)).toBe(0);
  });

  it("refuses a turn that is not a quarter", async () => {
    const bytes = await makeDoc(2);
    await expect(rotatePages(bytes, [0], 45)).rejects.toBeInstanceOf(PdfOpError);
    await expect(rotatePages(bytes, [0], 45)).rejects.toThrow(/quarter turn/);
  });

  it("refuses an empty selection", async () => {
    const bytes = await makeDoc(2);
    await expect(rotatePages(bytes, [], 90)).rejects.toThrow(/No pages were selected/);
  });
});

describe("deletePages", () => {
  it("drops the chosen pages and keeps the rest in order", async () => {
    const bytes = await deletePages(await makeDoc(5), [1, 3]);
    expect(await widths(bytes)).toEqual([200, 202, 204]);
  });

  it("refuses to delete every page", async () => {
    const bytes = await makeDoc(3);
    await expect(deletePages(bytes, [0, 1, 2])).rejects.toBeInstanceOf(PdfOpError);
    await expect(deletePages(bytes, [0, 1, 2])).rejects.toThrow(
      /would delete all 3 pages, and a PDF with no pages is not a valid file/,
    );
  });

  it("refuses to empty a one page document", async () => {
    await expect(deletePages(await makeDoc(1), [0])).rejects.toThrow(/all 1 page/);
  });

  it("ignores repeats and out of range indexes when counting what is left", async () => {
    const bytes = await deletePages(await makeDoc(3), [0, 0, 0, 9]);
    expect(await widths(bytes)).toEqual([201, 202]);
  });

  it("keeps the metadata", async () => {
    const bytes = await deletePages(await makeDoc(4), [0]);
    const doc = await loadPdf(bytes);
    expect(doc.getTitle()).toBe("Apartment lease");
    expect(doc.getAuthor()).toBe("Ada Byron");
    expect(doc.getSubject()).toBe("Tenancy");
    expect(doc.getKeywords()).toBe("lease rent");
    expect(doc.getCreator()).toBe("Clause");
    expect(doc.getProducer()).toBe("Clause web");
  });

  it("does not touch the bytes it was handed", async () => {
    const bytes = await makeDoc(3);
    const before = bytes.slice();
    await deletePages(bytes, [1]);
    expect(bytes).toEqual(before);
  });
});

describe("reorderPages", () => {
  it("puts the pages where order[newPosition] = oldIndex says", async () => {
    const bytes = await reorderPages(await makeDoc(4), [2, 0, 3, 1]);
    expect(await widths(bytes)).toEqual([202, 200, 203, 201]);
  });

  it("accepts the identity order", async () => {
    const bytes = await reorderPages(await makeDoc(3), [0, 1, 2]);
    expect(await widths(bytes)).toEqual([200, 201, 202]);
  });

  it("rejects a short order and says how many it wanted", async () => {
    const bytes = await makeDoc(4);
    await expect(reorderPages(bytes, [1, 0])).rejects.toBeInstanceOf(PdfOpError);
    await expect(reorderPages(bytes, [1, 0])).rejects.toThrow(
      /lists 2 positions but the document has 4 pages/,
    );
  });

  it("rejects a long order", async () => {
    const bytes = await makeDoc(2);
    await expect(reorderPages(bytes, [0, 1, 1])).rejects.toThrow(/lists 3 positions/);
  });

  it("rejects a repeat instead of silently repairing it", async () => {
    const bytes = await makeDoc(3);
    // Counted from 0, the same way the out of range message counts.
    await expect(reorderPages(bytes, [0, 1, 1])).rejects.toThrow(/uses page 1 more than once/);
  });

  it("rejects an index that is not a page", async () => {
    const bytes = await makeDoc(3);
    await expect(reorderPages(bytes, [0, 1, 3])).rejects.toThrow(
      /contains 3, which is not a page in a 3 page document/,
    );
    await expect(reorderPages(bytes, [0, 1, -1])).rejects.toThrow(/contains -1/);
    await expect(reorderPages(bytes, [0, 1, 1.5])).rejects.toThrow(/contains 1.5/);
  });

  it("keeps the metadata through the rebuild", async () => {
    const bytes = await reorderPages(await makeDoc(3), [2, 1, 0]);
    const doc = await loadPdf(bytes);
    expect(doc.getTitle()).toBe("Apartment lease");
    expect(doc.getProducer()).toBe("Clause web");
  });
});

describe("movePage", () => {
  it("moves a page forward, landing at the position after the lift", async () => {
    const bytes = await movePage(await makeDoc(4), 0, 3);
    expect(await widths(bytes)).toEqual([201, 202, 203, 200]);
  });

  it("moves a page backward", async () => {
    const bytes = await movePage(await makeDoc(4), 3, 0);
    expect(await widths(bytes)).toEqual([203, 200, 201, 202]);
  });

  it("moves a page into the middle", async () => {
    const bytes = await movePage(await makeDoc(5), 4, 2);
    expect(await widths(bytes)).toEqual([200, 201, 204, 202, 203]);
  });

  it("is a no-op when it lands where it started", async () => {
    const bytes = await movePage(await makeDoc(3), 1, 1);
    expect(await widths(bytes)).toEqual([200, 201, 202]);
  });

  it("rejects a source or a target outside the document", async () => {
    const bytes = await makeDoc(3);
    await expect(movePage(bytes, 5, 0)).rejects.toThrow(/no page 5 to move/);
    await expect(movePage(bytes, 0, 3)).rejects.toThrow(/Position 3 is not somewhere/);
  });
});

describe("duplicatePages", () => {
  it("puts each copy directly after its original", async () => {
    const bytes = await duplicatePages(await makeDoc(4), [0, 2]);
    expect(await widths(bytes)).toEqual([200, 200, 201, 202, 202, 203]);
  });

  it("makes copies that stand on their own", async () => {
    const dup = await duplicatePages(await makeDoc(2), [0]);
    const rotated = await rotatePages(dup, [1], 90);
    expect(await rotationOf(rotated, 0)).toBe(0);
    expect(await rotationOf(rotated, 1)).toBe(90);
  });

  it("counts a repeated request once", async () => {
    const bytes = await duplicatePages(await makeDoc(2), [1, 1, 1]);
    expect(await widths(bytes)).toEqual([200, 201, 201]);
  });

  it("refuses an empty selection", async () => {
    await expect(duplicatePages(await makeDoc(2), [])).rejects.toThrow(/No pages were selected/);
  });
});

describe("extractPages", () => {
  it("returns a new document holding only those pages, in the order given", async () => {
    const bytes = await extractPages(await makeDoc(5), [4, 0, 2]);
    expect(await widths(bytes)).toEqual([204, 200, 202]);
  });

  it("carries the metadata into the new document", async () => {
    const doc = await loadPdf(await extractPages(await makeDoc(3), [1]));
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe("Apartment lease");
    expect(doc.getAuthor()).toBe("Ada Byron");
  });

  it("drops out of range indexes but keeps the order of what is left", async () => {
    const bytes = await extractPages(await makeDoc(3), [2, 99, 0]);
    expect(await widths(bytes)).toEqual([202, 200]);
  });

  it("refuses a selection with nothing usable in it", async () => {
    await expect(extractPages(await makeDoc(3), [7, 8])).rejects.toThrow(/No pages were selected/);
  });
});

describe("insertBlankPage", () => {
  it("copies the size of the page it lands in front of", async () => {
    const bytes = await insertBlankPage(await makeDoc(3), 1);
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBe(4);
    expect(Math.round(doc.getPage(1).getWidth())).toBe(201);
    expect(Math.round(doc.getPage(1).getHeight())).toBe(400);
    // The page it displaced is still there, right behind it.
    expect(Math.round(doc.getPage(2).getWidth())).toBe(201);
  });

  it("matches a landscape neighbour that is landscape by its box", async () => {
    const doc = await blankPdf();
    doc.addPage([800, 400]);
    const bytes = await insertBlankPage(await savePdf(doc), 0);
    const out = await loadPdf(bytes);
    const box = pageBoxOf(out.getPage(0));
    expect([box.width, box.height]).toEqual([800, 400]);
    expect(box.rotation).toBe(0);
  });

  it("matches a landscape neighbour that is landscape by its rotation", async () => {
    const doc = await blankPdf();
    const { degrees } = await pdfLib();
    // Portrait box turned a quarter, which is how most scanners write
    // landscape. Copying the box alone would give a portrait blank here.
    const page = doc.addPage([400, 800]);
    page.setRotation(degrees(90));

    const bytes = await insertBlankPage(await savePdf(doc), 0);
    const out = await loadPdf(bytes);
    const fresh = pageBoxOf(out.getPage(0));
    const neighbour = pageBoxOf(out.getPage(1));
    expect(fresh).toEqual(neighbour);
    expect(fresh.rotation).toBe(90);
    expect([fresh.width, fresh.height]).toEqual([400, 800]);
  });

  it("copies a non-zero MediaBox origin as well", async () => {
    const doc = await blankPdf();
    const { degrees } = await pdfLib();
    const page = doc.addPage([300, 500]);
    page.setMediaBox(20, 30, 300, 500);
    page.setRotation(degrees(270));

    const bytes = await insertBlankPage(await savePdf(doc), 1);
    const out = await loadPdf(bytes);
    expect(pageBoxOf(out.getPage(1))).toEqual({
      originX: 20,
      originY: 30,
      width: 300,
      height: 500,
      rotation: 270,
    });
  });

  it("uses the last page when it goes on the end", async () => {
    const bytes = await insertBlankPage(await makeDoc(3), 3);
    const doc = await loadPdf(bytes);
    expect(doc.getPageCount()).toBe(4);
    expect(Math.round(doc.getPage(3).getWidth())).toBe(202);
  });

  it("takes an explicit size when it is given one", async () => {
    const bytes = await insertBlankPage(await makeDoc(2), 0, { width: 612, height: 792 });
    const doc = await loadPdf(bytes);
    expect(doc.getPage(0).getWidth()).toBe(612);
    expect(doc.getPage(0).getHeight()).toBe(792);
    expect(pageBoxOf(doc.getPage(0)).rotation).toBe(0);
  });

  it("refuses a size with no area and a position off the end", async () => {
    const bytes = await makeDoc(2);
    await expect(insertBlankPage(bytes, 0, { width: 0, height: 100 })).rejects.toBeInstanceOf(
      PdfOpError,
    );
    await expect(insertBlankPage(bytes, 4)).rejects.toThrow(/Position 4 is not somewhere/);
  });

  it("keeps the metadata, since it does not rebuild", async () => {
    const doc = await loadPdf(await insertBlankPage(await makeDoc(2), 1));
    expect(doc.getTitle()).toBe("Apartment lease");
    expect(doc.getKeywords()).toBe("lease rent");
  });
});

/**
 * A page tree whose TOP node carries /Rotate. That is legal and inheritable,
 * so every page under it is turned without saying so itself, and any new page
 * put under it is turned too unless something writes an angle on it.
 */
async function rotatedTreeDoc(leafAngle?: number): Promise<Uint8Array> {
  const { PDFName, PDFNumber, degrees } = await pdfLib();
  const doc = await blankPdf();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([400, 800]);
    if (leafAngle !== undefined) page.setRotation(degrees(leafAngle));
  }
  doc.catalog.Pages().set(PDFName.of("Rotate"), PDFNumber.of(90));
  return savePdf(doc);
}

describe("insertBlankPage against an inherited rotation", () => {
  it("does not let the page tree turn a blank page the caller sized itself", async () => {
    const bytes = await insertBlankPage(await rotatedTreeDoc(), 0, { width: 612, height: 792 });
    const box = pageBoxOf((await loadPdf(bytes)).getPage(0));
    // Asking for 612 by 792 has to give a portrait sheet, not a landscape one
    // borrowed from the tree.
    expect(box.rotation).toBe(0);
    expect([box.width, box.height]).toEqual([612, 792]);
  });

  it("matches a neighbour that inherits its turn", async () => {
    const out = await loadPdf(await insertBlankPage(await rotatedTreeDoc(), 0));
    expect(pageBoxOf(out.getPage(0))).toEqual(pageBoxOf(out.getPage(1)));
    expect(pageBoxOf(out.getPage(0)).rotation).toBe(90);
  });

  it("matches a neighbour that overrides the tree back to 0", async () => {
    // The trap: the neighbour reads 0, so writing the angle only when it is
    // non-zero leaves the blank page inheriting 90 from the tree.
    const out = await loadPdf(await insertBlankPage(await rotatedTreeDoc(0), 0));
    expect(pageBoxOf(out.getPage(1)).rotation).toBe(0);
    expect(pageBoxOf(out.getPage(0)).rotation).toBe(0);
  });

  it("copies a neighbour's CropBox, which is what actually gets printed", async () => {
    const doc = await blankPdf();
    const page = doc.addPage([612, 792]);
    page.setCropBox(50, 50, 512, 692);

    const out = await loadPdf(await insertBlankPage(await savePdf(doc), 0));
    expect(out.getPage(0).getCropBox()).toEqual({ x: 50, y: 50, width: 512, height: 692 });
    expect(out.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });
});

describe("a damaged file", () => {
  it("names a truncated PDF instead of throwing a raw TypeError", async () => {
    // A correct header with nothing behind it. The loader accepts this, and
    // the page count is the first thing that falls over.
    const stub = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x00]);
    for (const run of [
      () => rotatePages(stub, [0], 90),
      () => deletePages(stub, [0]),
      () => reorderPages(stub, [0]),
      () => movePage(stub, 0, 0),
      () => duplicatePages(stub, [0]),
      () => extractPages(stub, [0]),
      () => insertBlankPage(stub, 0),
    ]) {
      await expect(run()).rejects.toBeInstanceOf(PdfOpError);
      await expect(run()).rejects.toThrow(/no readable list of pages/);
    }
  });

  it("names an empty array as not a PDF", async () => {
    await expect(deletePages(new Uint8Array(0), [0])).rejects.toThrow(/not a PDF/);
  });
});

/** Two pages, with a filled in text field and a ticked box on the second. */
async function formDoc(): Promise<Uint8Array> {
  const doc = await blankPdf();
  doc.addPage([400, 800]);
  const second = doc.addPage([401, 800]);
  const form = doc.getForm();

  const name = form.createTextField("tenant.name");
  name.setText("Ada Byron");
  name.addToPage(second, { x: 20, y: 20, width: 120, height: 20 });

  const agreed = form.createCheckBox("agreed");
  agreed.check();
  agreed.addToPage(second, { x: 200, y: 20, width: 20, height: 20 });

  return savePdf(doc);
}

describe("interactive forms through a rebuild", () => {
  it("keeps the fields and the values when a page is deleted", async () => {
    const out = await loadPdf(await deletePages(await formDoc(), [0]));
    const form = out.getForm();
    expect(form.getFields().map((f) => f.getName()).sort()).toEqual(["agreed", "tenant.name"]);
    expect(form.getTextField("tenant.name").getText()).toBe("Ada Byron");
    expect(form.getCheckBox("agreed").isChecked()).toBe(true);
  });

  it("keeps them through a reorder, a move and a duplicate", async () => {
    const src = await formDoc();
    for (const bytes of [
      await reorderPages(src, [1, 0]),
      await movePage(src, 1, 0),
      await duplicatePages(src, [0]),
    ]) {
      const form = (await loadPdf(bytes)).getForm();
      expect(form.getFields().length).toBeGreaterThan(0);
      expect(form.getTextField("tenant.name").getText()).toBe("Ada Byron");
    }
  });

  it("carries only the fields whose page survived", async () => {
    // Page 0 holds no fields, so extracting it must not drag the other page's
    // fields along behind it.
    const out = await loadPdf(await extractPages(await formDoc(), [0]));
    expect(out.getPageCount()).toBe(1);
    expect(out.getForm().getFields()).toEqual([]);
  });

  it("leaves a document with no form alone", async () => {
    const { PDFName } = await pdfLib();
    const out = await loadPdf(await deletePages(await makeDoc(3), [0]));
    // Not "an empty form": no AcroForm entry at all.
    expect(out.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
  });
});

describe("every operation leaves the caller's bytes alone", () => {
  it("does not write into the array it was handed", async () => {
    const runs: Array<[string, (b: Uint8Array) => Promise<Uint8Array>]> = [
      ["rotatePages", (b) => rotatePages(b, [0], 90)],
      ["deletePages", (b) => deletePages(b, [1])],
      ["reorderPages", (b) => reorderPages(b, [2, 1, 0])],
      ["movePage", (b) => movePage(b, 0, 2)],
      ["duplicatePages", (b) => duplicatePages(b, [1])],
      ["extractPages", (b) => extractPages(b, [1])],
      ["insertBlankPage", (b) => insertBlankPage(b, 1)],
    ];
    for (const [name, run] of runs) {
      const bytes = await makeDoc(3);
      const before = bytes.slice();
      await run(bytes);
      expect({ name, same: bytes.every((v, i) => v === before[i]) }).toEqual({ name, same: true });
      expect(bytes.length).toBe(before.length);
    }
  });
});

describe("a real file", () => {
  it("reorders and extracts from the sample lease without losing pages", async () => {
    const original = new Uint8Array(readFileSync(SAMPLE));
    const before = await loadPdf(original);
    const total = before.getPageCount();
    expect(total).toBeGreaterThan(0);

    const firstWidth = Math.round(before.getPage(0).getWidth());

    const flipped = await reorderPages(
      original,
      before.getPageIndices().slice().reverse(),
    );
    const after = await loadPdf(flipped);
    expect(after.getPageCount()).toBe(total);
    expect(Math.round(after.getPage(total - 1).getWidth())).toBe(firstWidth);

    const one = await loadPdf(await extractPages(original, [0]));
    expect(one.getPageCount()).toBe(1);
    expect(Math.round(one.getPage(0).getWidth())).toBe(firstWidth);
  });
});
