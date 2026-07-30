/** The hashing embedder: a dependency-free lexical embedder.
 *
 * Tokens are hashed into a fixed-size vector with signed buckets and sublinear
 * term-frequency weighting, then L2-normalized, so cosine similarity
 * approximates weighted term overlap. It runs fully offline, it is
 * deterministic (which matters for tests), and it works well for
 * single-document Q&A where the question shares vocabulary with the clause
 * that answers it.
 *
 * md5, and why it is written out longhand here:
 * The Python backend hashes each token with md5 and reads the first 4 bytes
 * big-endian. The browser has no synchronous md5 (SubtleCrypto is async and
 * does not offer md5 at all), so the choice was either a new dependency, a
 * different hash, or about sixty lines of md5. This file implements md5, so a
 * vector produced here is bit-identical to one produced by the Python backend
 * and the two implementations stay honestly equivalent. The known-answer tests
 * in embedding.test.ts pin it to the RFC 1321 vectors.
 *
 * Note this is a hash for bucketing text, not for security. md5 is broken for
 * signatures and must never be used for one.
 */

import type { Embedder } from "./types";

const TOKEN = /[a-z0-9']+/g;

// Small stopword list: keeps question scaffolding ("what am i agreeing to")
// from matching every chunk and inflating relevance scores.
const STOPWORDS: ReadonlySet<string> = new Set(
  `a an and are as at be but by can could do does did for from had has have
  how i if in into is it its may me my of on or our shall should so than that
  the their them then there these they this to under upon was we were what
  when where which who whom will with would you your`.split(/\s+/),
);

// -- md5 -------------------------------------------------------------------

// Round constants: floor(abs(sin(i + 1)) * 2^32). Written out rather than
// computed so the values cannot drift with the platform's sin().
const MD5_K: readonly number[] = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
  0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
  0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const MD5_SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

/** Read a table entry. The tables are fixed length and every index is derived
 * from a bounded loop counter, so a miss means the code is wrong, not the data. */
function tableAt(table: readonly number[], index: number): number {
  const value = table[index];
  if (value === undefined) throw new Error(`md5: bad table index ${index}`);
  return value;
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

const ENCODER = new TextEncoder();

/** md5 of raw bytes, returned as 16 bytes. */
export function md5(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  // One 0x80 byte, then zeros, then the 64-bit length, rounded up to a whole
  // number of 64-byte blocks.
  const padded = new Uint8Array(((bytes.length + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const word = view.getUint32(offset + g * 4, true);
      const mixed = (f + a + tableAt(MD5_K, i) + word) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(mixed, tableAt(MD5_SHIFTS, i))) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0 >>> 0, true);
  out.setUint32(4, b0 >>> 0, true);
  out.setUint32(8, c0 >>> 0, true);
  out.setUint32(12, d0 >>> 0, true);
  return digest;
}

/** md5 of a string, as the usual lowercase hex. Used by the tests to pin the
 * implementation to the published vectors. */
export function md5Hex(text: string): string {
  return Array.from(md5(ENCODER.encode(text)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** First 4 bytes of the md5 digest, big-endian, as an unsigned 32-bit number.
 * This is what Python's int.from_bytes(digest[:4], "big") produces. */
export function md5Prefix32(text: string): number {
  const digest = md5(ENCODER.encode(text));
  const view = new DataView(digest.buffer);
  return view.getUint32(0, false);
}

// -- embedder --------------------------------------------------------------

export class HashingEmbedder implements Embedder {
  readonly name = "hash";

  // Low bar on the cosine score itself: a genuine single-term match inside a
  // long chunk can score about 0.05. Hash-bucket collisions can also produce
  // small spurious scores, so isRelevant() additionally demands a real shared
  // content token. That check, not the score, is what makes the abstain gate
  // deterministic.
  readonly minRelevance = 0.03;

  readonly dims: number;

  constructor(dims = 512) {
    this.dims = dims;
  }

  tokens(text: string): string[] {
    const found = text.toLowerCase().match(TOKEN) ?? [];
    return found.filter((token) => !STOPWORDS.has(token));
  }

  isRelevant(question: string, chunkText: string, score: number): boolean {
    if (score < this.minRelevance) return false;
    // Cosine on hashed vectors can collide; exact token overlap cannot.
    const asked = new Set(this.tokens(question));
    return this.tokens(chunkText).some((token) => asked.has(token));
  }

  embed(texts: string[]): number[][] {
    return texts.map((text) => {
      const vec = new Array<number>(this.dims).fill(0);
      const counts = new Map<string, number>();
      for (const token of this.tokens(text)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      for (const [token, count] of counts) {
        const digest = md5Prefix32(token);
        // Python tests the top bit: digest & 0x80000000.
        const sign = digest >= 0x80000000 ? 1 : -1;
        const bucket = digest % this.dims;
        vec[bucket] = (vec[bucket] ?? 0) + sign * (1 + Math.log(count));
      }
      let norm = 0;
      for (const x of vec) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      return vec.map((x) => x / norm);
    });
  }
}
