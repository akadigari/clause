/** The embedder has to be bit-identical to the Python one and dead
 * deterministic, so md5 is pinned to the published vectors first. */

import { describe, expect, it } from "vitest";

import { HashingEmbedder, md5Hex, md5Prefix32 } from "./embedding";

describe("md5", () => {
  it("matches the RFC 1321 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe(
      "c3fcd3d76192e4007dfb496cca67e13b",
    );
    // 62 and 80 bytes both spill into a second block, which is where padding
    // bugs live.
    expect(
      md5Hex("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("d174ab98d277d9f5a5611c2c9f419d9f");
    expect(
      md5Hex(
        "123456789012345678901234567890123456789012345678901234567890" +
          "12345678901234567890",
      ),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("reads the first four digest bytes big-endian, like Python", () => {
    expect(md5Prefix32("")).toBe(0xd41d8cd9);
    expect(md5Prefix32("abc")).toBe(0x90015098);
  });
});

describe("HashingEmbedder tokens", () => {
  const embedder = new HashingEmbedder();

  it("lowercases, keeps digits and apostrophes, and splits on punctuation", () => {
    expect(embedder.tokens("Late FEE of $75, don't be late!")).toEqual([
      "late",
      "fee",
      "75",
      "don't",
      "late",
    ]);
  });

  it("drops stopwords so question scaffolding cannot match everything", () => {
    expect(embedder.tokens("what am i agreeing to")).toEqual(["am", "agreeing"]);
    expect(embedder.tokens("the and of to with")).toEqual([]);
  });
});

describe("HashingEmbedder embed", () => {
  const embedder = new HashingEmbedder();

  it("puts a single token in the bucket md5 chose, with md5's sign", () => {
    // md5("abc") starts 0x90015098: top bit set, so the sign is positive, and
    // 0x90015098 % 512 is 152.
    const vec = embedder.embed(["abc"])[0];
    if (vec === undefined) throw new Error("expected a vector");
    expect(vec).toHaveLength(512);
    expect(vec[152]).toBeCloseTo(1, 12);
    expect(vec.filter((x) => x !== 0)).toHaveLength(1);
  });

  it("weights repeats sublinearly, at 1 + ln(count)", () => {
    const vec = embedder.embed(["abc abc def"])[0];
    if (vec === undefined) throw new Error("expected a vector");
    const nonZero = vec.filter((x) => x !== 0).map(Math.abs).sort((a, b) => b - a);
    expect(nonZero).toHaveLength(2);
    const [big, small] = nonZero;
    if (big === undefined || small === undefined) throw new Error("expected two");
    expect(big / small).toBeCloseTo(1 + Math.log(2), 10);
  });

  it("returns unit vectors, and all zeros when there is nothing to hash", () => {
    const [text, empty] = embedder.embed(["late fee of $75 per month", "the and of"]);
    if (text === undefined || empty === undefined) throw new Error("expected two");
    const norm = Math.sqrt(text.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeCloseTo(1, 12);
    expect(empty.every((x) => x === 0)).toBe(true);
  });

  it("is deterministic across calls and instances", () => {
    const a = embedder.embed(["early termination fee equal to two months"])[0];
    const b = new HashingEmbedder().embed([
      "early termination fee equal to two months",
    ])[0];
    expect(b).toEqual(a);
  });

  it("scores related text above unrelated text", () => {
    const [question, related, unrelated] = embedder.embed([
      "what is the late fee on rent",
      "If rent is not received by the fifth day, the tenant pays a late fee.",
      "Birds tend to sing at dawn and the grass turns green after rain.",
    ]);
    if (question === undefined || related === undefined || unrelated === undefined) {
      throw new Error("expected three vectors");
    }
    const dot = (a: number[], b: number[]) =>
      a.reduce((acc, x, i) => acc + x * (b[i] ?? 0), 0);
    expect(dot(question, related)).toBeGreaterThan(dot(question, unrelated));
  });
});

describe("HashingEmbedder isRelevant", () => {
  const embedder = new HashingEmbedder();

  it("rejects anything under the score threshold", () => {
    expect(embedder.isRelevant("late fee", "a late fee applies", 0.0)).toBe(false);
    expect(embedder.minRelevance).toBe(0.03);
  });

  it("demands a real shared content token, not just a score", () => {
    // A hash collision can hand a decent score to text that shares no words.
    expect(embedder.isRelevant("late fee", "birds sing at dawn", 0.9)).toBe(false);
    expect(embedder.isRelevant("late fee", "the tenant pays a late fee", 0.9)).toBe(
      true,
    );
  });

  it("does not count stopword overlap as relevance", () => {
    expect(embedder.isRelevant("what is the deposit", "the sky is blue", 0.9)).toBe(
      false,
    );
  });
});
