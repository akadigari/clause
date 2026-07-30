import { describe, expect, it } from "vitest";

import { blockAt, findTextBlocks, groupIntoBlocks, groupIntoLines } from "./textblocks";
import type { TextPiece } from "./viewer";

/**
 * Runs are built the way pdf.js reports them: y is the top of the run, one font
 * size above the baseline, and width is the drawn width.
 */
let cursor = 0;
function piece(str: string, x: number, y: number, size = 10, width?: number): TextPiece {
  const start = cursor;
  cursor += str.length;
  return {
    str,
    x,
    y,
    width: width ?? str.length * size * 0.5,
    height: size,
    fontSize: size,
    squeeze: 1,
    hasEOL: false,
    start,
    end: start + str.length,
  };
}

function reset() {
  cursor = 0;
}

describe("groupIntoLines", () => {
  it("glues fragmented runs on one baseline back into a single line", () => {
    reset();
    // The case that makes raw runs useless to click: one word split in three.
    const line = groupIntoLines([
      piece("Confid", 100, 50),
      piece("ential", 130, 50),
      piece(" Memorandum", 160, 50),
    ]);
    expect(line).toHaveLength(1);
    expect(line[0]?.text).toBe("Confidential Memorandum");
  });

  it("tolerates a baseline that wobbles slightly", () => {
    reset();
    const line = groupIntoLines([piece("same", 100, 50), piece("line", 130, 50.3)]);
    expect(line).toHaveLength(1);
  });

  it("splits a title and a right-aligned date into two lines", () => {
    reset();
    // Straight off the resume: "Watercress Capital" left, "Memphis, TN" right,
    // same baseline, a wide gap between them. Two separate things to edit.
    const lines = groupIntoLines([
      piece("Watercress Capital", 90, 50, 10, 95),
      piece("Memphis, TN", 430, 50, 10, 60),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe("Watercress Capital");
    expect(lines[1]?.text).toBe("Memphis, TN");
  });

  it("ignores blank runs", () => {
    reset();
    expect(groupIntoLines([piece("   ", 10, 10), piece("", 20, 10)])).toEqual([]);
  });

  it("puts the baseline below the top of the box", () => {
    reset();
    const [line] = groupIntoLines([piece("Ayush", 100, 40, 14)]);
    expect(line?.baseline).toBeCloseTo(14, 5);
    // The box reaches past the baseline so descenders are covered.
    expect(line?.height).toBeGreaterThan(14);
  });

  it("reads out in top to bottom order regardless of draw order", () => {
    reset();
    const lines = groupIntoLines([piece("second", 90, 70), piece("first", 90, 50)]);
    expect(lines.map((l) => l.text)).toEqual(["first", "second"]);
  });
});

describe("groupIntoBlocks", () => {
  it("keeps a wrapped bullet as one block", () => {
    reset();
    // "Built a comprehensive Confidential Information Memorandum (CIM) with
    //  company analysis, executive summary, industry outlook..."
    const lines = groupIntoLines([
      piece("Built a comprehensive Confidential Information Memorandum", 110, 100),
      piece("outlook, and financial models for a sell-side M&A process", 110, 112),
    ]);
    const blocks = groupIntoBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lines).toHaveLength(2);
    expect(blocks[0]?.text.split("\n")).toHaveLength(2);
  });

  it("starts a new block when the next bullet is indented differently", () => {
    reset();
    const lines = groupIntoLines([
      piece("first bullet wrapping here", 110, 100),
      piece("continuation of the first", 110, 112),
      piece("a differently indented one", 140, 124),
    ]);
    expect(groupIntoBlocks(lines)).toHaveLength(2);
  });

  it("starts a new block across a paragraph gap", () => {
    reset();
    const lines = groupIntoLines([
      piece("end of one paragraph", 90, 100),
      piece("start of the next", 90, 160),
    ]);
    expect(groupIntoBlocks(lines)).toHaveLength(2);
  });

  it("keeps a heading apart from the body under it", () => {
    reset();
    // Different size, so not the same block even though it is close.
    const lines = groupIntoLines([
      piece("WORK EXPERIENCE", 90, 100, 12),
      piece("Watercress Capital", 90, 114, 10),
    ]);
    expect(groupIntoBlocks(lines)).toHaveLength(2);
  });

  it("gives the block a box that contains every one of its lines", () => {
    reset();
    const lines = groupIntoLines([
      piece("short", 110, 100, 10, 40),
      piece("a much longer second line", 110, 112, 10, 160),
    ]);
    const [block] = groupIntoBlocks(lines);
    expect(block?.x).toBe(110);
    expect(block?.width).toBe(160);
    expect(block?.y).toBeLessThanOrEqual(100);
    for (const line of block?.lines ?? []) {
      expect(line.x).toBeGreaterThanOrEqual(block!.x);
      expect(line.y + line.height).toBeLessThanOrEqual(block!.y + block!.height + 0.01);
    }
  });

  it("carries the character range across the whole block", () => {
    reset();
    const lines = groupIntoLines([piece("aaaa", 90, 100), piece("bbbb", 90, 112)]);
    const [block] = groupIntoBlocks(lines);
    expect(block?.start).toBe(0);
    expect(block?.end).toBe(8);
  });
});

describe("findTextBlocks on a resume-shaped page", () => {
  it("produces the blocks a person would expect to click", () => {
    reset();
    const blocks = findTextBlocks([
      piece("AYUSH KADIGARI", 240, 30, 16, 130),
      piece("Watercress Capital", 90, 100, 10, 95),
      piece("Memphis, TN", 430, 100, 10, 60),
      piece("Investment Banking Intern", 90, 112, 10, 120),
      piece("Apr. 2026 - Present", 430, 112, 10, 90),
      piece("Built a comprehensive Confidential Information Memorandum", 110, 130, 10, 300),
      piece("outlook, and financial models for a sell-side M&A process", 110, 142, 10, 290),
    ]);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain("AYUSH KADIGARI");
    expect(texts).toContain("Memphis, TN");
    // The wrapped bullet is one block, not two.
    expect(texts.some((t) => t.includes("Built a comprehensive") && t.includes("\n"))).toBe(true);
  });
});

describe("blockAt", () => {
  it("finds the block under a click", () => {
    reset();
    const blocks = findTextBlocks([
      piece("Watercress Capital", 90, 100, 10, 95),
      piece("Memphis, TN", 430, 100, 10, 60),
    ]);
    expect(blockAt(blocks, 100, 105)?.text).toBe("Watercress Capital");
    expect(blockAt(blocks, 440, 105)?.text).toBe("Memphis, TN");
  });

  it("returns null on empty space", () => {
    reset();
    const blocks = findTextBlocks([piece("only", 90, 100)]);
    expect(blockAt(blocks, 400, 400)).toBeNull();
  });

  it("prefers the smaller block where two overlap", () => {
    reset();
    const big = findTextBlocks([piece("a wide heading line", 50, 50, 20, 400)]);
    const small = findTextBlocks([piece("x", 100, 52, 8, 6)]);
    const picked = blockAt([...big, ...small], 102, 56);
    expect(picked?.text).toBe("x");
  });
});
