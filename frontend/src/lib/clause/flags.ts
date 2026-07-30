/** Red-flags scan: point out clauses a person would want to notice, up front.
 *
 * This is the proactive twin of ask(). Instead of waiting for a question,
 * Clause checks the document against a fixed list of risk categories
 * (auto-renewal, penalties, arbitration, and so on) and reports the clauses
 * that genuinely match, each with the exact text it came from.
 *
 * It reuses the same safety checks as ask(), so the "never guess" rule holds
 * here too:
 *
 *   1. Retrieval gate. Each category is a search query; only chunks that clear
 *      the embedder's relevance threshold become candidates. A category with
 *      no relevant chunk is never flagged.
 *   2. Model judgment. With an answerer, the model sees only the candidate
 *      excerpts and decides which are real instances. A chunk that merely
 *      shares keywords is not a flag.
 *   3. Citation check. A finding whose citations do not point to a real
 *      candidate excerpt is dropped. No receipts, no flag.
 *
 * With no answerer it falls back to extractive mode: the top passage per
 * matched category is shown as-is and labelled "worth reviewing", unrated,
 * because without a model Clause will not claim to judge how serious it is.
 */

import { roundScore, toSource } from "./ask";
import type { DocumentStore } from "./store";
import type {
  Answerer,
  Category,
  Excerpt,
  Flag,
  Retrieved,
  ScanResult,
  Severity,
  Source,
  StoredDoc,
} from "./types";

export const SCAN_NOTE =
  "These are clauses worth reviewing, pulled straight from the document and " +
  "shown with the exact text. Clause points them out and cites the source. " +
  "It doesn't give legal advice, and it only flags what's actually written " +
  "in the document.";

export const EMPTY_NOTE =
  "Clause didn't find any of the clauses it watches for in this document. " +
  "That doesn't mean there's nothing to check, only that none of its " +
  "risk categories clearly matched the text.";

// Severity rank for sorting flags, high first. "info" is the extractive-mode
// label used when there is no model available to judge severity.
const SEVERITY_RANK: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

export interface RiskCategory {
  id: string;
  /** Neutral topic label; works with or without a model to judge it. */
  title: string;
  /** Keyword-rich retrieval probe. The default embedder is lexical, so these
   * deliberately spell out the words such clauses tend to use. */
  probe: string;
  /** One-line description handed to the model to judge a genuine match. */
  hint: string;
  /** Distinctive lowercase substrings for this topic. In extractive mode,
   * where there is no model to judge relevance, a category is only flagged
   * when a retrieved passage literally contains one of these. That keeps a
   * single shared word (say "fee" turning up under "arbitration") from
   * producing a false flag against a passage that is not actually on-topic. */
  signals: readonly string[];
  /** Neutral, topic-level note shown in extractive mode. It describes what the
   * topic is and why to read it, never a claim about what THIS document
   * decides, because without a model Clause cannot judge that. */
  why: string;
}

