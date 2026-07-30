/**
 * The page strip.
 *
 * This is the part of the bench people actually use. A PDF is an ordered stack
 * of pages, and every other tool renders that stack as a grid of thumbnails
 * you can only click. Here it is a strip you can physically work with: drag a
 * page to move it, and click the seam between two pages to cut there.
 *
 * The cut marks are the affordance. There is no "split" button hiding in a
 * menu, because in a real bindery you would put the scissors where the cut
 * goes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OpenDoc } from "../lib/session";
import { pageNo, ranges } from "../lib/format";
import { renderPage, isCancelled, type RenderHandle } from "../lib/pdf/viewer";
import { IconScissors } from "./Icons";

type Props = {
  doc: OpenDoc;
  selected: number[];
  onSelect: (indexes: number[]) => void;
  cuts: number[];
  onCutsChange: (cuts: number[]) => void;
  onReorder: (from: number, to: number) => void;
  current: number;
  onGoTo: (index: number) => void;
};

const THUMB_ZOOM = 0.28;

export default function Ribbon({
  doc,
  selected,
  onSelect,
  cuts,
  onCutsChange,
  onReorder,
  current,
  onGoTo,
}: Props) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const lastClicked = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const cutSet = useMemo(() => new Set(cuts), [cuts]);

  const click = useCallback(
    (index: number, event: React.MouseEvent) => {
      onGoTo(index);
      if (event.shiftKey && lastClicked.current !== null) {
        const lo = Math.min(lastClicked.current, index);
        const hi = Math.max(lastClicked.current, index);
        const span: number[] = [];
        for (let i = lo; i <= hi; i++) span.push(i);
        onSelect([...new Set([...selected, ...span])]);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        onSelect(
          selectedSet.has(index)
            ? selected.filter((i) => i !== index)
            : [...selected, index],
        );
        lastClicked.current = index;
        return;
      }
      onSelect([index]);
      lastClicked.current = index;
    },
    [onGoTo, onSelect, selected, selectedSet],
  );

  const toggleCut = useCallback(
    (afterIndex: number) => {
      onCutsChange(
        cutSet.has(afterIndex)
          ? cuts.filter((c) => c !== afterIndex)
          : [...cuts, afterIndex].sort((a, b) => a - b),
      );
    },
    [cuts, cutSet, onCutsChange],
  );

  // Keep the page you are looking at visible in the strip when it changes
  // from somewhere else, such as a citation jumping to page 14.
  useEffect(() => {
    const host = scroller.current;
    const chip = host?.querySelector<HTMLElement>(`[data-page="${current}"]`);
    if (!host || !chip) return;
    const top = chip.offsetTop;
    const bottom = top + chip.offsetHeight;
    if (top < host.scrollTop || bottom > host.scrollTop + host.clientHeight) {
      chip.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [current]);

  const allSelected = selected.length === doc.pageCount && doc.pageCount > 0;

  return (
    <aside className="ribbon" aria-label="Pages">
      <div className="ribbon-head">
        <span className="label">
          {selected.length > 0 ? ranges(selected) : `${doc.pageCount} pages`}
        </span>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() =>
            onSelect(
              allSelected ? [] : Array.from({ length: doc.pageCount }, (_, i) => i),
            )
          }
        >
          {allSelected ? "None" : "All"}
        </button>
      </div>

      <div className="ribbon-scroll" ref={scroller}>
        {doc.pages.map((shape, index) => (
          <div key={`${doc.version}-${index}`}>
            <div
              className={[
                "ribbon-item",
                selectedSet.has(index) ? "selected" : "",
                dragging === index ? "dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-page={index}
            >
              <button
                type="button"
                className="page-chip"
                draggable
                aria-pressed={selectedSet.has(index)}
                aria-label={`Page ${index + 1} of ${doc.pageCount}`}
                onClick={(event) => click(index, event)}
                onDragStart={(event) => {
                  setDragging(index);
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox will not start a drag without some payload.
                  event.dataTransfer.setData("text/plain", String(index));
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropAt(null);
                }}
              >
                <Thumb doc={doc} index={index} shape={shape} />
                <span className="page-no num">{pageNo(index, doc.pageCount)}</span>
                {shape.rotation % 360 !== 0 && (
                  <span className="page-turn num">{shape.rotation % 360}&deg;</span>
                )}
              </button>
            </div>

            {index < doc.pageCount - 1 && (
              <div
                className={[
                  "gap",
                  cutSet.has(index) ? "cut" : "",
                  dropAt === index ? "drop-target" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  setDropAt(index);
                }}
                onDragLeave={() => setDropAt((v) => (v === index ? null : v))}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragging === null) return;
                  // Dropping into the seam after page N means the page lands at
                  // position N+1, unless it came from above, in which case
                  // removing it first shifts everything down by one.
                  const target = dragging < index ? index : index + 1;
                  if (target !== dragging) onReorder(dragging, target);
                  setDragging(null);
                  setDropAt(null);
                }}
              >
                <button
                  type="button"
                  className="gap-line"
                  aria-label={
                    cutSet.has(index)
                      ? `Remove the cut after page ${index + 1}`
                      : `Cut after page ${index + 1}`
                  }
                  onClick={() => toggleCut(index)}
                />
                <span className="gap-hint">
                  {cutSet.has(index) ? (
                    <>
                      <IconScissors size={11} /> cut
                    </>
                  ) : (
                    "cut here"
                  )}
                </span>
              </div>
            )}
          </div>
        ))}

        {/* A landing strip so a page can be dragged to the very end. */}
        <div
          className={`gap ${dropAt === doc.pageCount ? "drop-target" : ""}`}
          style={{ height: 34 }}
          onDragOver={(event) => {
            if (dragging === null) return;
            event.preventDefault();
            setDropAt(doc.pageCount);
          }}
          onDragLeave={() => setDropAt((v) => (v === doc.pageCount ? null : v))}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging === null) return;
            onReorder(dragging, doc.pageCount - 1);
            setDragging(null);
            setDropAt(null);
          }}
        >
          <span className="gap-line" />
        </div>
      </div>
    </aside>
  );
}

/**
 * One thumbnail.
 *
 * Rendered only once it is near the viewport, because a 600 page document
 * would otherwise queue 600 renders on open and the first one would not paint
 * for a minute.
 */
function Thumb({
  doc,
  index,
  shape,
}: {
  doc: OpenDoc;
  index: number;
  shape: { width: number; height: number };
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node || near) return;
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          watcher.disconnect();
        }
      },
      { root: node.closest(".ribbon-scroll"), rootMargin: "320px 0px" },
    );
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let handle: RenderHandle | null = null;

    void (async () => {
      try {
        const page = await doc.pdf.getPage(index + 1);
        const target = canvas.current;
        if (cancelled || !target) return;
        handle = renderPage(page, target, THUMB_ZOOM, 1.5);
        await handle.done;
        if (!cancelled) setDrawn(true);
        // No page.cleanup(). The stage is showing this same page object, and
        // cleaning it up here wipes the text layer out from under it.
      } catch (err) {
        if (!isCancelled(err)) console.warn("[clause] thumbnail failed", err);
      }
    })();

    return () => {
      cancelled = true;
      handle?.cancel();
    };
  }, [doc, index, near]);

  return (
    <div ref={holder}>
      {!drawn && (
        <div
          className="pending"
          style={{ aspectRatio: `${shape.width} / ${shape.height}` }}
        />
      )}
      <canvas ref={canvas} style={drawn ? undefined : { display: "none" }} />
    </div>
  );
}
