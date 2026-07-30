/** Shared shapes for the Clause engine.
 *
 * These are the browser port of the Python backend's dataclasses and Pydantic
 * models. Field names are camelCase because nothing here crosses a wire any
 * more: the whole engine runs in the tab.
 */

/** One retrievable slice of a page. */
export interface Chunk {
  chunkId: string;
  docId: string;
  /** 1-based, matches how people count pages. */
  page: number;
  /** Character offset into that page's text. */
  start: number;
  end: number;
  /** Always exactly pageText.slice(start, end). Never rebuilt or re-spaced. */
  text: string;
}

export interface StoredDoc {
  id: string;
  name: string;
  /** Page text, index 0 = page 1. */
  pages: string[];
  /** chunkId -> Chunk */
  chunks: Map<string, Chunk>;
  sample: boolean;
  /** Insertion order. Used for a stable list(), and it replaces the backend's
   * created_at timestamp so nothing here depends on the clock. */
  seq: number;
}

export interface Retrieved {
  chunk: Chunk;
  doc: StoredDoc;
  /** Cosine similarity, clamped to [0, 1]. */
  score: number;
}

/** One receipt: an exact span of the original document. */
export interface Source {
  chunkId: string;
  docId: string;
  docName: string;
  page: number;
  start: number;
  end: number;
  /** Exactly pages[page - 1].slice(start, end). */
  quote: string;
  score: number;
}

/**
 * "llm"        -> answer written by the model, sources are its citations
 * "extractive" -> no answerer wired up; sources are the closest passages
 * "abstain"    -> the answer is not in the document(s)
 */
export type AskMode = "llm" | "extractive" | "abstain";

export interface AskResult {
  found: boolean;
  mode: AskMode;
  answer: string;
  sources: Source[];
}

/** "high" | "medium" | "low" when a model judged it. "info" in extractive
 * mode, where Clause surfaces the passage but will not rate how serious it is. */
export type Severity = "high" | "medium" | "low" | "info";

export interface Flag {
  /** Stable id, e.g. "auto_renewal". */
  category: string;
  /** Human label, e.g. "Automatic renewal". */
  title: string;
  severity: Severity;
  explanation: string;
  sources: Source[];
}

export interface ScanResult {
  docId: string;
  docName: string;
  mode: "llm" | "extractive";
  flags: Flag[];
  /** Framing shown above the results: what this is and what it is not. */
  note: string;
}

/** An excerpt is [label, text], e.g. ["Sample Lease, page 3", "...clause..."]. */
export type Excerpt = [label: string, text: string];

/** A candidate risk category is [id, one-line description] shown to the model. */
export type Category = [id: string, hint: string];

export interface Answer {
  found: boolean;
  answer: string;
  /** Indices into the excerpt list passed to answer(). */
  citations: number[];
}

/** One risk the model judged genuinely present in the excerpts.
 *
 * Same grounding contract as Answer: citations index into the excerpt pool
 * passed to findFlags(), and a finding with no valid citation is dropped by
 * the scan. A flag without receipts is not a flag.
 */
export interface FlagFinding {
  /** Must match one of the requested category ids. */
  category: string;
  /** "high" | "medium" | "low" */
  severity: string;
  explanation: string;
  citations: number[];
}

/**
 * The seam where a model plugs in. Nothing in this folder implements it and
 * nothing here imports an SDK: pass null and the engine runs extractive, which
 * is the default the whole site uses.
 */
export interface Answerer {
  answer(question: string, excerpts: Excerpt[]): Promise<Answer>;
  findFlags(excerpts: Excerpt[], categories: Category[]): Promise<FlagFinding[]>;
}

export interface Embedder {
  readonly name: string;
  /** Retrieval-gate threshold. Below this, Clause abstains without asking the
   * model anything. */
  readonly minRelevance: number;
  embed(texts: string[]): number[][];
  /** Does this chunk plausibly bear on the question? Chunks that fail this for
   * every retrieved result cause Clause to abstain. */
  isRelevant(question: string, chunkText: string, score: number): boolean;
}
