/**
 * Taking one run of text out of a page for real.
 *
 * edit.ts paints a white box over the words and draws new ones on top, and its
 * header is honest that the old glyphs are still in the file. This file is the
 * other half of that story. It opens the page's drawing instructions, finds the
 * one operator that painted the run, and empties the string it was told to
 * show. Nothing is left behind for a text extractor to find, because there is
 * no longer anything there to find.
 *
 * What that costs is certainty, and this file spends all of it up front.
 *
 * A PDF page is a program, not a document. The same words can be drawn by one
 * operator or by thirty, at a position that is either written down or worked
 * out from the width of the glyphs before it, in a font whose bytes may not
 * mean what they look like. Nothing here guesses. It finds the operator whose
 * starting point on the page is the one the caller pointed at, and if there is
 * not exactly one of those, it stops.
 *
 * So `ok: false` is the normal answer to a hard page, not a bug report. The
 * caller is expected to fall back to covering, which always works and is honest
 * about what it did. A half rewritten content stream is a file no reader can
 * open, and losing somebody's document is far worse than not editing it.
 *
 * The last two steps are what make this safe to ship.
 *
 * The edited stream is replayed the same way the original was, and every run on
 * the page has to come back saying the same bytes from the same starting point
 * as before, with the one exception of the run that was emptied. Then the bytes
 * are reopened with pdf.js and read back, and the words have to be gone with
 * the rest of the page reading exactly as it did. If any of that is not true
 * the result is thrown away. Neither check is a heuristic, so the wrong
 * operator cannot be removed quietly and nothing can slide sideways unnoticed.
 *
 * Four limits worth knowing before wiring this up:
 *
 *   - Only the first run after a positioning operator can be matched. Working
 *     out where the second one starts means adding up the width of every glyph
 *     in the first, which needs the font's own metrics, and getting that subtly
 *     wrong would move text on somebody's page. Runs that follow another run
 *     are reported as unmatchable instead.
 *   - For the same reason, a run that HAS another run leaning on it is refused
 *     too. `(Salary ) Tj (250000) Tj` draws the second string wherever the
 *     first one stopped, so emptying the first slides the second back down the
 *     line. The words would still all be there and the page would still read
 *     correctly, which is exactly why nothing downstream would catch it.
 *   - Text drawn inside a form XObject is not searched, because this only reads
 *     the page's own stream. Those come back as no match.
 *   - If the same words appear twice on the page, this refuses. The promise is
 *     that the words are gone from the page, and taking out one of two copies
 *     does not keep it.
 */

import type { PDFRef } from "pdf-lib";

import {
  checkSize,
  loadPdf,
  pageBoxOf,
  pdfLib,
  PdfOpError,
  savePdf,
  type PDFDocument,
  type PDFPage,
} from "./common";
import { viewToUser, type PageBox, type Rect } from "../geometry";
import { openForViewing, pageText } from "../viewer";

export type ExciseTarget = {
  page: number;
  /** The run to remove, in VIEW space points, exactly as edit.ts receives it. */
  rect: Rect;
  /** Points from the top of rect down to the baseline. */
  baseline: number;
  /** What the run currently says, used to confirm the right one was found. */
  text: string;
};

export type ExciseOutcome =
  | { ok: true; bytes: Uint8Array; removed: string }
  | { ok: false; reason: string };

/**
 * How far the operator's starting point may sit from the one the caller asked
 * for, in points.
 *
 * The caller's point comes back from pdf.js, which rounds it through a viewport
 * transform, so it is never bit for bit the number in the file. A point and a
 * half is comfortably more than that drift and comfortably less than the gap
 * between two lines or two words, which is what stops it matching a neighbour
 * by accident.
 */
const MATCH_TOLERANCE = 1.5;

/**
 * A refusal, thrown from wherever the doubt is and turned into `ok: false` at
 * the top.
 *
 * Every giving-up point throws rather than returns, so no code path can carry
 * on holding a half edited stream. The message is written for a developer
 * reading a log, not for the person using the app, because the app shows them
 * the fallback and never mentions this ran.
 */
class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

type Lib = Awaited<ReturnType<typeof pdfLib>>;

// ---------------------------------------------------------------------------
// Matrices. PDF uses row vectors, so a point is [x y 1] times the matrix, and
// concatenating puts the new matrix on the LEFT of the old one.
// ---------------------------------------------------------------------------

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function multiply(first: Matrix, second: Matrix): Matrix {
  return {
    a: first.a * second.a + first.b * second.c,
    b: first.a * second.b + first.b * second.d,
    c: first.c * second.a + first.d * second.c,
    d: first.c * second.b + first.d * second.d,
    e: first.e * second.a + first.f * second.c + second.e,
    f: first.e * second.b + first.f * second.d + second.f,
  };
}

