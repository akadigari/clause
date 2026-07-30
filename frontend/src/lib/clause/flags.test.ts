/** The red-flags scan keeps the same "never guess" contract as ask().
 *
 * A flag may only exist if (1) a risk-category probe retrieved a relevant
 * chunk, (2) the model judged it a genuine instance, and (3) that judgment
 * cites a real candidate excerpt. Break any link and the flag disappears.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { CATEGORIES, EMPTY_NOTE, SCAN_NOTE, scan } from "./flags";
import { BENIGN_PAGES, FakeAnswerer, LEASE_PAGES, makeStore } from "./fixtures";
import type { DocumentStore } from "./store";
import type { StoredDoc } from "./types";

describe("risk categories", () => {
  it("carries all seven, with unique ids and lowercase signals", () => {
    expect(CATEGORIES).toHaveLength(7);
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      "auto_renewal",
      "fees_penalties",
      "cancellation",
      "arbitration",
      "liability",
      "unilateral_changes",
      "data_sharing",
    ]);
    for (const cat of CATEGORIES) {
      expect(cat.probe.length).toBeGreaterThan(0);
      expect(cat.hint.length).toBeGreaterThan(0);
      expect(cat.why.length).toBeGreaterThan(0);
      expect(cat.signals.length).toBeGreaterThan(0);
      for (const sig of cat.signals) expect(sig).toBe(sig.toLowerCase());
    }
  });
});

describe("scan", () => {
  let store: DocumentStore;
  let lease: StoredDoc;

  beforeEach(() => {
    store = makeStore();
    lease = store.addDocument("Test Lease.pdf", LEASE_PAGES);
  });

  it("surfaces matched categories in extractive mode", async () => {
    // No answerer at all, so: passages, unrated, verbatim.
    const result = await scan(store, null, lease.id);
    expect(result.mode).toBe("extractive");
    expect(result.docName).toBe("Test Lease.pdf");
    expect(result.flags.length).toBeGreaterThan(0); // fees and early termination
    expect(result.note).toBe(SCAN_NOTE);
    for (const flag of result.flags) {
      expect(flag.severity).toBe("info"); // no model, so no severity claim
      expect(flag.sources.length).toBeGreaterThan(0);
      for (const source of flag.sources) {
        const pageText = lease.pages[source.page - 1];
        expect(pageText?.slice(source.start, source.end)).toBe(source.quote);
      }
    }
    expect(result.flags.map((f) => f.category)).toContain("fees_penalties");
  });

  it("quotes the sentence that mentions the topic, not the whole chunk", async () => {
    const result = await scan(store, null, lease.id);
    const fees = result.flags.find((f) => f.category === "fees_penalties");
    if (fees === undefined) throw new Error("expected a fees flag");
    const source = fees.sources[0];
    if (source === undefined) throw new Error("expected a source");
    expect(source.quote.length).toBeLessThanOrEqual(320);
    expect(source.quote.length).toBeLessThan(LEASE_PAGES[0]?.length ?? 0);
    expect(source.quote).toBe(lease.pages[source.page - 1]?.slice(source.start, source.end));
  });

  it("returns grounded flags when a model judges them", async () => {
    const answerer = new FakeAnswerer(null, [
      {
        category: "fees_penalties",
        severity: "high",
        explanation: "Late rent costs $75 plus $10/day, up to $250.",
        citations: [0],
      },
    ]);
    const result = await scan(store, answerer, lease.id);
    expect(result.mode).toBe("llm");
    expect(answerer.flagCalls).toHaveLength(1);
    expect(result.flags).toHaveLength(1);
    const flag = result.flags[0];
    if (flag === undefined) throw new Error("expected a flag");
    expect(flag.category).toBe("fees_penalties");
    expect(flag.title).toBe("Fees and penalties");
    expect(flag.severity).toBe("high");
    const source = flag.sources[0];
    if (source === undefined) throw new Error("expected a source");
    expect(lease.pages[source.page - 1]?.slice(source.start, source.end)).toBe(
      source.quote,
    );
  });

  it("drops a flag whose citations are not real", async () => {
    const answerer = new FakeAnswerer(null, [
      {
        category: "fees_penalties",
        severity: "high",
        explanation: "Made up.",
        citations: [99, -1],
      },
    ]);
    const result = await scan(store, answerer, lease.id);
    expect(result.flags).toEqual([]); // no receipts, no flag
    expect(result.note).toBe(EMPTY_NOTE); // still explains why nothing showed
  });

  it("drops a category it never offered", async () => {
    const answerer = new FakeAnswerer(null, [
      {
        category: "totally_made_up",
        severity: "high",
        explanation: "Nope.",
        citations: [0],
      },
    ]);
    const result = await scan(store, answerer, lease.id);
    expect(result.flags).toEqual([]);
  });

  it("never calls the model when nothing relevant was retrieved", async () => {
    const doc = store.addDocument("Benign.pdf", BENIGN_PAGES);
    const answerer = new FakeAnswerer(null, [
      {
        category: "fees_penalties",
        severity: "high",
        explanation: "x",
        citations: [0],
      },
    ]);
    const result = await scan(store, answerer, doc.id);
    expect(result.flags).toEqual([]);
    expect(answerer.flagCalls).toEqual([]);
    expect(result.note).toBe(EMPTY_NOTE);
  });

  it("sorts flags high severity first and falls back on odd values", async () => {
    const answerer = new FakeAnswerer(null, [
      { category: "cancellation", severity: "low", explanation: "b", citations: [0] },
      {
        category: "fees_penalties",
        severity: "sideways",
        explanation: "  ",
        citations: [0],
      },
      { category: "liability", severity: "high", explanation: "a", citations: [0] },
    ]);
    const result = await scan(store, answerer, lease.id);
    expect(result.flags.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
    // A blank explanation falls back to the category's neutral note.
    const fees = result.flags.find((f) => f.category === "fees_penalties");
    expect(fees?.explanation).toContain("Worth reading");
  });

  it("hands the model only pooled excerpts and the matched categories", async () => {
    const answerer = new FakeAnswerer(null, []);
    await scan(store, answerer, lease.id);
    const call = answerer.flagCalls[0];
    if (call === undefined) throw new Error("expected one call");
    const [excerpts, categories] = call;
    const ids = new Set(CATEGORIES.map((c) => c.id));
    expect(categories.length).toBeGreaterThan(0);
    for (const [id, hint] of categories) {
      expect(ids.has(id)).toBe(true);
      expect(hint.length).toBeGreaterThan(0);
    }
    const chunkIds = new Set(excerpts.map(([label]) => label));
    expect(chunkIds.size).toBe(excerpts.length); // pool is deduplicated
    for (const [, text] of excerpts) {
      expect(LEASE_PAGES.some((page) => page.includes(text))).toBe(true);
    }
  });

  it("throws for a document that is not there", async () => {
    await expect(scan(store, null, "doc-does-not-exist")).rejects.toThrow(
      /not found/,
    );
  });

  it("gives the same scan every time", async () => {
    const first = await scan(store, null, lease.id);
    const second = await scan(store, null, lease.id);
    expect(second).toEqual(first);
  });
});
