/** The answering layer.
 *
 * An Answerer sees ONLY the retrieved excerpts, never the whole document. Two
 * guarantees are enforced out here, outside the model, so they hold no matter
 * what the model says:
 *
 *   1. Retrieval gate. If no retrieved chunk clears the embedder's relevance
 *      threshold, Clause abstains without calling the model at all.
 *   2. Citation check. A "found" answer whose citations do not map to real
 *      retrieved excerpts is downgraded to an abstention. No receipts, no
 *      answer.
 *
 * The model's own "I did not find it" is the third layer, in the middle.
 */

import type { DocumentStore } from "./store";
import type { Answerer, AskResult, Excerpt, Retrieved, Source } from "./types";

export const ABSTAIN_MESSAGE =
  "This document does not appear to say. It may be worded in a way the " +
  "search missed, or it may simply not be covered. Try asking another way, " +
  "or read the closest passages below and judge for yourself.";

export const NO_LLM_NOTE =
  "Here are the passages that best match your question, exactly as they " +
  "appear in the document. Turn on plain-English answers to have these " +
  "written up for you.";

/** Scores are shown to people, so trim them to four places. */
export function roundScore(score: number): number {
  return Math.round(score * 10000) / 10000;
}

/** Turn a retrieval hit into a receipt. */
export function toSource(hit: Retrieved): Source {
  return {
    chunkId: hit.chunk.chunkId,
    docId: hit.doc.id,
    docName: hit.doc.name,
    page: hit.chunk.page,
    start: hit.chunk.start,
    end: hit.chunk.end,
    quote: hit.chunk.text,
    score: roundScore(hit.score),
  };
}

/** Citations arrive from a model, so treat them as untrusted input: keep the
 * first mention of each, drop anything that is not a real excerpt index. */
export function validCitations(
  citations: number[],
  poolSize: number,
): number[] {
  const seen = new Set<number>();
  const kept: number[] = [];
  for (const raw of citations) {
    if (!Number.isInteger(raw) || raw < 0 || raw >= poolSize) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    kept.push(raw);
  }
  return kept;
}

export async function ask(
  store: DocumentStore,
  answerer: Answerer | null,
  question: string,
  docIds: string[] | null = null,
): Promise<AskResult> {
  const retrieved = store.query(question, { docIds });

  // Layer 1: retrieval gate. Nothing relevant enough means abstain, no model call.
  const relevant = retrieved.filter((hit) =>
    store.embedder.isRelevant(question, hit.chunk.text, hit.score),
  );
  if (relevant.length === 0) {
    return {
      found: false,
      mode: "abstain",
      answer: ABSTAIN_MESSAGE,
      sources: retrieved.slice(0, 3).map(toSource),
    };
  }

  if (answerer === null) {
    return {
      found: false,
      mode: "extractive",
      answer: NO_LLM_NOTE,
      sources: relevant.map(toSource),
    };
  }

  const excerpts: Excerpt[] = relevant.map((hit) => [
    `${hit.doc.name}, page ${hit.chunk.page}`,
    hit.chunk.text,
  ]);
  const result = await answerer.answer(question, excerpts);

  // Layer 2: the model says the excerpts do not answer the question.
  if (!result.found) {
    return {
      found: false,
      mode: "abstain",
      answer: result.answer || ABSTAIN_MESSAGE,
      sources: relevant.slice(0, 3).map(toSource),
    };
  }

  // Layer 3: citation check. An answer with no valid receipts is not an answer.
  const cited = validCitations(result.citations, relevant.length)
    .map((i) => relevant[i])
    .filter((hit): hit is Retrieved => hit !== undefined);
  if (cited.length === 0) {
    return {
      found: false,
      mode: "abstain",
      answer: ABSTAIN_MESSAGE,
      sources: relevant.slice(0, 3).map(toSource),
    };
  }

  return {
    found: true,
    mode: "llm",
    answer: result.answer,
    sources: cited.map(toSource),
  };
}
