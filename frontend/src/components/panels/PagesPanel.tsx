/**
 * The Pages panel: turn, copy, remove, reorder, and pull pages out.
 *
 * Everything here except the pull out works on the pages picked in the strip,
 * so the panel is mostly a set of buttons over one number. The pull out is the
 * odd one: it writes a separate file and leaves the open document alone, so it
 * does not go through session.apply and does not land on the undo stack. There
 * is nothing to undo when the bench copy never changed.
 */

import { useState } from "react";

import type { PanelProps } from "../Inspector";
import { baseName, plural, ranges, safeName } from "../../lib/format";
import { savePdfBytes } from "../../lib/save";
import {
  IconCopy,
  IconDownload,
  IconPlus,
  IconRotateLeft,
  IconRotateRight,
  IconTrash,
} from "../Icons";

/**
 * A thrown value as a sentence. Operations raise an error carrying a hint, and
 * the hint is the half that says what to do about it, so it is worth keeping.
 * Read off the object rather than imported, because importing the error class
 * would pull the whole pdf layer in before anyone pressed a button.
 */
function reason(err: unknown): string {
  if (err instanceof Error) {
    const hint = (err as { hint?: string }).hint;
    return hint ? `${err.message} ${hint}` : err.message;
  }
  return String(err);
}

export default function PagesPanel({ doc, session, selected, onSelect, current }: PanelProps) {
  const [pulling, setPulling] = useState(false);

  const count = selected.length;
  const picked = count > 0;
  const busy = session.busy !== null || pulling;

  // One reason string per button, so a disabled button can always say why.
  const held = busy ? "Wait for the job that is running to finish." : undefined;
  const needPages = held ?? (picked ? undefined : "Pick pages in the strip first.");

  // Where a blank sheet would land, counted the way insertBlankPage reads it.
  const blankAt = Math.min(current + 1, doc.pageCount);

  function turn(degrees: number, direction: string) {
    const label = `Turned ${count} ${plural(count, "page")} ${direction}`;
    void session.apply(label, async (bytes) => {
      const { rotatePages } = await import("../../lib/pdf/ops/pages");
      return rotatePages(bytes, selected, degrees);
    });
  }

  function duplicate() {
    void session.apply(`Duplicated ${count} ${plural(count, "page")}`, async (bytes) => {
      const { duplicatePages } = await import("../../lib/pdf/ops/pages");
      return duplicatePages(bytes, selected);
    });
  }

  function remove() {
    void session.apply(`Deleted ${count} ${plural(count, "page")}`, async (bytes) => {
      const { deletePages } = await import("../../lib/pdf/ops/pages");
      return deletePages(bytes, selected);
    });
  }

  function addBlank() {
    void session.apply(`Added a blank page after page ${current + 1}`, async (bytes) => {
      const { insertBlankPage } = await import("../../lib/pdf/ops/pages");
      return insertBlankPage(bytes, blankAt);
    });
  }

  function reverse() {
    const order: number[] = [];
    for (let i = doc.pageCount - 1; i >= 0; i--) order.push(i);
    void session.apply(`Reversed the order of ${doc.pageCount} pages`, async (bytes) => {
      const { reorderPages } = await import("../../lib/pdf/ops/pages");
      return reorderPages(bytes, order);
    });
  }

  /** Write the picked pages to a second file. The open one is not touched. */
  async function pullOut() {
    if (!picked) return;
    const name = safeName(`${baseName(doc.name)}-pages-${ranges(selected)}.pdf`);
    setPulling(true);
    try {
      const { extractPages } = await import("../../lib/pdf/ops/pages");
      const out = await extractPages(doc.bytes, selected);
      const saved = await savePdfBytes(out, name);
      // A cancelled save dialog is not a failure, so it gets no toast.
      if (saved) session.say(`Saved ${name}`);
    } catch (err) {
      session.say(reason(err), "bad");
    } finally {
      setPulling(false);
    }
  }

  const everything = count === doc.pageCount;

  return (
    <>
      <div className="inspector-body">
        <div className={picked ? "selection" : "selection empty"}>
          {picked ? (
            <span>
              Picked <b className="num">{ranges(selected)}</b>, <span className="num">{count}</span>{" "}
              of <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")}
            </span>
          ) : (
            <span>
              <b>Nothing picked.</b> Click pages in the strip to work on them.
            </span>
          )}
          <button
            type="button"
            className="btn sm"
            onClick={() => onSelect(Array.from({ length: doc.pageCount }, (_, i) => i))}
            disabled={everything}
            title={everything ? "Every page is picked already." : undefined}
          >
            Select all
          </button>
        </div>

        <div className="panel-section">
          <span className="label">Turn</span>
          <div className="pill-row">
            <button
              type="button"
              className="btn sm"
              onClick={() => turn(-90, "left")}
              disabled={Boolean(needPages)}
              title={needPages}
            >
              <IconRotateLeft size={15} />
              Turn left
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => turn(90, "right")}
              disabled={Boolean(needPages)}
              title={needPages}
            >
              <IconRotateRight size={15} />
              Turn right
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => turn(180, "upside down")}
              disabled={Boolean(needPages)}
              title={needPages}
            >
              Turn 180
            </button>
          </div>
        </div>

        <div className="panel-section">
          <span className="label">Copy and remove</span>
          <div className="pill-row">
            <button
              type="button"
              className="btn sm"
              onClick={duplicate}
              disabled={Boolean(needPages)}
              title={needPages ?? "Each copy lands right after the page it came from."}
            >
              <IconCopy size={15} />
              Duplicate
            </button>
            <button
              type="button"
              className="btn danger sm"
              onClick={remove}
              disabled={Boolean(needPages)}
              title={needPages ?? "Undo brings them back."}
            >
              <IconTrash size={15} />
              Delete
            </button>
          </div>
        </div>

        <div className="panel-section">
          <span className="label">Add and reorder</span>
          <div className="pill-row">
            <button
              type="button"
              className="btn sm"
              onClick={addBlank}
              disabled={busy}
              title={held ?? "The blank sheet copies the size of the page next to it."}
            >
              <IconPlus size={15} />
              Blank page after <span className="num">{current + 1}</span>
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={reverse}
              disabled={busy || doc.pageCount < 2}
              title={
                held ??
                (doc.pageCount < 2 ? "There is only one page, so there is no order to flip." : undefined)
              }
            >
              Reverse the order
            </button>
          </div>
        </div>

        <p className="tradeoff">
          Turning keeps everything in the file. Deleting, duplicating and reordering rebuild it, and
          a rebuild <b>drops bookmarks and page labels</b>. Text, images, form fields and the
          document details all come across.
        </p>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={() => void pullOut()}
          disabled={Boolean(needPages)}
          title={needPages ?? "Writes a second file. This one stays as it is."}
        >
          <IconDownload size={16} />
          Pull out <span className="num">{count}</span> {plural(count, "page")}
        </button>
      </div>
    </>
  );
}
