/**
 * Sign: draw your name once, then put it on the page.
 *
 * The pad is a plain canvas with three details that make a mouse-drawn line
 * look like a pen instead of a seismograph:
 *
 *   1. The path is smoothed. Each new point becomes a quadratic curve through
 *      the midpoint of the last two points, so the corners between samples get
 *      rounded off instead of showing up as hard kinks.
 *   2. The line thickness follows pointer pressure where the device reports it.
 *      Most mice report 0 or a flat 0.5, so anything outside a useful range is
 *      treated as a normal press.
 *   3. The backing store is sized in device pixels. Skipping that step is what
 *      makes a canvas signature look soft and grey on a retina screen.
 *
 * The image handed to the PDF is trimmed to the ink first. A whole 400x150 pad
 * is mostly empty space, and empty space still counts: an untrimmed signature
 * is placed by its transparent corner and lands nowhere near where you asked.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { PanelProps } from "../Inspector";
import { IconSign, IconTrash, IconUndo } from "../Icons";

type Dot = { x: number; y: number; force: number };
type Stroke = Dot[];
type Box = { x: number; y: number; w: number; h: number };

/** Matches --paper-ink. The pad is white paper on both benches. */
const INK = "#14181f";

/** Thinnest and thickest the pen gets, in CSS pixels. */
const THIN = 1.1;
const THICK = 3.4;

/** Room left around the ink in the saved image, in device pixels. */
const TRIM_PAD = 2;

/** Below this the pixel is antialiasing dust, not ink. */
const SEEN = 8;

const FACES = [
  {
    id: "classic",
    name: "Classic",
    stack: '"Times New Roman", Times, "Liberation Serif", serif',
  },
  {
    id: "flowing",
    name: "Flowing",
    stack: '"Snell Roundhand", "Brush Script MT", "Segoe Script", cursive',
  },
  {
    id: "formal",
    name: "Formal",
    stack: 'Georgia, "Palatino Linotype", "Book Antiqua", serif',
  },
] as const;

type FaceId = (typeof FACES)[number]["id"];

function stackOf(id: FaceId): string {
  return (FACES.find((f) => f.id === id) ?? FACES[0]).stack;
}

/**
 * Pressure, cleaned up.
 *
 * A mouse reports 0.5 while a button is down and 0 the rest of the time, and
 * some trackpads report 0 throughout. A raw 0 would draw a hairline, so
 * anything outside the range a real pen uses becomes a normal press.
 */
function forceOf(pressure: number): number {
  return pressure > 0.05 && pressure <= 1 ? pressure : 0.5;
}

function penWidth(force: number): number {
  return THIN + (THICK - THIN) * force;
}