function translation(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

/**
 * The box the reader is actually shown.
 *
 * pageBoxOf reports the MediaBox, which is the whole sheet. Readers display the
 * CropBox clipped to it, and pdf.js sizes its viewport the same way, so the
 * view space points arriving here are CropBox based. On press ready files the
 * two differ by tens of points.
 *
 * This is the same helper edit.ts keeps private, copied for the same reason
 * edit.ts copies from stamp.ts: this file may not change that one, and the two
 * have to agree on what view space means or the point handed in lands
 * somewhere else entirely.
 */
function visibleBoxOf(page: PDFPage): PageBox {
  const media = pageBoxOf(page);
  const crop = page.getCropBox();

  // Anything outside the MediaBox is ignored by every reader, per the spec, so
  // what the reader sees is the overlap of the two.
  const left = Math.max(media.originX, crop.x);
  const bottom = Math.max(media.originY, crop.y);
  const right = Math.min(media.originX + media.width, crop.x + crop.width);
  const top = Math.min(media.originY + media.height, crop.y + crop.height);

  // A CropBox that is backwards, empty or full of junk is worse than none.
  if (!(right > left) || !(top > bottom)) return media;

  return {
    originX: left,
    originY: bottom,
    width: right - left,
    height: top - bottom,
    rotation: media.rotation,
  };
}

// ---------------------------------------------------------------------------
// Reading the page's instructions
// ---------------------------------------------------------------------------

/**
 * Every content stream on the page, decoded and joined into one buffer.
 *
 * A page's Contents is either one stream or an array of them, and the spec says
 * an array behaves as a single stream whose joins fall between tokens. So a BT
 * block is allowed to start in one and finish in the next, and anything reading
 * them one at a time finds text objects that never open and never close.
 */
function readContentStreams(lib: Lib, doc: PDFDocument, page: PDFPage): Uint8Array {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = lib;
  const contents = page.node.Contents();
  if (contents === undefined) {
    throw new Refusal("this page has no content stream, so nothing on it can be removed");
  }

  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const stream = doc.context.lookup(entry);
    if (!(stream instanceof PDFRawStream)) {
      throw new Refusal("one of this page's content streams is not a stream this can read");
    }
    try {
      parts.push(decodePDFRawStream(stream).decode());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Refusal(`a content stream on this page would not decompress: ${message}`);
    }
  }
  if (parts.length === 0) throw new Refusal("this page's Contents is an empty array");

  let total = 0;
  for (const part of parts) total += part.length + 1;
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
    // A newline between two streams, because the spec only promises the join
    // lands between tokens and not that either side wrote a separator.
    joined[at] = 0x0a;
    at += 1;
  }
  return joined;
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

type StringToken = {
  kind: "string";
  start: number;
  end: number;
  hex: boolean;
  bytes: Uint8Array;
};

type Token =
  | { kind: "number"; start: number; end: number; value: number }
  | StringToken
  | { kind: "name"; start: number; end: number; name: string }
  | { kind: "array"; start: number; end: number; items: Token[] }
  | { kind: "opaque"; start: number; end: number }
  | { kind: "operator"; start: number; end: number; name: string };

