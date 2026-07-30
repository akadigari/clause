/**
 * The stage: one page, big, with crop marks around it.
 *
 * Three things sit stacked on top of each other, all the same size:
 *   1. the canvas pdf.js paints the page onto,
 *   2. an invisible text layer so text can be selected and a citation can be
 *      highlighted exactly where it appears,
 *   3. an overlay that catches drags, for drawing a redaction box or dropping
 *      a signature.
 *
 * Everything the overlay reports is converted straight into view space points,
 * so nothing downstream has to know about zoom or screen pixels.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { OpenDoc } from "../lib/session";
import {
  isCancelled,
  pageTextPieces,
  renderPage,
  type RenderHandle,
  type TextPiece,
} from "../lib/pdf/viewer";
import { rectFromDrag, screenToView, type Point, type Rect } from "../lib/pdf/geometry";
import { groupIntoLines, type TextLine } from "../lib/pdf/textblocks";
import { IconMinus, IconPlus } from "./Icons";

/**
 * Editing works a line at a time, not a paragraph at a time.
 *
 * Nothing in a PDF reflows, so there is no honest way to let someone retype a
 * wrapped bullet and have it re-wrap. A line is the largest piece that can be
 * replaced and still land exactly where the old words were.
 */
export type { TextLine };

/** Stable across repaints, since lines are recomputed on every render. */
export function lineKey(page: number, line: TextLine): string {
  return `${page}:${Math.round(line.x)}:${Math.round(line.y)}`;
}

export type StageMark = {
  id: string;
  page: number;
  rect: Rect;
  kind: "redact" | "stamp";
};

/** A block the user is currently retyping, held by App while it is open. */
export type OpenEdit = {
  page: number;
  /** Which line, so the right box stays highlighted across repaints. */
  key: string;
  rect: Rect;
  /** Where the old words sat, measured down from the top of rect. */
  baseline: number;
  original: string;
  text: string;
  fontSize: number;
  squeeze: number;
};

export type StageMode =
  | { kind: "read" }
  | { kind: "box"; hint: string; onBox: (page: number, rect: Rect) => void }
  | { kind: "point"; hint: string; onPoint: (page: number, point: Point) => void }
  | {
      kind: "edit";
      hint: string;
      /** The block being retyped, if any. */
      open: OpenEdit | null;
      /** Lines already changed, so they can be shown as done. */
      doneKeys: string[];
      onPick: (page: number, line: TextLine | null) => void;
      onType: (text: string) => void;
    };

type Props = {
  doc: OpenDoc;
  page: number;
  mode: StageMode;
  marks: StageMark[];
  /** Character range on this page to highlight, from a Clause citation. */
  cite: { page: number; start: number; end: number; nonce: number } | null;
  onRemoveMark?: (id: string) => void;
};

