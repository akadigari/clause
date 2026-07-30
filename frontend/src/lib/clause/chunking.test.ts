/** The chunker's contract: exact spans, full coverage, bounded sizes, overlap. */

import { describe, expect, it } from "vitest";

import { chunkDocument, chunkPage } from "./chunking";

const LOREM_SENTENCES =
  "The tenant shall maintain the premises in good condition. " +
  "Rent is due on the first of the month without demand. " +
  "Late payments accrue a fee as described in section three. " +
  "The landlord shall provide notice before entry. ";

const MULTI_PARA_PAGE =
  "Section 1. Introduction.\n" +
  "This agreement covers the rental of the apartment.\n\n" +
  "Section 2. Rent and Fees.\n" +
  "Monthly rent is $1,850 due on the first. A late fee of $75 applies " +
  "after the fifth day of the month.\n\n" +
  "Section 3. Security Deposit.\n" +
  "The deposit is $2,775 and is returned within 21 days of move-out.";

describe("chunkPage", () => {
  it("cuts chunk text as a literal slice of the page", () => {
    // The invariant everything else depends on. Break this and every citation
    // in the app points at the wrong characters.
    const longPage = LOREM_SENTENCES.repeat(40);
    const chunks = chunkPage(longPage, { docId: "d", page: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(longPage.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  it("keeps the exact-span invariant on messy real-world text", () => {
    const messy =
      "\n\n  Section 4.   INDEMNITY \n and \"related\" matters.\n\n" +
      "Tenant shall\thold harmless the landlord... including, without " +
      "limitation, any fees!\n\n\n" +
      " Unicode spaces, em quotes “x”, and a trailing tab.\t\n\n" +
      LOREM_SENTENCES.repeat(12);
    for (const chunk of chunkPage(messy, { docId: "d", page: 7, target: 300 })) {
      expect(messy.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.text.length).toBe(chunk.end - chunk.start);
    }
  });

  it("covers every non-whitespace character", () => {
    const longPage = (LOREM_SENTENCES + "\n\n").repeat(20);
    const chunks = chunkPage(longPage, { docId: "d", page: 1 });
    const covered = new Set<number>();
    for (const chunk of chunks) {
      for (let i = chunk.start; i < chunk.end; i += 1) covered.add(i);
    }
    const uncovered: number[] = [];
    for (let i = 0; i < longPage.length; i += 1) {
      const ch = longPage[i] ?? "";
      if (ch.trim() !== "" && !covered.has(i)) uncovered.push(i);
    }
    expect(uncovered).toEqual([]);
  });

  it("bounds chunk sizes", () => {
    const longPage = LOREM_SENTENCES.repeat(60);
    const chunks = chunkPage(longPage, {
      docId: "d",
      page: 1,
      target: 800,
      hardMax: 1600,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 1600)).toBe(true);
  });

  it("lets nothing fall between consecutive chunks", () => {
    const longPage = (LOREM_SENTENCES + "\n\n").repeat(30);
    const chunks = chunkPage(longPage, {
      docId: "d",
      page: 1,
      target: 600,
      overlap: 150,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (prev === undefined || next === undefined) throw new Error("missing chunk");
      const between = longPage.slice(prev.end, Math.max(prev.end, next.start));
      expect(between.trim()).toBe(""); // only a paragraph break may sit in the gap
      expect(next.start).toBeGreaterThan(prev.start); // always forward progress
    }
  });

  it("carries sentence-level overlap across chunks", () => {
    // A single giant paragraph forces sentence-sized units, small enough for
    // the overlap walk-back to actually re-include trailing sentences.
    const longPage = LOREM_SENTENCES.repeat(30);
    const chunks = chunkPage(longPage, {
      docId: "d",
      page: 1,
      target: 600,
      overlap: 150,
    });
    expect(chunks.length).toBeGreaterThan(1);
    let overlapping = 0;
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      if (prev === undefined || next === undefined) throw new Error("missing chunk");
      if (next.start < prev.end) {
        overlapping += 1;
        expect(prev.end - next.start).toBeLessThanOrEqual(150);
      }
    }
    expect(overlapping).toBeGreaterThan(0);
  });

  it("splits a giant unbroken paragraph", () => {
    const page = "x".repeat(5000); // no whitespace at all: forces hard cuts
    const chunks = chunkPage(page, {
      docId: "d",
      page: 1,
      target: 1000,
      hardMax: 1000,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.every((c) => c.text.length <= 1000)).toBe(true);
    expect(chunks.every((c) => page.slice(c.start, c.end) === c.text)).toBe(true);
  });

  it("keeps a small multi-paragraph page as one chunk", () => {
    const chunks = chunkPage(MULTI_PARA_PAGE, {
      docId: "d",
      page: 1,
      target: 2000,
    });
    expect(chunks).toHaveLength(1);
    const only = chunks[0];
    if (only === undefined) throw new Error("expected one chunk");
    expect(only.text).toContain("Section 1");
    expect(only.text).toContain("Section 3");
  });

  it("produces no chunks for empty or whitespace pages", () => {
    expect(chunkPage("", { docId: "d", page: 1 })).toEqual([]);
    expect(chunkPage("   \n\n   ", { docId: "d", page: 1 })).toEqual([]);
  });

  it("is deterministic", () => {
    const page = LOREM_SENTENCES.repeat(25);
    const first = chunkPage(page, { docId: "d", page: 1, target: 500 });
    const second = chunkPage(page, { docId: "d", page: 1, target: 500 });
    expect(second).toEqual(first);
  });
});

describe("chunkDocument", () => {
  it("tracks page numbers and skips empty pages", () => {
    const pages = ["First page about rent.", "", "Third page about pets."];
    const chunks = chunkDocument("doc-1", pages);
    expect(new Set(chunks.map((c) => c.page))).toEqual(new Set([1, 3]));
    expect(chunks.every((c) => c.docId === "doc-1")).toBe(true);
    const byPage = new Map(chunks.map((c) => [c.page, c]));
    expect(byPage.get(1)?.text).toContain("rent");
    expect(byPage.get(3)?.text).toContain("pets");
  });

  it("gives every chunk a unique id", () => {
    const pages = [LOREM_SENTENCES.repeat(30), LOREM_SENTENCES.repeat(30)];
    const ids = chunkDocument("doc-1", pages).map((c) => c.chunkId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the exact-span invariant against each page", () => {
    const pages = [LOREM_SENTENCES.repeat(20), MULTI_PARA_PAGE, "x".repeat(3000)];
    for (const chunk of chunkDocument("doc-1", pages, { target: 400 })) {
      const pageText = pages[chunk.page - 1];
      if (pageText === undefined) throw new Error("missing page");
      expect(pageText.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });
});