function isSpaceByte(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

function isDelimiterByte(b: number): boolean {
  return (
    b === 0x28 || // (
    b === 0x29 || // )
    b === 0x3c || // <
    b === 0x3e || // >
    b === 0x5b || // [
    b === 0x5d || // ]
    b === 0x7b || // {
    b === 0x7d || // }
    b === 0x2f || // /
    b === 0x25 //   %
  );
}

function hexValue(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

/**
 * Split a content stream into tokens, keeping the byte range of each one.
 *
 * The ranges are the whole point. Cutting a string out later means writing back
 * every byte except the ones between two offsets, so a tokenizer that reported
 * only values would be no use here.
 */
function tokenize(data: Uint8Array): Token[] {
  let pos = 0;

  /** The byte at an offset, or -1 past the end, so no caller has to bounds check. */
  const at = (index: number): number =>
    index >= 0 && index < data.length ? (data[index] as number) : -1;

  const isRegular = (b: number): boolean => b >= 0 && !isSpaceByte(b) && !isDelimiterByte(b);

  function skipBlanks(): void {
    for (;;) {
      const b = at(pos);
      if (isSpaceByte(b)) {
        pos += 1;
        continue;
      }
      if (b === 0x25) {
        while (pos < data.length && at(pos) !== 0x0a && at(pos) !== 0x0d) pos += 1;
        continue;
      }
      return;
    }
  }

  function readLiteralString(start: number): StringToken {
    pos += 1;
    const bytes: number[] = [];
    let depth = 1;
    for (;;) {
      const b = at(pos);
      if (b < 0) throw new Refusal("a text string in the content stream is never closed");
      pos += 1;

      if (b === 0x5c) {
        const next = at(pos);
        if (next < 0) throw new Refusal("a text string ends in the middle of an escape");
        pos += 1;
        if (next === 0x6e) bytes.push(0x0a);
        else if (next === 0x72) bytes.push(0x0d);
        else if (next === 0x74) bytes.push(0x09);
        else if (next === 0x62) bytes.push(0x08);
        else if (next === 0x66) bytes.push(0x0c);
        else if (next === 0x0a) {
          // A backslash at the end of a line joins it to the next one.
        } else if (next === 0x0d) {
          if (at(pos) === 0x0a) pos += 1;
        } else if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let digits = 0; digits < 2; digits += 1) {
            const digit = at(pos);
            if (digit < 0x30 || digit > 0x37) break;
            value = value * 8 + (digit - 0x30);
            pos += 1;
          }
          bytes.push(value & 0xff);
        } else {
          bytes.push(next);
        }
        continue;
      }

      if (b === 0x28) {
        depth += 1;
        bytes.push(b);
        continue;
      }
      if (b === 0x29) {
        depth -= 1;
        if (depth === 0) {
          return { kind: "string", start, end: pos, hex: false, bytes: Uint8Array.from(bytes) };
        }
        bytes.push(b);
        continue;
      }
      if (b === 0x0d) {
        // Any line ending inside a string counts as one newline.
        if (at(pos) === 0x0a) pos += 1;
        bytes.push(0x0a);
        continue;
      }
      bytes.push(b);
    }
  }

  function readHexString(start: number): StringToken {
    pos += 1;
    const bytes: number[] = [];
    let half = -1;
    for (;;) {
      const b = at(pos);
      if (b < 0) throw new Refusal("a hex string in the content stream is never closed");
      pos += 1;
      if (b === 0x3e) {
        // An odd number of digits means the last byte was written short, and
        // the spec says to read the missing half as a zero.
        if (half >= 0) bytes.push(half << 4);
        return { kind: "string", start, end: pos, hex: true, bytes: Uint8Array.from(bytes) };
      }
      if (isSpaceByte(b)) continue;
      const digit = hexValue(b);
      if (digit < 0) throw new Refusal("a hex string holds something that is not a hex digit");
      if (half < 0) half = digit;
      else {
        bytes.push((half << 4) | digit);
        half = -1;
      }
    }
  }

  function readWord(): string {
    let word = "";
    for (;;) {
      const b = at(pos);
      if (!isRegular(b)) return word;
      word += String.fromCharCode(b);
      pos += 1;
    }
  }

  function readName(start: number): Token {
    pos += 1;
    let name = "";
    for (;;) {
      const b = at(pos);
      if (!isRegular(b)) break;
      pos += 1;
      if (b === 0x23) {
        const high = hexValue(at(pos));
        const low = hexValue(at(pos + 1));
        if (high >= 0 && low >= 0) {
          name += String.fromCharCode((high << 4) | low);
          pos += 2;
          continue;
        }
      }
      name += String.fromCharCode(b);
    }
    return { kind: "name", start, end: pos, name };
  }

  function readNumber(start: number): Token {
    const word = readWord();
    const value = Number.parseFloat(word);
    if (!Number.isFinite(value)) {
      throw new Refusal(`the content stream holds "${word}" where a number belongs`);
    }
    return { kind: "number", start, end: pos, value };
  }

  /**
   * Does what follows here look like drawing instructions rather than pixels.
   *
   * Operators, names and numbers are all printable ASCII. Image data is not,
   * except by chance. Ten characters is enough to tell the difference and short
   * enough that an inline image sitting at the very end of a stream still
   * passes.
   */
  function looksLikeInstructions(from: number): boolean {
    let seen = 0;
    for (let scan = from; scan < data.length && seen < 10; scan += 1) {
      const b = at(scan);
      if (isSpaceByte(b)) continue;
      if (b < 0x20 || b > 0x7e) return false;
      seen += 1;
    }
    return true;
  }

  /**
   * Skip an inline image whole.
   *
   * The bytes after ID are image data, not instructions. Reading them as
   * operators turns up text operators nobody wrote and moves the imaginary pen
   * all over the page, which is exactly how a tokenizer ends up pointing at the
   * wrong words. So this finds the EI that closes the image and hands back
   * everything between as one lump.
   *
   * Finding it is the hard part, because "EI" is two perfectly ordinary bytes
   * and image data is free to contain them. Two things guard against stopping
   * early. If the dictionary declares a length, that is used and only checked,
   * never searched. Otherwise the scan looks past each candidate EI and refuses
   * one that is followed by more binary, which is what a byte pair inside the
   * pixels looks like.
   */
  function readInlineImage(start: number): Token {
    let previous: Token | undefined;
    let declared: number | undefined;

    for (let guard = 0; guard < 4096; guard += 1) {
      const token = readOne();
      if (token === undefined || token === "arrayEnd") {
        throw new Refusal("an inline image never reaches its ID operator");
      }
      // /L is the PDF 2.0 spelling, /Length the long one. Either says exactly
      // how many bytes of data follow ID, which beats any amount of guessing.
      if (
        token.kind === "number" &&
        previous?.kind === "name" &&
        (previous.name === "L" || previous.name === "Length")
      ) {
        declared = token.value;
      }
      previous = token;
      if (token.kind !== "operator" || token.name !== "ID") continue;

      // Exactly one blank separates ID from the first byte of image data.
      if (isSpaceByte(at(pos))) pos += 1;

      if (declared !== undefined && Number.isInteger(declared) && declared >= 0) {
        let probe = pos + declared;
        if (probe <= data.length) {
          while (isSpaceByte(at(probe))) probe += 1;
          // A length that does not land on the EI is a lie, so fall through to
          // the scan rather than trusting it.
          if (at(probe) === 0x45 && at(probe + 1) === 0x49) {
            pos = probe + 2;
            return { kind: "opaque", start, end: pos };
          }
        }
      }

      for (let scan = pos; scan < data.length - 1; scan += 1) {
        if (at(scan) !== 0x45 || at(scan + 1) !== 0x49) continue;
        const after = at(scan + 2);
        const closes =
          isSpaceByte(at(scan - 1)) &&
          (after < 0 || isSpaceByte(after) || isDelimiterByte(after));
        if (!closes || !looksLikeInstructions(scan + 2)) continue;
        pos = scan + 2;
        return { kind: "opaque", start, end: pos };
      }
      throw new Refusal("an inline image is never closed with EI");
    }
    throw new Refusal("an inline image has more entries than any real one would");
  }

  function readKeyword(start: number): Token {
    const word = readWord();
    if (word === "") {
      throw new Refusal(`the byte at ${start} in the content stream belongs nowhere`);
    }
    if (word === "BI") return readInlineImage(start);
    return { kind: "operator", start, end: pos, name: word };
  }

  function readArray(start: number): Token {
    pos += 1;
    const items: Token[] = [];
    for (;;) {
      const token = readOne();
      if (token === undefined) throw new Refusal("an array in the content stream is never closed");
      if (token === "arrayEnd") return { kind: "array", start, end: pos, items };
      items.push(token);
    }
  }

  function readDictionary(start: number): Token {
    pos += 2;
    for (;;) {
      skipBlanks();
      const b = at(pos);
      if (b < 0) throw new Refusal("a dictionary in the content stream is never closed");
      if (b === 0x3e && at(pos + 1) === 0x3e) {
        pos += 2;
        return { kind: "opaque", start, end: pos };
      }
      const token = readOne();
      if (token === undefined || token === "arrayEnd") {
        throw new Refusal("a dictionary in the content stream is written wrong");
      }
    }
  }

  function readOne(): Token | "arrayEnd" | undefined {
    skipBlanks();
    const start = pos;
    const b = at(start);
    if (b < 0) return undefined;
    if (b === 0x28) return readLiteralString(start);
    if (b === 0x3c) return at(start + 1) === 0x3c ? readDictionary(start) : readHexString(start);
    if (b === 0x5b) return readArray(start);
    if (b === 0x5d) {
      pos += 1;
      return "arrayEnd";
    }
    if (b === 0x7b || b === 0x7d) {
      pos += 1;
      return { kind: "opaque", start, end: pos };
    }
    if (b === 0x2f) return readName(start);
    if (b === 0x29) throw new Refusal("the content stream closes a string it never opened");
    if (b === 0x3e) throw new Refusal("the content stream has a stray > in it");
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) return readNumber(start);
    return readKeyword(start);
  }

  const tokens: Token[] = [];
  for (;;) {
    const token = readOne();
    if (token === undefined) return tokens;
    if (token === "arrayEnd") {
      throw new Refusal("the content stream closes an array it never opened");
    }
    tokens.push(token);
  }
}