const ZOOM_STEPS = [0.25, 0.35, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

export default function Stage({ doc, page, mode, marks, cite, onRemoveMark }: Props) {
  const [zoom, setZoom] = useState(1);
  const [fitted, setFitted] = useState(false);
  const [pieces, setPieces] = useState<TextPiece[]>([]);
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);

  const stage = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  /** The render currently using the canvas, so the next one can wait for it. */
  const inflight = useRef<Promise<void> | null>(null);

  const shape = doc.pages[page] ?? { width: 612, height: 792, rotation: 0 };

  // Fit the first page to the window once, so a document opens at a size you
  // can actually read rather than at some arbitrary 100%.
  useLayoutEffect(() => {
    if (fitted || !stage.current) return;
    const room = stage.current.clientWidth - 96;
    if (room <= 0) return;
    const wanted = Math.min(1.6, Math.max(0.3, room / shape.width));
    setZoom(Math.round(wanted * 20) / 20);
    setFitted(true);
  }, [fitted, shape.width]);

  // Read the page's text.
  //
  // Deliberately separate from painting. Text extraction never touches the
  // canvas, so making it queue behind a render meant that any hiccup in
  // painting, and every cancelled render React starts and throws away in
  // development, left the page with no text layer, no selectable words and
  // nothing to click in the editor. It also does not depend on zoom, so
  // zooming no longer re-reads the whole page.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const proxy = await doc.pdf.getPage(page + 1);
        const got = await pageTextPieces(proxy);
        if (!cancelled) setPieces(got);
      } catch (err) {
        if (!isCancelled(err)) console.warn("[clause] could not read the page text", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  // Paint the page.
  useEffect(() => {
    let cancelled = false;
    let handle: RenderHandle | null = null;

    const run = (async () => {
      try {
        // pdf.js will not paint two things onto one canvas at the same time,
        // and the second render's promise then never settles, which used to
        // leave the text layer empty forever. React runs this effect twice on
        // mount in development on purpose, so waiting for whatever was already
        // drawing here is not an edge case, it is the normal path.
        const previous = inflight.current;
        if (previous) await previous.catch(() => undefined);
        if (cancelled) return;

        const proxy = await doc.pdf.getPage(page + 1);
        const target = canvas.current;
        if (cancelled || !target) return;
        handle = renderPage(proxy, target, zoom);
        await handle.done;
      } catch (err) {
        if (!isCancelled(err)) console.warn("[clause] page render failed", err);
      }
    })();
    inflight.current = run;

    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, page, zoom]);

  // Scroll a cited passage into view when Clause points at one.
  useEffect(() => {
    if (!cite || cite.page !== page) return;
    const hit = sheet.current?.querySelector<HTMLElement>(".textlayer span.cited");
    hit?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cite, page, pieces]);

  const viewPoint = useCallback(
    (event: React.PointerEvent): Point => {
      const box = sheet.current?.getBoundingClientRect();
      if (!box) return { x: 0, y: 0 };
      return screenToView(event.clientX, event.clientY, box, {
        width: shape.width,
        height: shape.height,
      });
    },
    [shape.height, shape.width],
  );

  const stepZoom = (direction: 1 | -1) => {
    const at = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + direction))];
    if (next) setZoom(next);
  };

  const interactive = mode.kind !== "read";
  const pageMarks = marks.filter((m) => m.page === page);

  // Only worked out in edit mode, and only when the text of the page has
  // actually changed, because grouping every run runs on each repaint
  // otherwise.
  const lines = useMemo(
    () => (mode.kind === "edit" ? groupIntoLines(pieces) : []),
    [mode.kind, pieces],
  );

  return (
    <section className="stage" ref={stage} aria-label="Page">
      <div
        className="sheet"
        ref={sheet}
        style={{ width: shape.width * zoom, height: shape.height * zoom }}
      >
        <span className="crop tl" />
        <span className="crop tr" />
        <span className="crop bl" />
        <span className="crop br" />

        <canvas ref={canvas} />

        <div
          className="textlayer"
          style={{
            opacity: mode.kind === "read" ? 0.999 : 0,
            pointerEvents: mode.kind === "read" ? "auto" : "none",
          }}
        >
          <TextLayer pieces={pieces} zoom={zoom} cite={cite?.page === page ? cite : null} />
        </div>

        {/* Marks already placed on this page. */}
        {pageMarks.map((mark) => (
          <button
            type="button"
            key={mark.id}
            className={`mark mark-${mark.kind}`}
            title="Click to remove"
            onClick={() => onRemoveMark?.(mark.id)}
            style={{
              left: mark.rect.x * zoom,
              top: mark.rect.y * zoom,
              width: mark.rect.width * zoom,
              height: mark.rect.height * zoom,
            }}
          />
        ))}

        {/* Edit mode: outline every block so it is obvious what can be
            changed, the way a person expects from an editor. */}
        {mode.kind === "edit" &&
          lines.map((line) => {
            const key = lineKey(page, line);
            const isOpen = mode.open?.key === key;
            const isDone = mode.doneKeys.includes(key);
            return (
              <button
                type="button"
                key={key}
                className={`textbox ${isOpen ? "on" : ""} ${isDone ? "done" : ""}`}
                style={{
                  left: line.x * zoom,
                  top: line.y * zoom,
                  width: line.width * zoom,
                  height: line.height * zoom,
                }}
                title={isDone ? "Changed. Click to edit again." : "Click to retype this line"}
                aria-label={`Edit line: ${line.text.slice(0, 60)}`}
                onClick={() => mode.onPick(page, line)}
              />
            );
          })}

        {/* The box being retyped sits exactly where the words were, at the
            same size, so what you type looks like what you will get. */}
        {mode.kind === "edit" && mode.open && mode.open.page === page && (
          <textarea
            className="textbox-input"
            autoFocus
            value={mode.open.text}
            onChange={(e) => mode.onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") mode.onPick(page, null);
              e.stopPropagation();
            }}
            style={{
              left: mode.open.rect.x * zoom,
              top: mode.open.rect.y * zoom,
              width: Math.max(mode.open.rect.width * zoom, 40),
              height: Math.max(mode.open.rect.height * zoom, mode.open.fontSize * zoom * 1.3),
              fontSize: mode.open.fontSize * zoom,
              lineHeight: 1.22,
            }}
            aria-label="Replacement text"
          />
        )}

        {/* The rectangle currently being dragged out. */}
        {drag && (
          <div
            className="mark mark-drawing"
            style={{
              left: Math.min(drag.from.x, drag.to.x) * zoom,
              top: Math.min(drag.from.y, drag.to.y) * zoom,
              width: Math.abs(drag.to.x - drag.from.x) * zoom,
              height: Math.abs(drag.to.y - drag.from.y) * zoom,
            }}
          />
        )}

        {/* Edit mode draws its own clickable boxes, so it must not sit under a
            full-page overlay that would swallow those clicks. Clicking bare
            paper closes whatever is open. */}
        {mode.kind === "edit" && (
          <div
            className="overlay"
            style={{ pointerEvents: "none" }}
            aria-hidden="true"
          />
        )}

        {interactive && mode.kind !== "edit" && (
          <div
            className="overlay grab"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const at = viewPoint(event);
              if (mode.kind === "point") {
                mode.onPoint(page, at);
                return;
              }
              setDrag({ from: at, to: at });
            }}
            onPointerMove={(event) => {
              if (!drag) return;
              setDrag({ from: drag.from, to: viewPoint(event) });
            }}
            onPointerUp={(event) => {
              if (!drag || mode.kind !== "box") return;
              const rect = rectFromDrag(drag.from, viewPoint(event));
              setDrag(null);
              // A stray click is not a box. Anything under a few points across
              // was almost certainly a misclick.
              if (rect.width > 4 && rect.height > 4) mode.onBox(page, rect);
            }}
            onPointerCancel={() => setDrag(null)}
          />
        )}
      </div>

      <div className="zoom-cluster">
        <button
          type="button"
          className="round"
          onClick={() => stepZoom(-1)}
          disabled={zoom <= (ZOOM_STEPS[0] ?? 0.25)}
          aria-label="Zoom out"
        >
          <IconMinus size={15} />
        </button>
        <span className="val">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="round"
          onClick={() => stepZoom(1)}
          disabled={zoom >= (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4)}
          aria-label="Zoom in"
        >
          <IconPlus size={15} />
        </button>
      </div>

      {interactive && <p className="stage-hint">{mode.hint}</p>}
    </section>
  );
}

