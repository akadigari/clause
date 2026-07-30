/** Retrieval: the right chunk, from the right page, from the right document. */

import { beforeEach, describe, expect, it } from "vitest";

import { LEASE_PAGES, MANUAL_PAGES, makeStore } from "./fixtures";
import type { DocumentStore } from "./store";
import type { Retrieved, StoredDoc } from "./types";

function top(results: Retrieved[]): Retrieved {
  const first = results[0];
  if (first === undefined) throw new Error("expected at least one hit");
  return first;
}

describe("DocumentStore", () => {
  let store: DocumentStore;
  let lease: StoredDoc;

  beforeEach(() => {
    store = makeStore();
    lease = store.addDocument("Test Lease.pdf", LEASE_PAGES);
  });

  it("finds the relevant chunk and page", () => {
    const results = store.query("Am I allowed to keep a pet?");
    expect(results.length).toBeGreaterThan(0);
    expect(top(results).chunk.text.toLowerCase()).toContain("pets");
    expect(top(results).chunk.page).toBe(2); // the pets clause is page 2
  });

  it("sorts scores descending", () => {
    const results = store.query("late fee for paying rent after the fifth");
    const scores = results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(top(results).chunk.text.toLowerCase()).toContain("late");
  });

  it("keeps every quote an exact page span", () => {
    // A citation must be reproducible: quote === pageText.slice(start, end).
    for (const hit of store.query("early termination fee")) {
      const pageText = hit.doc.pages[hit.chunk.page - 1];
      expect(pageText?.slice(hit.chunk.start, hit.chunk.end)).toBe(hit.chunk.text);
    }
  });

  it("picks the right document out of several", () => {
    const manual = store.addDocument("Blender Manual.pdf", MANUAL_PAGES);

    const warranty = store.query("how long is the blender motor warranty");
    expect(top(warranty).doc.id).toBe(manual.id);
    expect(top(warranty).chunk.text.toLowerCase()).toContain("warranty");

    const fee = store.query("what is the late fee on rent");
    expect(top(fee).doc.id).toBe(lease.id);
  });

  it("restricts the search when docIds is given", () => {
    store.addDocument("Blender Manual.pdf", MANUAL_PAGES);
    const results = store.query("how long is the warranty", { docIds: [lease.id] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.doc.id === lease.id)).toBe(true);
  });

  it("limits results to topK", () => {
    store.addDocument("Blender Manual.pdf", MANUAL_PAGES);
    expect(store.query("rent and fees", { topK: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("returns nothing for an unknown document filter", () => {
    expect(store.query("rent", { docIds: ["doc-does-not-exist"] })).toEqual([]);
  });

  it("stops searching a removed document", () => {
    expect(top(store.query("late fee")).doc.id).toBe(lease.id);
    store.remove(lease.id);
    expect(store.query("late fee")).toEqual([]);
    expect(store.get(lease.id)).toBeUndefined();
  });

  it("refuses a document with no extractable text", () => {
    expect(() => store.addDocument("Blank.pdf", ["", "   \n\n  "])).toThrow(
      /no extractable text/,
    );
  });

  it("lists samples first, then in the order they were added", () => {
    const manual = store.addDocument("Blender Manual.pdf", MANUAL_PAGES);
    const sample = store.addDocument("Sample Lease.pdf", LEASE_PAGES, {
      sample: true,
    });
    expect(store.list().map((d) => d.id)).toEqual([sample.id, lease.id, manual.id]);
  });

  it("gives the same answer every time", () => {
    const first = store.query("late fee").map((r) => [r.chunk.chunkId, r.score]);
    const second = store.query("late fee").map((r) => [r.chunk.chunkId, r.score]);
    expect(second).toEqual(first);

    const rebuilt = makeStore();
    rebuilt.addDocument("Test Lease.pdf", LEASE_PAGES);
    expect(rebuilt.query("late fee").map((r) => [r.chunk.chunkId, r.score])).toEqual(
      first,
    );
  });

  it("scores between 0 and 1", () => {
    for (const hit of store.query("rent, fees, pets and termination")) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});