// ---------------------------------------------------------------------------
// Replaying the text state machine
// ---------------------------------------------------------------------------

/** One show-text operator, and where it started drawing. */
type ShownRun = {
  /** The start of the baseline, in user space. */
  x: number;
  y: number;
  /**
   * False when the pen was left wherever the run before it finished.
   *
   * Working that position out means adding up the width of every glyph in the
   * run before, which needs the font's own metrics. Those are wrong often
   * enough that trusting them would eventually move text on somebody's page, so
   * a run that follows another run is not a candidate at all.
   */
  placed: boolean;
  /** The size the text came out at, after both matrices. */
  size: number;
  /** Byte ranges of the strings to empty, in stream order. */
  ranges: Array<{ start: number; end: number; hex: boolean }>;
  /** The bytes the operator was told to show, all of its strings joined. */
  bytes: Uint8Array;
  /** The resource name from the last Tf, needed to read those bytes back. */
  font: string | undefined;
};

/** Everything q saves and Q puts back. The two matrices below are not part of it. */
type TextState = {
  ctm: Matrix;
  size: number;
  hScale: number;
  rise: number;
  leading: number;
  font: string | undefined;
};

/** An operand counted back from the end, because that is where operators take them from. */
function numberFromEnd(operands: Token[], back: number): number {
  const token = operands[operands.length - back];
  if (!token || token.kind !== "number") {
    throw new Refusal("an operator that places text was handed something that is not a number");
  }
  return token.value;
}