function midpoint(a: Dot, b: Dot): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Round caps and joins, so separate segments meet without a visible seam. */
function prime(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/**
 * One piece of a stroke: the curve that ends at point `i`.
 *
 * It runs from the midpoint before to the midpoint after, bending around the
 * real sample in between. Drawing piece by piece rather than as one long path
 * is what lets each piece carry its own thickness.
 */
function drawPiece(ctx: CanvasRenderingContext2D, stroke: Stroke, i: number): void {
  const prev = stroke[i - 1];
  const now = stroke[i];
  if (!prev || !now) return;
  const before = stroke[i - 2];
  const from = before ? midpoint(before, prev) : prev;
  const to = midpoint(prev, now);

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(prev.x, prev.y, to.x, to.y);
  ctx.lineWidth = penWidth(now.force);
  ctx.stroke();
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const first = stroke[0];
  if (!first) return;

  // A tap with no movement is still a mark, so it gets a dot.
  if (stroke.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, penWidth(first.force) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  for (let i = 1; i < stroke.length; i += 1) drawPiece(ctx, stroke, i);

  // The pieces stop at the last midpoint, so the tail is drawn straight to the
  // final point. Without this the line ends short of where the pen lifted.
  const last = stroke[stroke.length - 1];
  const prev = stroke[stroke.length - 2];
  if (!last || !prev) return;
  const from = midpoint(prev, last);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(last.x, last.y);
  ctx.lineWidth = penWidth(last.force);
  ctx.stroke();
}

/**
 * A typed name, sized down until it fits the pad.
 *
 * Italic serif is what people picture when they think of a typed signature, so
 * every face here is drawn that way.
 */
function drawTyped(
  ctx: CanvasRenderingContext2D,
  text: string,
  stack: string,
  width: number,
  height: number,
): void {
  const name = text.trim();
  if (name === "") return;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const room = Math.max(40, width - 32);

  let size = Math.min(56, height * 0.44);
  while (size > 11) {
    ctx.font = `italic ${size}px ${stack}`;
    if (ctx.measureText(name).width <= room) break;
    size -= 1;
  }
  ctx.font = `italic ${size}px ${stack}`;
  // Sits on the ruled line the pad draws near the bottom.
  ctx.fillText(name, width / 2, height - 40);
}

/**
 * The smallest box that holds every pixel with any ink in it.
 *
 * Returns null for a blank pad, which is how the rest of the panel knows there
 * is nothing to place yet.
 */
function inkBounds(ctx: CanvasRenderingContext2D, width: number, height: number): Box | null {
  if (width < 1 || height < 1) return null;
  const pixels = ctx.getImageData(0, 0, width, height).data;

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const alpha = pixels[(py * width + px) * 4 + 3] ?? 0;
      if (alpha < SEEN) continue;
      if (px < left) left = px;
      if (px > right) right = px;
      if (py < top) top = py;
      if (py > bottom) bottom = py;
    }
  }

  if (right < 0 || bottom < 0) return null;

  const x = Math.max(0, left - TRIM_PAD);
  const y = Math.max(0, top - TRIM_PAD);
  return {
    x,
    y,
    w: Math.min(width, right + 1 + TRIM_PAD) - x,
    h: Math.min(height, bottom + 1 + TRIM_PAD) - y,
  };
}

