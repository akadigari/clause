/** The Clause engine, in the browser.
 *
 * Chunk a document, embed it, retrieve against a question, and refuse to
 * answer unless the receipts line up. Everything runs in the tab: no server,
 * no upload, no storage. Pass an Answerer to get plain-English answers, or
 * pass null and get the exact passages instead.
 */

export type {
  Answer,
  Answerer,
  AskMode,
  AskResult,
  Category,
  Chunk,
  Embedder,
  Excerpt,
  Flag,
  FlagFinding,
  Retrieved,
  ScanResult,
  Severity,
  Source,
  StoredDoc,
} from "./types";

export {
  CHUNK_HARD_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkDocument,
  chunkPage,
} from "./chunking";
export type { ChunkOptions, ChunkPageOptions } from "./chunking";

export { HashingEmbedder, md5, md5Hex, md5Prefix32 } from "./embedding";

export { DocumentStore, TOP_K } from "./store";
export type { AddDocumentOptions, QueryOptions } from "./store";

export { ABSTAIN_MESSAGE, NO_LLM_NOTE, ask, roundScore, toSource } from "./ask";

export { CATEGORIES, EMPTY_NOTE, SCAN_NOTE, scan } from "./flags";
export type { RiskCategory } from "./flags";