function matrixFromEnd(operands: Token[]): Matrix {
  return {
    a: numberFromEnd(operands, 6),
    b: numberFromEnd(operands, 5),
    c: numberFromEnd(operands, 4),
    d: numberFromEnd(operands, 3),
    e: numberFromEnd(operands, 2),
    f: numberFromEnd(operands, 1),
  };
}

/**
 * Walk the whole stream and note every place text was drawn.
 *
 * Only the starting point of each run matters, which is why nothing here works
 * out how far the pen travels afterwards. The horizontal scale and the font
 * size are carried anyway because they are part of the state q and Q have to
 * put back, and dropping them would make a later q/Q restore the wrong thing.
 */
function findShownRuns(tokens: Token[]): ShownRun[] {
  const runs: ShownRun[] = [];
  const saved: TextState[] = [];
  let state: TextState = {
    ctm: IDENTITY,
    size: 0,
    hScale: 1,
    rise: 0,
    leading: 0,
    font: undefined,
  };
  let textMatrix = IDENTITY;
  let lineMatrix = IDENTITY;
  let inText = false;
  let placed = false;
  let operands: Token[] = [];

  const nextLine = (): void => {
    lineMatrix = multiply(translation(0, -state.leading), lineMatrix);
    textMatrix = lineMatrix;
    placed = true;
  };

  const record = (strings: StringToken[]): void => {
    const whole = multiply(textMatrix, state.ctm);
    // The pen sits at (0, rise) in text space, so the rise is the only part of
    // the text state that moves the starting point. The size and the horizontal
    // scale only change how far it travels after the first glyph.
    const x = whole.c * state.rise + whole.e;
    const y = whole.d * state.rise + whole.f;

    let length = 0;
    for (const part of strings) length += part.bytes.length;
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const part of strings) {
      bytes.set(part.bytes, at);
      at += part.bytes.length;
    }

    runs.push({
      x,
      y,
      placed: inText && placed,
      size: state.size * Math.hypot(whole.b, whole.d),
      ranges: strings.map((part) => ({ start: part.start, end: part.end, hex: part.hex })),
      bytes,
      font: state.font,
    });
    placed = false;
  };

  const lastString = (): StringToken[] => {
    const token = operands[operands.length - 1];
    if (!token || token.kind !== "string") {
      throw new Refusal("a show-text operator was handed something that is not a string");
    }
    return [token];
  };

  for (const token of tokens) {
    if (token.kind !== "operator") {
      operands.push(token);
      // No real operator takes more than a handful of operands, so a stream
      // that piles them up is junk and would otherwise grow without end.
      if (operands.length > 64) operands = operands.slice(-64);
      continue;
    }

    switch (token.name) {
      case "q":
        saved.push({ ...state });
        break;
      case "Q": {
        // A Q with nothing to put back is a broken stream, but every reader
        // carries on rather than dropping the rest of the page, so this does
        // too. The check at the end is what decides if the result is usable.
        const previous = saved.pop();
        if (previous) state = previous;
        break;
      }
      case "cm":
        state.ctm = multiply(matrixFromEnd(operands), state.ctm);
        break;
      case "BT":
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
        inText = true;
        placed = true;
        break;
      case "ET":
        inText = false;
        placed = false;
        break;
      case "Tm":
        textMatrix = matrixFromEnd(operands);
        lineMatrix = textMatrix;
        placed = true;
        break;
      case "Td":
        lineMatrix = multiply(
          translation(numberFromEnd(operands, 2), numberFromEnd(operands, 1)),
          lineMatrix,
        );
        textMatrix = lineMatrix;
        placed = true;
        break;
      case "TD": {
        const tx = numberFromEnd(operands, 2);
        const ty = numberFromEnd(operands, 1);
        state.leading = -ty;
        lineMatrix = multiply(translation(tx, ty), lineMatrix);
        textMatrix = lineMatrix;
        placed = true;
        break;
      }
      case "T*":
        nextLine();
        break;
      case "TL":
        state.leading = numberFromEnd(operands, 1);
        break;
      case "Ts":
        state.rise = numberFromEnd(operands, 1);
        break;
      case "Tz":
        state.hScale = numberFromEnd(operands, 1) / 100;
        break;
      case "Tf": {
        const size = operands[operands.length - 1];
        const name = operands[operands.length - 2];
        if (size && size.kind === "number") state.size = size.value;
        if (name && name.kind === "name") state.font = name.name;
        break;
      }
      case "Tj":
        record(lastString());
        break;
      // Both of these move to the next line before they draw, which is why the
      // starting point is worked out after the move and not before it.
      case "'":
      case '"':
        nextLine();
        record(lastString());
        break;
      case "TJ": {
        const array = operands[operands.length - 1];
        if (!array || array.kind !== "array") {
          throw new Refusal("a TJ operator was handed something that is not an array");
        }
        const strings: StringToken[] = [];
        for (const item of array.items) {
          if (item.kind === "string") strings.push(item);
        }
        record(strings);
        break;
      }
      default:
        break;
    }
    operands = [];
  }

  return runs;
}