export default function SignPanel({ doc, session, current }: PanelProps) {
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const [typed, setTyped] = useState("");
  const [face, setFace] = useState<FaceId>("classic");
  const [strokeCount, setStrokeCount] = useState(0);
  const [ink, setInk] = useState<Box | null>(null);
  const [width, setWidth] = useState(180);

  const pad = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const live = useRef<Stroke | null>(null);
  const ratio = useRef(1);

  const shape = doc.pages[current] ?? { width: 612, height: 792, rotation: 0 };
  const pageW = Math.round(shape.width);
  const pageH = Math.round(shape.height);

  const [x, setX] = useState(() => Math.round(shape.width * 0.2));
  const [y, setY] = useState(() => Math.round(shape.height * 0.75));

  const height = ink && ink.w > 0 ? Math.round((width * ink.h) / ink.w) : 0;
  const inked = mode === "type" ? typed.trim() !== "" : strokeCount > 0;
  const ready = ink !== null && height > 0;

  const paint = useCallback(() => {
    const canvas = pad.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = ratio.current;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    prime(ctx);

    if (mode === "type") {
      drawTyped(ctx, typed, stackOf(face), canvas.width / dpr, canvas.height / dpr);
    } else {
      for (const stroke of strokes.current) drawStroke(ctx, stroke);
    }

    setInk(inkBounds(ctx, canvas.width, canvas.height));
  }, [face, mode, typed]);

  // Match the backing store to the real pixels on screen. The CSS gives the pad
  // its display size, so this only ever changes the resolution it is drawn at.
  useEffect(() => {
    const canvas = pad.current;
    if (!canvas) return;

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w < 1 || h < 1) return;
      if (canvas.width === w && canvas.height === h && ratio.current === dpr) return;
      canvas.width = w;
      canvas.height = h;
      ratio.current = dpr;
      paint();
    };

    fit();
    const watcher = new ResizeObserver(fit);
    watcher.observe(canvas);
    return () => watcher.disconnect();
  }, [paint]);

  useEffect(() => {
    paint();
  }, [paint]);

  // Keep the signature on the page it is being put on, whatever the size and
  // whichever page is in front.
  useEffect(() => {
    setX((at) => clamp(at, 0, pageW - width));
    setY((at) => clamp(at, 0, pageH - height));
  }, [height, pageH, pageW, width]);

  const spotOf = (event: React.PointerEvent<HTMLCanvasElement>): Dot => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      force: forceOf(event.pressure),
    };
  };

  const startStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== "draw") return;
    // Capture keeps the line going when the pointer leaves the pad mid-stroke.
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke: Stroke = [spotOf(event)];
    live.current = stroke;
    strokes.current = [...strokes.current, stroke];
    setStrokeCount(strokes.current.length);
  };

  const extendStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = live.current;
    const ctx = pad.current?.getContext("2d");
    if (!stroke || !ctx) return;
    stroke.push(spotOf(event));
    // Only the newest piece is drawn here. Repainting everything on every move
    // is what makes a pad feel laggy on a long signature.
    prime(ctx);
    drawPiece(ctx, stroke, stroke.length - 1);
  };

  const endStroke = () => {
    if (!live.current) return;
    live.current = null;
    paint();
  };

  const clearPad = () => {
    strokes.current = [];
    live.current = null;
    setStrokeCount(0);
    paint();
  };

  const undoStroke = () => {
    strokes.current = strokes.current.slice(0, -1);
    live.current = null;
    setStrokeCount(strokes.current.length);
    paint();
  };

  const resetSpot = () => {
    setX(clamp(Math.round(shape.width * 0.2), 0, pageW - width));
    setY(clamp(Math.round(shape.height * 0.75), 0, pageH - height));
  };

  /** The pad as a transparent PNG, cut down to the ink. */
  const cutPng = useCallback(async (): Promise<Uint8Array> => {
    const canvas = pad.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("The signature pad is not ready.");

    const box = inkBounds(ctx, canvas.width, canvas.height);
    if (!box) throw new Error("The signature pad is empty.");

    const cut = document.createElement("canvas");
    cut.width = box.w;
    cut.height = box.h;
    const out = cut.getContext("2d");
    if (!out) throw new Error("This browser would not open a second canvas.");
    out.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

    const blob = await new Promise<Blob | null>((done) => cut.toBlob(done, "image/png"));
    if (!blob) throw new Error("The signature would not come out as a PNG.");
    return new Uint8Array(await blob.arrayBuffer());
  }, []);

  const sign = () => {
    void session.apply(`Signed page ${current + 1}`, async (bytes) => {
      const [ops, image] = await Promise.all([
        import("../../lib/pdf/ops/stamp"),
        cutPng(),
      ]);
      return ops.stampImage(bytes, { pages: [current], image, x, y, width });
    });
  };

  return (
    <>
      <div className="inspector-body">
        <div className="panel-section">
          <span className="label">How to sign</span>
          <div className="pill-row" role="group" aria-label="How to sign">
            <button
              type="button"
              className={mode === "draw" ? "pill on" : "pill"}
              aria-pressed={mode === "draw"}
              onClick={() => setMode("draw")}
            >
              Draw it
            </button>
            <button
              type="button"
              className={mode === "type" ? "pill on" : "pill"}
              aria-pressed={mode === "type"}
              onClick={() => setMode("type")}
            >
              Type it instead
            </button>
          </div>
        </div>

        <div className="panel-section">
          <span className="label">Your signature</span>
          <div className={inked ? "sigpad inked" : "sigpad"}>
            <canvas
              ref={pad}
              aria-label={
                mode === "draw"
                  ? "Signature pad. Draw with a mouse, a finger or a pen."
                  : "Signature pad, showing your typed name."
              }
              onPointerDown={startStroke}
              onPointerMove={extendStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
            />
            <span className="prompt">Sign here</span>
          </div>
        </div>

        {mode === "draw" ? (
          <div className="panel-section">
            <div className="row">
              <button
                type="button"
                className="btn sm"
                onClick={undoStroke}
                disabled={strokeCount === 0}
                title={strokeCount === 0 ? "There are no strokes to take back yet." : undefined}
              >
                <IconUndo size={15} />
                Take back a stroke
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={clearPad}
                disabled={strokeCount === 0}
                title={strokeCount === 0 ? "The pad is already empty." : undefined}
              >
                <IconTrash size={15} />
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="panel-section">
            <div className="field">
              <label className="label" htmlFor="sig-name">
                Name to write
              </label>
              <input
                id="sig-name"
                className="input"
                type="text"
                value={typed}
                placeholder="Your name"
                autoComplete="name"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div className="pill-row" role="group" aria-label="Handwriting style">
              {FACES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={face === option.id ? "pill on" : "pill"}
                  aria-pressed={face === option.id}
                  onClick={() => setFace(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="panel-section">
          <span className="label">Where it goes</span>
          <div className="note">
            It lands on page <strong className="num">{current + 1}</strong>, the one on the
            bench right now. Turn to a different page in the strip to sign that one instead.
            The two numbers below are points from the top left corner, so a bigger Y is
            further down the page.
          </div>
        </div>

        <div className="panel-section">
          <div className={ready ? "selection" : "selection empty"}>
            <span>
              Page <b className="num">{current + 1}</b> of{" "}
              <span className="num">{doc.pageCount}</span>
            </span>
            <span>
              <b className="num">{width}</b> x <b className="num">{height}</b> pt
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="sig-width">
              How wide, in points
            </label>
            <input
              id="sig-width"
              className="range"
              type="range"
              min={40}
              max={400}
              step={4}
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </div>

          <div className="row">
            <div className="field">
              <label className="label" htmlFor="sig-x">
                X from the left
              </label>
              <input
                id="sig-x"
                className="input num"
                type="number"
                min={0}
                max={Math.max(0, pageW - width)}
                step={1}
                value={x}
                onChange={(event) =>
                  setX(clamp(Math.round(Number(event.target.value)), 0, pageW - width))
                }
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="sig-y">
                Y from the top
              </label>
              <input
                id="sig-y"
                className="input num"
                type="number"
                min={0}
                max={Math.max(0, pageH - height)}
                step={1}
                value={y}
                onChange={(event) =>
                  setY(clamp(Math.round(Number(event.target.value)), 0, pageH - height))
                }
              />
            </div>
          </div>
        </div>

        <div className="panel-section">
          <button type="button" className="btn ghost sm" onClick={resetSpot}>
            Put it back at the usual spot
          </button>
        </div>

        <div className="tradeoff">
          <b>This is a picture of your signature, not a certificate.</b> It gets drawn onto
          the page as an image, which is what almost every e-signature service does
          underneath, and it is accepted for most everyday paperwork. It is not a
          cryptographic digital signature: it does not prove who signed, and it will not
          show anyone whether the page was edited afterwards. Anyone can also copy the
          image off the page. If the document needs proof of who signed, you need a
          certificate-based signature from a tool built for that.
        </div>

        <div className="tradeoff">
          <b>The page size here is</b> <span className="num">{pageW}</span> x{" "}
          <span className="num">{pageH}</span> pt, measured the way you are looking at it.
          A turned page is already accounted for.
        </div>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={sign}
          disabled={!ready}
          title={
            ready
              ? undefined
              : mode === "draw"
                ? "Draw your signature on the pad first."
                : "Type a name first."
          }
        >
          <IconSign size={16} />
          Sign page {current + 1}
        </button>
      </div>
    </>
  );
}
