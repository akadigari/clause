/** Split page text into overlapping chunks while tracking exact character spans.
 *
 * Invariant: for every chunk, pageText.slice(chunk.start, chunk.end) === chunk.text.
 * That guarantee is what lets the viewer highlight the exact source span of a
 * citation, so chunk boundaries are always cut from the original string. The
 * text is never rewritten, joined, or re-whitespaced.
 */

import type { Chunk } from "./types";

export const CHUNK_TARGET_CHARS = 1100;
export const CHUNK_OVERLAP_CHARS = 180;
export const CHUNK_HARD_MAX_CHARS = 2200;

/** [start, end) offsets into a page's text. */
type Span = [number, number];

const PARA_BREAK = /\n{2,}/g;
// Whitespace that follows sentence punctuation. Built fresh where it is used
// with lastIndex, so no shared scan position can leak between calls.
const SENTENCE_BREAK_SOURCE = "(?<=[.!?])\\s+";
const WHITESPACE = /\s/;

export interface ChunkOptions {
  target?: number;
  overlap?: number;
  hardMax?: number;
}

export interface ChunkPageOptions extends ChunkOptions {
  docId: string;
  page: number;
}

function isSpaceAt(text: string, index: number): boolean {
  const ch = text[index];
  return ch !== undefined && WHITESPACE.test(ch);
}

function stripSpan(text: string, start: number, end: number): Span | null {
  let s = start;
  let e = end;
  while (s < e && isSpaceAt(text, s)) s += 1;
  while (e > s && isSpaceAt(text, e - 1)) e -= 1;
  return e > s ? [s, e] : null;
}

function paragraphSpans(text: string): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  for (const match of text.matchAll(PARA_BREAK)) {
    const span = stripSpan(text, pos, match.index);
    if (span !== null) spans.push(span);
    pos = match.index + match[0].length;
  }
  const tail = stripSpan(text, pos, text.length);
  if (tail !== null) spans.push(tail);
  return spans;
}

/** Split an oversized paragraph on sentence boundaries, hard-cutting as a last
 * resort so a wall of text with no punctuation still comes apart. */
function sentenceSpans(
  text: string,
  start: number,
  end: number,
  hardMax: number,
): Span[] {
  const sentences: Span[] = [];
  const breaks = new RegExp(SENTENCE_BREAK_SOURCE, "g");
  breaks.lastIndex = start;
  let pos = start;
  let match = breaks.exec(text);
  while (match !== null) {
    if (match.index >= end) break;
    const span = stripSpan(text, pos, match.index);
    if (span !== null) sentences.push(span);
    // The search region stops at end, so a run of whitespace never carries the
    // next unit's first character with it.
    pos = Math.min(match.index + match[0].length, end);
    match = breaks.exec(text);
  }
  const tail = stripSpan(text, pos, end);
  if (tail !== null) sentences.push(tail);

  const result: Span[] = [];
  for (const [sentenceStart, sentenceEnd] of sentences) {
    let s = sentenceStart;
    while (sentenceEnd - s > hardMax) {
      result.push([s, s + hardMax]);
      s += hardMax;
    }
    result.push([s, sentenceEnd]);
  }
  return result;
}

/** Greedily pack paragraphs into roughly target-sized chunks that overlap by
 * roughly overlap characters. */
export function chunkPage(text: string, options: ChunkPageOptions): Chunk[] {
  const {
    docId,
    page,
    target = CHUNK_TARGET_CHARS,
    overlap = CHUNK_OVERLAP_CHARS,
    hardMax = CHUNK_HARD_MAX_CHARS,
  } = options;

  const units: Span[] = [];
  for (const [s, e] of paragraphSpans(text)) {
    if (e - s <= hardMax) {
      units.push([s, e]);
    } else {
      units.push(...sentenceSpans(text, s, e, hardMax));
    }
  }
  if (units.length === 0) return [];

  const spans: Span[] = [];
  let i = 0;
  while (i < units.length) {
    const first = units[i];
    if (first === undefined) break;

    let j = i;
    for (;;) {
      const next = units[j + 1];
      if (next === undefined || next[1] - first[0] > target) break;
      j += 1;
    }
    const last = units[j];
    if (last === undefined) break;

    const chunkStart = first[0];
    const chunkEnd = last[1];
    spans.push([chunkStart, chunkEnd]);
    if (j + 1 >= units.length) break;

    // Start the next chunk at the earliest unit that keeps the overlap within
    // budget. Never walk back past unit i, so the loop always moves forward.
    let k = j + 1;
    for (;;) {
      if (k - 1 <= i) break;
      const prev = units[k - 1];
      if (prev === undefined || chunkEnd - prev[0] > overlap) break;
      k -= 1;
    }
    i = k;
  }

  return spans.map(([s, e], index) => ({
    chunkId: `${docId}:${page}:${index}`,
    docId,
    page,
    start: s,
    end: e,
    text: text.slice(s, e),
  }));
}

export function chunkDocument(
  docId: string,
  pages: string[],
  options: ChunkOptions = {},
): Chunk[] {
  const chunks: Chunk[] = [];
  pages.forEach((text, pageIndex) => {
    chunks.push(...chunkPage(text, { ...options, docId, page: pageIndex + 1 }));
  });
  return chunks;
}
