/**
 * Turning pdf.js text runs into blocks a person can click.
 *
 * A PDF does not store paragraphs. pdf.js hands back runs, and a run is
 * whatever the file happened to emit as one drawing command: sometimes a whole
 * sentence, often a single word, occasionally one letter after a kerning pair.
 * Showing those raw would give you a box around "Confid" and another around
 * "ential", which is useless to click.
 *
 * So runs get glued back together in two passes. First into lines, by sharing
 * a baseline and sitting next to each other. Then lines into blocks, by
 * starting at the same left edge with normal line spacing, which is what a
 * wrapped bullet or a paragraph looks like.
 *
 * This is a guess, not a fact recovered from the file, because the fact is not
 * in the file. It is a good guess on ordinary documents and it will be wrong on
 * some, which is why the editor lets you work on a single line as well.
 */

import type { TextPiece } from "./viewer";

export type TextLine = {
  pieces: TextPiece[];
  text: string;
  /** View space, origin top left, points. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  /** Baseline distance from the top of the line box. */
  baseline: number;
  /** Character range in the page's text, for citations and search. */
  start: number;
  end: number;
};

export type TextBlock = {
  lines: TextLine[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The size of the largest run in the block, used as the editing default. */
  fontSize: number;
  start: number;
  end: number;
};

/** Two runs share a line if their baselines are within this share of the size. */
const BASELINE_TOLERANCE = 0.4;
/** A gap wider than this many spaces means a new column, not the same line. */
const LINE_GAP_LIMIT = 2.5;
/** Lines further apart than this share of the size start a new block. */
const BLOCK_GAP_LIMIT = 1.9;
/** Left edges further apart than this many points start a new block. */
const INDENT_TOLERANCE = 3;

function baselineOf(piece: TextPiece): number {
  // pageTextPieces reports y as the top of the run, one font size above the
  // baseline it was drawn on.
  return piece.y + piece.fontSize;
}

/**
 * Glue runs into lines.
 *
 * Runs arrive in the order the file drew them, which is usually reading order
 * but is not promised to be, so lines are keyed by baseline rather than by
 * assuming the next run continues the last one.
 */
export function groupIntoLines(pieces: TextPiece[]): TextLine[] {
  const usable = pieces.filter((p) => p.str.trim() !== "" && p.fontSize > 0);
  if (usable.length === 0) return [];

  const rows: TextPiece[][] = [];
  for (const piece of usable) {
    const base = baselineOf(piece);
    const row = rows.find((candidate) => {
      const first = candidate[0];
      if (!first) return false;
      const tolerance = Math.max(first.fontSize, piece.fontSize) * BASELINE_TOLERANCE;
      return Math.abs(baselineOf(first) - base) <= tolerance;
    });
    if (row) row.push(piece);
    else rows.push([piece]);
  }

  const lines: TextLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    // A wide gap in the middle of a row is two columns that happen to sit on
    // the same baseline, such as a job title on the left and a date on the
    // right. Those are separate things to edit.
    let run: TextPiece[] = [];
    const flush = () => {
      if (run.length > 0) lines.push(makeLine(run));
      run = [];
    };
    for (const piece of row) {
      const previous = run[run.length - 1];
      if (previous) {
        const gap = piece.x - (previous.x + previous.width);
        if (gap > previous.fontSize * LINE_GAP_LIMIT) flush();
      }
      run.push(piece);
    }
    flush();
  }

  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

function makeLine(pieces: TextPiece[]): TextLine {
  const x = Math.min(...pieces.map((p) => p.x));
  const right = Math.max(...pieces.map((p) => p.x + p.width));
  const fontSize = Math.max(...pieces.map((p) => p.fontSize));
  const base = Math.max(...pieces.map(baselineOf));
  const top = base - fontSize;
  // Descenders on g, y and p fall below the baseline, so the box has to reach
  // past it or the cover rectangle will clip them and leave tails behind.
  const height = fontSize * 1.22;

  return {
    pieces,
    text: pieces.map((p) => p.str).join(""),
    x,
    y: top,
    width: right - x,
    height,
    fontSize,
    baseline: base - top,
    start: Math.min(...pieces.map((p) => p.start)),
    end: Math.max(...pieces.map((p) => p.end)),
  };
}

/**
 * Glue lines into blocks.
 *
 * A block is what a reader would call one thing: a heading, a paragraph, one
 * bullet that wrapped onto a second line. The test is that the next line starts
 * at the same left edge and follows at normal line spacing.
 */
export function groupIntoBlocks(lines: TextLine[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let current: TextLine[] = [];

  const flush = () => {
    if (current.length > 0) blocks.push(makeBlock(current));
    current = [];
  };

  for (const line of lines) {
    const previous = current[current.length - 1];
    if (previous) {
      const gap = line.y - (previous.y + previous.height);
      const sameIndent = Math.abs(line.x - previous.x) <= INDENT_TOLERANCE;
      const sameSize = Math.abs(line.fontSize - previous.fontSize) <= 1;
      const closeEnough = gap <= previous.fontSize * BLOCK_GAP_LIMIT && gap > -previous.fontSize;
      if (!sameIndent || !sameSize || !closeEnough) flush();
    }
    current.push(line);
  }
  flush();

  return blocks;
}

function makeBlock(lines: TextLine[]): TextBlock {
  const x = Math.min(...lines.map((l) => l.x));
  const right = Math.max(...lines.map((l) => l.x + l.width));
  const top = Math.min(...lines.map((l) => l.y));
  const bottom = Math.max(...lines.map((l) => l.y + l.height));

  return {
    lines,
    text: lines.map((l) => l.text).join("\n"),
    x,
    y: top,
    width: right - x,
    height: bottom - top,
    fontSize: Math.max(...lines.map((l) => l.fontSize)),
    start: Math.min(...lines.map((l) => l.start)),
    end: Math.max(...lines.map((l) => l.end)),
  };
}

/** Both passes at once, which is what the editor actually calls. */
export function findTextBlocks(pieces: TextPiece[]): TextBlock[] {
  return groupIntoBlocks(groupIntoLines(pieces));
}

/** The block under a click, or null. Smallest wins where blocks overlap. */
export function blockAt(
  blocks: TextBlock[],
  x: number,
  y: number,
  slack = 2,
): TextBlock | null {
  const hits = blocks.filter(
    (b) =>
      x >= b.x - slack &&
      x <= b.x + b.width + slack &&
      y >= b.y - slack &&
      y <= b.y + b.height + slack,
  );
  if (hits.length === 0) return null;
  return hits.reduce((best, b) => (b.width * b.height < best.width * best.height ? b : best));
}
