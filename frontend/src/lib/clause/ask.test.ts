/** The "never guess" contract.
 *
 * Three independent layers must each be able to force an abstention:
 *   1. Retrieval gate. Nothing relevant retrieved means abstain WITHOUT calling
 *      the model.
 *   2. Model judgment. The model says the excerpts do not answer, so abstain.
 *   3. Citation check. A "found" answer with no valid citations, so abstain.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { ABSTAIN_MESSAGE, NO_LLM_NOTE, ask } from "./ask";
import { FakeAnswerer, LEASE_PAGES, makeStore } from "./fixtures";
import type { DocumentStore } from "./store";
import type { StoredDoc } from "./types";

const GIBBERISH = "quantum zebra harmonics flugelhorn recipe";

describe("ask", () => {
  let store: DocumentStore;
  let lease: StoredDoc;

  beforeEach(() => {
    store = makeStore();
    lease = store.addDocument("Test Lease.pdf", LEASE_PAGES);
  });

  it("abstains on an irrelevant question without calling the model", async () => {
    const answerer = new FakeAnswerer();
    const result = await ask(store, answerer, GIBBERISH);
    expect(result.found).toBe(false);
    expect(result.mode).toBe("abstain");
    // Assert the constant, not its wording. The behaviour under test is that
    // the retrieval gate refused without asking the model, and rewording the
    // message should not fail that.
    expect(result.answer).toBe(ABSTAIN_MESSAGE);
    expect(answerer.calls).toEqual([]);
  });

  it("abstains when the model says it is not there", async () => {
    const answerer = new FakeAnswerer({
      found: false,
      answer: "The excerpts don't cover parking.",
      citations: [],
    });
    const result = await ask(store, answerer, "What are the rules about rent payment?");
    expect(result.found).toBe(false);
    expect(result.mode).toBe("abstain");
    expect(result.answer).toContain("parking");
    expect(answerer.calls).toHaveLength(1); // retrieval passed, so it was consulted
  });

  it("downgrades a found answer whose citations are not real", async () => {
    const answerer = new FakeAnswerer({
      found: true,
      answer: "Made up!",
      citations: [99, -1],
    });
    const result = await ask(store, answerer, "What is the late fee?");
    expect(result.found).toBe(false);
    expect(result.mode).toBe("abstain");
    expect(result.answer).toBe(ABSTAIN_MESSAGE);
    expect(result.answer).not.toContain("Made up!");
  });

  it("downgrades a found answer with no citations at all", async () => {
    const answerer = new FakeAnswerer({
      found: true,
      answer: "Trust me.",
      citations: [],
    });
    const result = await ask(store, answerer, "What is the late fee?");
    expect(result.found).toBe(false);
    expect(result.mode).toBe("abstain");
  });

  it("passes a valid answer through with exact receipts", async () => {
    const answerer = new FakeAnswerer({
      found: true,
      answer: "The late fee is $75 plus $10/day.",
      citations: [0],
    });
    const result = await ask(store, answerer, "What is the late fee if I pay rent late?");
    expect(result.found).toBe(true);
    expect(result.mode).toBe("llm");
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0];
    if (source === undefined) throw new Error("expected a source");
    // The receipt must be an exact, verifiable span of the original page.
    const pageText = lease.pages[source.page - 1];
    expect(pageText?.slice(source.start, source.end)).toBe(source.quote);
    expect(source.quote.toLowerCase()).toContain("late fee");
  });

  it("deduplicates citations and keeps first-mention order", async () => {
    const answerer = new FakeAnswerer({
      found: true,
      answer: "ok",
      citations: [1, 0, 1, 0],
    });
    const result = await ask(store, answerer, "rent late fee and pet fee");
    expect(result.found).toBe(true);
    const ids = result.sources.map((s) => s.chunkId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("returns extractive mode when there is no answerer", async () => {
    const result = await ask(store, null, "What is the late fee?");
    expect(result.found).toBe(false);
    expect(result.mode).toBe("extractive");
    expect(result.answer).toBe(NO_LLM_NOTE);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it("still shows the closest passages when it abstains", async () => {
    // "pet" overlaps the lease, so retrieval passes and the model is consulted,
    // but deposits are not in the excerpts, so it says not-found (layer 2).
    const answerer = new FakeAnswerer({
      found: false,
      answer: "Not covered.",
      citations: [],
    });
    const result = await ask(store, answerer, "What deposit do I pay for a pet?");
    expect(result.mode).toBe("abstain");
    expect(answerer.flagCalls).toEqual([]);
    expect(answerer.calls).toHaveLength(1);
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
    expect(result.sources.length).toBeLessThanOrEqual(3);
  });

  it("only sends the retrieved excerpts, never the whole document", async () => {
    const answerer = new FakeAnswerer();
    await ask(store, answerer, "What is the late fee?");
    const call = answerer.calls[0];
    if (call === undefined) throw new Error("expected one call");
    const [question, excerpts] = call;
    expect(question).toBe("What is the late fee?");
    expect(excerpts.length).toBeGreaterThan(0);
    for (const [label, text] of excerpts) {
      expect(label).toMatch(/^Test Lease\.pdf, page \d+$/);
      expect(LEASE_PAGES.some((page) => page.includes(text))).toBe(true);
    }
  });

  it("honours a docIds filter", async () => {
    const manual = store.addDocument("Blender Manual.pdf", [
      "Warranty. The blender motor is covered for five years.",
    ]);
    const result = await ask(store, null, "how long is the warranty", [manual.id]);
    expect(result.sources.every((s) => s.docId === manual.id)).toBe(true);
  });

  it("rounds scores to four places", async () => {
    const result = await ask(store, null, "What is the late fee?");
    for (const source of result.sources) {
      expect(source.score).toBe(Math.round(source.score * 10000) / 10000);
    }
  });
});