/**
 * The text layer.
 *
 * pdf.js gives each run of text a position and a font size in points. Placing
 * a transparent span at exactly that spot, scaled to match, means the browser's
 * own text selection works over the rendered page, and a citation can be
 * highlighted where the words really are instead of in a side panel.
 */
function TextLayer({
  pieces,
  zoom,
  cite,
}: {
  pieces: TextPiece[];
  zoom: number;
  cite: { start: number; end: number } | null;
}) {
  // The engine cites character offsets into the page's text, and every run
  // already knows where it sits in that string. Re-deriving the offsets here
  // is what used to break this: a run with no text of its own still moves the
  // count along, and a walk over the rendered runs cannot see those.
  return (
    <>
      {pieces.map((piece, index) => {
        const inCitation =
          cite !== null &&
          piece.start < cite.end &&
          piece.end > cite.start &&
          piece.str.trim() !== "";

        return (
          <span
            key={index}
            className={inCitation ? "cited" : undefined}
            style={{
              left: piece.x * zoom,
              top: piece.y * zoom,
              fontSize: piece.fontSize * zoom,
              transform: piece.squeeze !== 1 ? `scaleX(${piece.squeeze})` : undefined,
            }}
          >
            {piece.str}
          </span>
        );
      })}
    </>
  );
}
