/** In-memory document store and vector index.
 *
 * Privacy model: everything lives in the tab. A PDF is parsed, chunked, and
 * embedded, and the bytes are dropped. Nothing is uploaded and nothing is
 * written to disk.
 *
 * Two deliberate differences from the Python backend:
 *
 * 1. No Chroma. The corpus is one document a person is reading, so cosine
 *    similarity over a plain array beats pulling in a vector database. The
 *    vectors are L2-normalized, so the dot product is the cosine, which is
 *    exactly the score Chroma's cosine space returns (1 - distance).
 * 2. No TTL sweep. The server expired uploads after an hour because it held
 *    other people's documents in RAM. Here the document lives as long as the
 *    tab does and no one else can reach it, so sweepExpired has no job to do
 *    and is not ported.
 */

import { chunkDocument } from "./chunking";
import type { Chunk, Embedder, Retrieved, StoredDoc } from "./types";

export const TOP_K = 6;

interface EmbeddedChunk {
  chunk: Chunk;
  vector: number[];
}

export interface AddDocumentOptions {
  sample?: boolean;
}

export interface QueryOptions {
  /** Undefined or null searches every document. */
  docIds?: string[] | null;
  topK?: number;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

export class DocumentStore {
  readonly embedder: Embedder;

  private readonly docs = new Map<string, StoredDoc>();
  private readonly index = new Map<string, EmbeddedChunk[]>();
  // Ids come from a counter, not a random uuid, so the same sequence of adds
  // always produces the same ids. Tests and cached answers depend on that.
  private seq = 0;

  constructor(embedder: Embedder) {
    this.embedder = embedder;
  }

  // -- lifecycle -----------------------------------------------------------

  addDocument(
    name: string,
    pages: string[],
    options: AddDocumentOptions = {},
  ): StoredDoc {
    this.seq += 1;
    const docId = `doc-${this.seq}`;
    const chunks = chunkDocument(docId, pages);
    if (chunks.length === 0) {
      throw new Error("Document contains no extractable text.");
    }

    const vectors = this.embedder.embed(chunks.map((c) => c.text));
    const rows: EmbeddedChunk[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const vector = vectors[i];
      if (chunk === undefined || vector === undefined) {
        throw new Error("Embedder returned the wrong number of vectors.");
      }
      rows.push({ chunk, vector });
    }

    const doc: StoredDoc = {
      id: docId,
      name,
      pages,
      chunks: new Map(chunks.map((c) => [c.chunkId, c])),
      sample: options.sample ?? false,
      seq: this.seq,
    };
    this.docs.set(docId, doc);
    this.index.set(docId, rows);
    return doc;
  }

  get(docId: string): StoredDoc | undefined {
    return this.docs.get(docId);
  }

  /** Samples first, then in the order they were added. */
  list(): StoredDoc[] {
    return [...this.docs.values()].sort(
      (a, b) => Number(!a.sample) - Number(!b.sample) || a.seq - b.seq,
    );
  }

  remove(docId: string): void {
    this.docs.delete(docId);
    this.index.delete(docId);
  }

  // -- retrieval -----------------------------------------------------------

  /** Top-k most relevant chunks across the given documents, best first. */
  query(question: string, options: QueryOptions = {}): Retrieved[] {
    const { docIds = null, topK = TOP_K } = options;
    const targets =
      docIds != null
        ? docIds
            .map((id) => this.docs.get(id))
            .filter((doc): doc is StoredDoc => doc !== undefined)
        : [...this.docs.values()];
    if (targets.length === 0) return [];

    const queryVector = this.embedder.embed([question])[0];
    if (queryVector === undefined) return [];

    const results: Retrieved[] = [];
    for (const doc of targets) {
      const rows = this.index.get(doc.id) ?? [];
      const scored = rows.map((row, position) => ({
        position,
        chunk: row.chunk,
        // Normalized vectors, so the dot product is the cosine. Clamped
        // because tiny negative overlaps are noise, not evidence.
        score: Math.max(0, Math.min(1, dot(queryVector, row.vector))),
      }));
      // Ties break on chunk order so the ranking never depends on Map order.
      scored.sort((a, b) => b.score - a.score || a.position - b.position);
      for (const hit of scored.slice(0, topK)) {
        results.push({ chunk: hit.chunk, doc, score: hit.score });
      }
    }

    // Array.prototype.sort is stable, so equal scores keep document order.
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}