function sameBytes(one: Uint8Array, two: Uint8Array): boolean {
  if (one.length !== two.length) return false;
  for (let at = 0; at < one.length; at += 1) {
    if (one[at] !== two[at]) return false;
  }
  return true;
}

/**
 * The edited stream, replayed, has to be the original stream replayed with one
 * run emptied and nothing else different.
 *
 * This is the check that proves nothing moved, and it is worth being clear
 * about why the reading at the end is not enough on its own. A text extractor
 * reports what a page says, not where it says it, so a page whose second half
 * slid two inches to the left reads exactly the same afterwards. Replaying the
 * bytes is the only way to see the difference, and doing it on the file that is
 * about to be handed back is the only way to know it was this edit that was
 * safe rather than edits in general.
 *
 * Every run is compared, not only the ones near the cut, because a byte range
 * that slipped by one can turn a later `1 0 0 1 40 200 Tm` into something else
 * entirely and the damage shows up nowhere near where the knife went in.
 */
function replayUnchanged(before: ShownRun[], after: ShownRun[], emptied: number): boolean {
  if (before.length !== after.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    const one = before[index];
    const two = after[index];
    if (!one || !two) return false;
    if (one.placed !== two.placed) return false;
    if (one.font !== two.font) return false;
    // Both numbers come out of the same arithmetic on the same operands, so
    // they are equal to the last bit unless something really changed.
    if (one.x !== two.x || one.y !== two.y) return false;
    if (index === emptied) {
      if (two.bytes.length !== 0) return false;
      continue;
    }
    if (!sameBytes(one.bytes, two.bytes)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Reading a run back, so the caller's text can confirm the match
// ---------------------------------------------------------------------------

/**
 * The 32 characters WinAnsi puts where Latin-1 keeps control codes, by code
 * point.
 *
 * They are written as numbers so this file stays plain ASCII, which also keeps
 * the dashes that live at 0x96 and 0x97 out of the source.
 */
const WIN_ANSI_HIGH = [
  0x20ac, 0x0000, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x0000, 0x017d, 0x0000, 0x0000, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x0000, 0x017e, 0x0178,
];

/**
 * Can the bytes of this run be read as characters with any confidence.
 *
 * A Type0 font packs two bytes per glyph through a CMap, and a font carrying
 * its own Differences array moves characters to whatever slots it likes. In
 * both cases the bytes look like text and are not, so this says no and the
 * caller skips the confirmation rather than comparing nonsense to the truth.
 * Skipping it is safe: the check against pdf.js at the end is what actually
 * decides whether the right words went.
 */
function fontReadsAsWinAnsi(lib: Lib, page: PDFPage, name: string | undefined): boolean {
  if (name === undefined) return false;
  const { PDFName, PDFDict } = lib;

  // Every step here asks for the plain object and checks the type itself.
  // pdf-lib's lookupMaybe throws when an entry holds a different type rather
  // than answering no, and /Encoding holding a name instead of a dictionary is
  // the ordinary case, not a broken file.
  const resources = page.node.Resources();
  if (!resources) return false;
  const fonts = resources.lookup(PDFName.Font);
  if (!(fonts instanceof PDFDict)) return false;
  const font = fonts.lookup(PDFName.of(name));
  if (!(font instanceof PDFDict)) return false;
  // lookup, not get, because a font dictionary is allowed to hold its Subtype
  // as a reference and a raw reference stringifies to something that is not
  // /Type0, which would read a two byte font as if it were one byte.
  const subtype = font.lookup(PDFName.of("Subtype"));
  if (subtype !== undefined && String(subtype) === "/Type0") return false;
  const encoding = font.lookup(PDFName.of("Encoding"));
  if (encoding instanceof PDFDict && encoding.has(PDFName.of("Differences"))) return false;
  return true;
}

function decodeWinAnsi(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte >= 0x80 && byte <= 0x9f) {
      const point = WIN_ANSI_HIGH[byte - 0x80] ?? 0;
      out += String.fromCharCode(point === 0 ? byte : point);
      continue;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * One line, single spaced, nothing on the ends.
 *
 * Two extractors almost never agree about spacing, because pdf.js invents a
 * space wherever it sees a gap and the file itself may or may not have written
 * one. Every comparison in this file goes through here so a difference in
 * spacing is never mistaken for a difference in words.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The same words with every blank taken out.
 *
 * This is only used to check the run against what the caller says it says, and
 * it is looser than flatten on purpose. A run written as `[(Se) -20 (cret)] TJ`
 * is one word in the file and pdf.js may report it as "Se cret", because it
 * turns a wide enough gap into a space and a kern is just a small gap. Holding
 * that difference against the match would refuse most justified text. The
 * letters still have to be identical and in the same order.
 */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Cutting, and writing the page back
// ---------------------------------------------------------------------------

/**
 * Copy the stream with the chosen strings emptied.
 *
 * The operator itself stays. Dropping `Tj` along with its string would leave
 * the operand of whatever came before it dangling, and a TJ array missing its
 * brackets ends the page's drawing early. An empty string draws nothing and
 * leaves every following byte meaning what it meant.
 */
function blankStrings(
  data: Uint8Array,
  ranges: Array<{ start: number; end: number; hex: boolean }>,
): Uint8Array {
  const ordered = [...ranges].sort((one, two) => one.start - two.start);
  const pieces: Uint8Array[] = [];
  let at = 0;
  for (const range of ordered) {
    if (range.start < at || range.end > data.length) {
      throw new Refusal("two strings to remove overlap, which no real stream does");
    }
    pieces.push(data.subarray(at, range.start));
    pieces.push(Uint8Array.from(range.hex ? [0x3c, 0x3e] : [0x28, 0x29]));
    at = range.end;
  }
  pieces.push(data.subarray(at));

  let total = 0;
  for (const piece of pieces) total += piece.length;
  const out = new Uint8Array(total);
  let write = 0;
  for (const piece of pieces) {
    out.set(piece, write);
    write += piece.length;
  }
  return out;
}

/** Every object a page points at for its drawing instructions. */
function contentRefsOf(lib: Lib, page: PDFPage): PDFRef[] {
  const { PDFName, PDFArray, PDFRef: Ref } = lib;
  const entry = page.node.get(PDFName.of("Contents"));
  if (entry instanceof Ref) return [entry];
  if (entry instanceof PDFArray) {
    return entry.asArray().filter((item): item is PDFRef => item instanceof Ref);
  }
  return [];
}

/**
 * Put the edited instructions on the page as one plain stream.
 *
 * Uncompressed on purpose. It costs a few KB, it makes the result something a
 * person can open in a text editor to check this file's work, and the Shrink
 * tool packs the document properly later anyway.
 *
 * The streams that were there before are dropped, because a stream nobody
 * points at is still written into the saved file and would carry the words that
 * were just taken out. They are only dropped when no other page shares them,
 * which is legal though rare, and keeping one stale copy is far better than
 * emptying a page nobody asked about.
 */
function writeContents(lib: Lib, doc: PDFDocument, page: PDFPage, data: Uint8Array): void {
  const { PDFName } = lib;
  const mine = contentRefsOf(lib, page);
  const shared = new Set<string>();
  for (const other of doc.getPages()) {
    if (other === page) continue;
    for (const ref of contentRefsOf(lib, other)) shared.add(ref.tag);
  }

  const ref = doc.context.register(doc.context.stream(data));
  page.node.set(PDFName.of("Contents"), ref);

  for (const old of mine) {
    if (shared.has(old.tag)) continue;
    doc.context.delete(old);
  }
}

// ---------------------------------------------------------------------------
// Checking the result
// ---------------------------------------------------------------------------

/** What pdf.js reads off one page of these bytes. */
async function textOfPage(bytes: Uint8Array, index: number): Promise<string> {
  const open = await openForViewing(bytes);
  try {
    const page = await open.doc.getPage(index + 1);
    return await pageText(page);
  } finally {
    await open.close();
  }
}

/**
 * The page as it was, minus one copy of the run, has to be the page as it is.
 *
 * Checking only that the run disappeared would pass a file that also lost the
 * paragraph underneath, or that slid a line sideways. So this rebuilds what the
 * page ought to say now and demands a match. Every occurrence gets tried,
 * because the copy that went is not always the first one on the page.
 */
function pageSurvived(before: string, after: string, removed: string): boolean {
  const source = flatten(before);
  const result = flatten(after);
  const run = flatten(removed);
  if (run === "") return false;

  let from = 0;
  for (;;) {
    const found = source.indexOf(run, from);
    if (found < 0) return false;
    if (flatten(source.slice(0, found) + source.slice(found + run.length)) === result) return true;
    from = found + 1;
  }
}

// ---------------------------------------------------------------------------
// The one thing this file exports
// ---------------------------------------------------------------------------

function checkTarget(target: ExciseTarget): void {
  if (typeof target !== "object" || target === null) {
    throw new Refusal("no target was given");
  }
  if (!Number.isInteger(target.page) || target.page < 0) {
    throw new Refusal(`${String(target.page)} is not a page number`);
  }
  const rect = target.rect;
  if (typeof rect !== "object" || rect === null) {
    throw new Refusal("the target has no rectangle, so there is nowhere to look");
  }
  const measurements: Array<[string, number]> = [
    ["left edge", rect.x],
    ["top edge", rect.y],
    ["width", rect.width],
    ["height", rect.height],
    ["baseline", target.baseline],
  ];
  for (const [name, value] of measurements) {
    if (!Number.isFinite(value)) {
      throw new Refusal(`the target's ${name} is ${String(value)}, which is not a measurement`);
    }
  }
  if (typeof target.text !== "string" || flatten(target.text) === "") {
    throw new Refusal("the target has no text, so there is nothing to confirm the match against");
  }
}

/**
 * Take one run of text out of a page, or explain why it was left alone.
 *
 * The input is never touched. It is copied on the way into pdf-lib and copied
 * again on the way into pdf.js, so a caller can keep the same array for undo
 * and hand it to this twice.
 */
export async function exciseTextRun(
  bytes: Uint8Array,
  target: ExciseTarget,
): Promise<ExciseOutcome> {
  try {
    checkTarget(target);
    checkSize(bytes);

    const lib = await pdfLib();
    const doc = await loadPdf(bytes);
    const total = doc.getPageCount();
    if (target.page >= total) {
      throw new Refusal(
        `page ${target.page + 1} was asked for and this document has ${total} of them`,
      );
    }
    const page = doc.getPage(target.page);
    const box = visibleBoxOf(page);

    // Read the page before touching it. If it does not already say what the
    // caller thinks it says, nothing below can end well, and this is a much
    // clearer way to find that out than a failed check after the surgery.
    const before = await textOfPage(bytes, target.page);
    const wanted = flatten(target.text);
    if (!flatten(before).includes(wanted)) {
      throw new Refusal(`page ${target.page + 1} does not say "${wanted}" anywhere`);
    }

    const stream = readContentStreams(lib, doc, page);
    const runs = findShownRuns(tokenize(stream));
    if (runs.length === 0) {
      throw new Refusal("nothing in this page's own stream draws any text");
    }

    const point = viewToUser({ x: target.rect.x, y: target.rect.y + target.baseline }, box);
    const matches: number[] = [];
    runs.forEach((run, index) => {
      if (run.placed && Math.hypot(run.x - point.x, run.y - point.y) <= MATCH_TOLERANCE) {
        matches.push(index);
      }
    });

    if (matches.length > 1) {
      const sizes = matches
        .map((index) => `${(runs[index]?.size ?? 0).toFixed(1)}pt`)
        .join(" and ");
      throw new Refusal(
        `${matches.length} runs start within ${MATCH_TOLERANCE}pt of that spot, at ${sizes}, so which one was meant cannot be told`,
      );
    }
    if (matches.length === 0) {
      let nearest = Infinity;
      for (const run of runs) {
        if (!run.placed) continue;
        nearest = Math.min(nearest, Math.hypot(run.x - point.x, run.y - point.y));
      }
      const trailing = runs.filter((run) => !run.placed).length;
      throw new Refusal(
        `no run starts within ${MATCH_TOLERANCE}pt of that spot, the nearest placed one is ${
          Number.isFinite(nearest) ? `${nearest.toFixed(1)}pt away` : "nowhere near"
        }` +
          (trailing > 0
            ? `, and ${trailing} more follow another run so their start is not tracked`
            : ""),
      );
    }

    const found = matches[0];
    const run = found === undefined ? undefined : runs[found];
    if (found === undefined || !run) {
      throw new Refusal("the matched run went missing, which is a bug in this file");
    }
    if (run.ranges.length === 0) {
      throw new Refusal("the operator at that spot shows no string, so there is nothing to empty");
    }

    // The run drawn next may have been left to start wherever this one stopped.
    // Emptying this one then slides it back along the line, and because the
    // page still says all the same words in the same order, nothing further
    // down would notice. So this is the one case where the words really can be
    // taken out and the answer is still no.
    const leaning = runs[found + 1];
    if (leaning && !leaning.placed) {
      throw new Refusal(
        "the run drawn straight after this one starts wherever this one stops, so taking these words out would slide it along the line",
      );
    }

    let readable: string | undefined;
    if (fontReadsAsWinAnsi(lib, page, run.font)) {
      readable = flatten(decodeWinAnsi(run.bytes));
      if (squash(readable) !== squash(wanted)) {
        throw new Refusal(
          `the run at that spot says "${readable}" and the caller asked to remove "${wanted}"`,
        );
      }
    }

    const cut = blankStrings(stream, run.ranges);
    // Replay the edited bytes before writing them anywhere. If the cut moved
    // anything, or landed a byte off and changed an operator, this is where it
    // shows, and the page is still untouched at this point.
    if (!replayUnchanged(runs, findShownRuns(tokenize(cut)), found)) {
      throw new Refusal(
        "reading the edited instructions back gave a different page, so the edit was thrown away",
      );
    }

    writeContents(lib, doc, page, cut);
    const edited = await savePdf(doc);

    const after = await textOfPage(edited, target.page);
    if (flatten(after).includes(wanted)) {
      throw new Refusal(
        `page ${target.page + 1} still says "${wanted}" after the cut, which usually means those words are on the page more than once`,
      );
    }
    if (!pageSurvived(before, after, target.text)) {
      throw new Refusal(
        "the rest of the page did not come through the cut unchanged, so the edit was thrown away",
      );
    }

    return { ok: true, bytes: edited, removed: readable ?? target.text };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.message };
    if (err instanceof PdfOpError) {
      return { ok: false, reason: err.hint ? `${err.message} ${err.hint}` : err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `nothing was changed because this went wrong: ${message}` };
  }
}