export const CATEGORIES: readonly RiskCategory[] = [
  {
    id: "auto_renewal",
    title: "Automatic renewal",
    probe:
      "automatically renew renewal automatic renewal term renewed for " +
      "successive periods continues unless you cancel auto-renew subscription " +
      "renews notice before renewal",
    hint: "the agreement renews on its own and keeps charging unless cancelled in time",
    signals: ["renew", "automatically renew", "auto-renew"],
    why:
      "Renewal terms decide whether this keeps going, and keeps charging you, " +
      "unless you cancel in time. Worth reading to know the deadline.",
  },
  {
    id: "fees_penalties",
    title: "Fees and penalties",
    probe:
      "fee fees late fee penalty charge charged additional charge service " +
      "charge processing fee interest surcharge non-refundable",
    hint: "fees, penalties, or extra charges the reader might not expect",
    signals: ["fee", "penalty", "penalties", "late charge", "non-refundable", "$"],
    why:
      "This covers fees, penalties, or extra charges. Worth reading so none " +
      "of them catch you by surprise.",
  },
  {
    id: "cancellation",
    title: "Cancellation and termination",
    probe:
      "termination terminate cancel cancellation early termination fee notice " +
      "required days written notice end the agreement break the lease penalty " +
      "for ending",
    hint: "ending or cancelling is costly or requires long advance notice",
    signals: ["terminat", "cancel", "cancellation"],
    why:
      "This covers how to end the agreement: the notice required and any " +
      "cost to leave early. Worth reading before you need to get out.",
  },
  {
    id: "arbitration",
    title: "Arbitration and legal rights",
    probe:
      "arbitration arbitrate binding arbitration waive right to sue class " +
      "action waiver jury trial dispute resolution governing law legal claims",
    hint: "you give up the right to sue in court or to join a class action",
    signals: ["arbitrat", "class action", "jury trial", "waive the right"],
    why:
      "Arbitration clauses can limit your right to sue in court or join a " +
      "class action. Worth reading closely to see what you'd give up.",
  },
  {
    id: "liability",
    title: "Liability and warranty",
    probe:
      "limitation of liability not liable no warranty as is disclaim " +
      "warranties indemnify indemnification hold harmless maximum liability " +
      "damages",
    hint: "they limit what they're responsible for, or provide no warranty",
    signals: [
      "limitation of liability",
      "not liable",
      "as is",
      "hold harmless",
      "disclaim",
      "warrant",
      "indemnif",
    ],
    why:
      "This is where responsibility is capped and warranties are limited. " +
      "Worth reading to see what you're on the hook for if something breaks.",
  },
  {
    id: "unilateral_changes",
    title: "Changes to the terms",
    probe:
      "we may change modify these terms at any time reserve the right to " +
      "modify amend update the agreement revise terms with or without notice " +
      "sole discretion",
    hint: "they can change the terms whenever they want",
    signals: [
      "change these terms",
      "update these terms",
      "modify these terms",
      "we may change",
      "we may update",
      "add, change, or remove",
      "sole discretion",
      "reserve the right",
    ],
    why:
      "This covers whether and how the terms can change later. Worth reading " +
      "to know if what you agreed to today can shift.",
  },
  {
    id: "data_sharing",
    title: "Data and privacy",
    probe:
      "personal information data share sell third parties collect your data " +
      "privacy marketing advertisers disclose information usage data",
    hint: "your personal data can be shared, sold, or used broadly",
    signals: [
      "personal information",
      "personal data",
      "third part",
      "sell your",
      "share your",
      "advertis",
      "privacy",
      "your data",
    ],
    why:
      "This covers how your personal information is collected, used, and " +
      "shared. Worth reading to see where your data ends up.",
  },
];

const BY_ID = new Map<string, RiskCategory>(CATEGORIES.map((c) => [c.id, c]));

interface Candidates {
  /** Deduplicated candidate pool, in the order each chunk was first seen. */
  pool: Retrieved[];
  /** Category id -> the relevant chunks it matched, best first. */
  perCategory: Map<string, Retrieved[]>;
}

function candidates(store: DocumentStore, docId: string): Candidates {
  const pool: Retrieved[] = [];
  const seen = new Set<string>();
  const perCategory = new Map<string, Retrieved[]>();
  for (const cat of CATEGORIES) {
    const retrieved = store.query(cat.probe, { docIds: [docId] });
    const relevant = retrieved.filter((hit) =>
      store.embedder.isRelevant(cat.probe, hit.chunk.text, hit.score),
    );
    if (relevant.length === 0) continue;
    perCategory.set(cat.id, relevant);
    for (const hit of relevant) {
      if (!seen.has(hit.chunk.chunkId)) {
        seen.add(hit.chunk.chunkId);
        pool.push(hit);
      }
    }
  }
  return { pool, perCategory };
}

/** Best retrieved chunk (hits are best-first) that literally contains one of
 * the category's signal terms. This is the precision gate for extractive mode. */
function signalHit(cat: RiskCategory, hits: Retrieved[]): Retrieved | null {
  for (const hit of hits) {
    const low = hit.chunk.text.toLowerCase();
    if (cat.signals.some((sig) => low.includes(sig))) return hit;
  }
  return null;
}

// Only real sentence punctuation ends a clause, NOT the newlines that PDF
// extraction inserts at every visual line-wrap. Those would shred sentences
// into fragments and split a section heading off from the sentence it labels.
const SENTENCE_BOUNDARY_SOURCE = "[.!?](?:\\s|$)";
const SENTENCE_BOUNDARY = new RegExp(SENTENCE_BOUNDARY_SOURCE, "g");
const MAX_CLAUSE_CHARS = 320;
const MAX_LEADIN_CHARS = 220;
const WHITESPACE = /\s/;

function isSpaceAt(text: string, index: number): boolean {
  const ch = text[index];
  return ch !== undefined && WHITESPACE.test(ch);
}

/** Narrow a chunk hit down to the single sentence that actually mentions the
 * topic, with exact page offsets, so the citation is precise instead of a
 * 1,100-character block and is still a verbatim slice of the page.
 *
 * Falls back to the whole chunk if the signal cannot be located exactly. */
function clauseSource(
  doc: StoredDoc,
  cat: RiskCategory,
  hit: Retrieved,
): Source {
  const pageText = doc.pages[hit.chunk.page - 1];
  if (pageText === undefined) return toSource(hit);
  const low = pageText.toLowerCase();

  // Earliest signal occurrence inside the matched chunk's span.
  let pos = -1;
  for (const sig of cat.signals) {
    const i = low.indexOf(sig, hit.chunk.start);
    if (i === -1 || i + sig.length > hit.chunk.end) continue;
    if (pos === -1 || i < pos) pos = i;
  }
  if (pos === -1) return toSource(hit);

  // Sentence start: just after the last boundary before the signal. If that
  // runs too far back, say the signal sits in a heading with no nearby period,
  // clamp it and re-align to a word start so the quote stays tight.
  let start = 0;
  for (const match of pageText.slice(0, pos).matchAll(SENTENCE_BOUNDARY)) {
    start = match.index + match[0].length;
  }
  if (pos - start > MAX_LEADIN_CHARS) {
    start = pos - MAX_LEADIN_CHARS;
    while (start < pos && !isSpaceAt(pageText, start - 1)) start += 1;
  }

  // Sentence end: the next boundary at or after the signal.
  const forward = new RegExp(SENTENCE_BOUNDARY_SOURCE, "g");
  forward.lastIndex = pos;
  const endMatch = forward.exec(pageText);
  let end = endMatch !== null ? endMatch.index + endMatch[0].length : pageText.length;

  while (start < end && isSpaceAt(pageText, start)) start += 1;
  while (end > start && isSpaceAt(pageText, end - 1)) end -= 1;
  end = Math.min(end, start + MAX_CLAUSE_CHARS);

  return {
    chunkId: hit.chunk.chunkId,
    docId: doc.id,
    docName: doc.name,
    page: hit.chunk.page,
    start,
    end,
    quote: pageText.slice(start, end),
    score: roundScore(hit.score),
  };
}

function asSeverity(value: string): Severity {
  return value === "high" || value === "medium" || value === "low" || value === "info"
    ? value
    : "medium";
}

function sortedFlags(flags: Flag[]): Flag[] {
  return [...flags].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

export async function scan(
  store: DocumentStore,
  answerer: Answerer | null,
  docId: string,
): Promise<ScanResult> {
  const doc = store.get(docId);
  if (doc === undefined) throw new Error("Document not found.");

  const { pool, perCategory } = candidates(store, docId);

  // Extractive mode: no model to judge, so only surface a topic when a
  // retrieved passage actually contains one of its signal terms, and quote
  // that passage. Unrated ("info") and topic-level, never a claim about what
  // this specific document decides.
  if (answerer === null) {
    const flags: Flag[] = [];
    for (const [catId, hits] of perCategory) {
      const cat = BY_ID.get(catId);
      if (cat === undefined) continue;
      const hit = signalHit(cat, hits);
      if (hit === null) continue;
      flags.push({
        category: catId,
        title: cat.title,
        severity: "info",
        explanation: cat.why,
        sources: [clauseSource(doc, cat, hit)],
      });
    }
    return {
      docId: doc.id,
      docName: doc.name,
      mode: "extractive",
      flags: sortedFlags(flags),
      note: flags.length > 0 ? SCAN_NOTE : EMPTY_NOTE,
    };
  }

  if (pool.length === 0) {
    return {
      docId: doc.id,
      docName: doc.name,
      mode: "llm",
      flags: [],
      note: EMPTY_NOTE,
    };
  }

  const excerpts: Excerpt[] = pool.map((hit) => [hit.chunk.chunkId, hit.chunk.text]);
  const candidateCats: Category[] = [...perCategory.keys()].map((cid) => [
    cid,
    BY_ID.get(cid)?.hint ?? "",
  ]);
  const findings = await answerer.findFlags(excerpts, candidateCats);

  const flags: Flag[] = [];
  for (const finding of findings) {
    const cat = BY_ID.get(finding.category);
    if (cat === undefined) continue; // the model used a category we did not offer

    // Citation check: keep only citations that map to real pool excerpts.
    const seen = new Set<number>();
    const cited: Retrieved[] = [];
    for (const raw of finding.citations) {
      if (!Number.isInteger(raw) || raw < 0 || raw >= pool.length) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      const hit = pool[raw];
      if (hit !== undefined) cited.push(hit);
    }
    if (cited.length === 0) continue; // a flag without receipts is not a flag

    flags.push({
      category: cat.id,
      title: cat.title,
      severity: asSeverity(finding.severity),
      explanation: finding.explanation.trim() || cat.why,
      sources: cited.map(toSource),
    });
  }

  return {
    docId: doc.id,
    docName: doc.name,
    mode: "llm",
    flags: sortedFlags(flags),
    note: flags.length > 0 ? SCAN_NOTE : EMPTY_NOTE,
  };
}
