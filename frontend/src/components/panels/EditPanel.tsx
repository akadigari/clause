/**
 * Edit text: retype words that are already on the page.
 *
 * The honest description of what this does is in COVER_NOT_REMOVED, and it is
 * shown on this panel rather than buried in a comment: the old words are
 * painted over, not taken out, so they can still be found inside the file.
 * That is fine for fixing a date or a name and it is not a way to hide
 * anything. The Redact tool is the one that actually removes text.
 */

import { useCallback, useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { OpenEdit } from "../Stage";
import { COVER_NOT_REMOVED, type TextEdit } from "../../lib/pdf/ops/edit";
import { plural } from "../../lib/format";
import { IconCheck, IconClose } from "../Icons";

export type PendingEdit = OpenEdit & { color: string; background: string };

type Props = PanelProps & {
  open: OpenEdit | null;
  pending: PendingEdit[];
  style: { color: string; background: string; transparent: boolean };
  onStyle: (next: Props["style"]) => void;
  onSizeChange: (size: number) => void;
  onKeep: () => void;
  onDrop: (key: string) => void;
  onClearAll: () => void;
};

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

export default function EditPanel({
  session,
  open,
  pending,
  style,
  onStyle,
  onSizeChange,
  onKeep,
  onDrop,
  onClearAll,
}: Props) {
  const [busy, setBusy] = useState(false);

  const changed = useMemo(
    () => pending.filter((p) => p.text !== p.original),
    [pending],
  );

  const apply = useCallback(() => {
    if (changed.length === 0 || busy) return;
    setBusy(true);
    const edits: TextEdit[] = changed.map((p) => ({
      page: p.page,
      rect: p.rect,
      baseline: p.baseline,
      text: p.text,
      fontSize: p.fontSize,
      color: p.color,
      background: p.background,
      squeeze: p.squeeze,
    }));
    const count = changed.length;

    void session
      .apply(`Retyped ${count} ${plural(count, "line")}`, async (bytes, progress) => {
        const { replaceText } = await import("../../lib/pdf/ops/edit");
        const result = await replaceText(bytes, edits, progress);
        for (const warning of result.warnings) session.say(warning, "bad");
        return result.bytes;
      })
      .finally(() => {
        setBusy(false);
        onClearAll();
      });
  }, [busy, changed, onClearAll, session]);

  return (
    <>
      <div className="inspector-body">
        {open ? (
          <>
            <div className="panel-section">
              <span className="label">Was</span>
              <p className="note" style={{ fontStyle: "italic" }}>
                {open.original || "(blank)"}
              </p>
            </div>

            <div className="row">
              <div className="field">
                <span className="label">Size</span>
                <select
                  className="select"
                  value={nearest(open.fontSize)}
                  onChange={(e) => onSizeChange(Number(e.target.value))}
                  aria-label="Font size"
                >
                  {SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="label">Text colour</span>
                <input
                  type="color"
                  className="input"
                  value={style.color}
                  onChange={(e) => onStyle({ ...style, color: e.target.value })}
                  aria-label="Text colour"
                />
              </div>
            </div>

            <div className="field">
              <span className="label">Background behind it</span>
              <input
                type="color"
                className="input"
                value={style.background}
                disabled={style.transparent}
                onChange={(e) => onStyle({ ...style, background: e.target.value })}
                aria-label="Background colour"
                title={
                  style.transparent
                    ? "Turn off Match the paper to pick a colour"
                    : undefined
                }
              />
            </div>

            <label className="switch" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={style.transparent}
                onChange={(e) => onStyle({ ...style, transparent: e.target.checked })}
              />
              <span className="track" />
              Match the paper (white)
            </label>

            <p className="note">
              The patch is filled with this colour before the new words are
              drawn. On plain white paper the default is right. Over a
              coloured block or an image, pick the colour under the words or
              the correction sits in a white box.
            </p>

            <div className="pill-row" style={{ marginTop: 14 }}>
              <button type="button" className="btn primary sm" onClick={onKeep}>
                <IconCheck size={13} /> Keep this line
              </button>
            </div>
          </>
        ) : (
          <div className="panel-section">
            <div className="selection empty">
              <span>Editing</span>
              <b>nothing yet</b>
            </div>
            <p className="note">
              Every line of text on the page is outlined. Click one and retype
              it. Nothing changes in the file until you apply.
            </p>
          </div>
        )}

        {changed.length > 0 && (
          <div className="panel-section">
            <span className="label">
              Waiting to apply ({changed.length})
            </span>
            <div className="results">
              {changed.map((p) => (
                <div className="result" key={p.key}>
                  <span className="rname" title={`${p.original} -> ${p.text}`}>
                    {p.text || "(blank)"}
                  </span>
                  <span className="rsize num">p{p.page + 1}</span>
                  <button
                    type="button"
                    className="round"
                    onClick={() => onDrop(p.key)}
                    aria-label={`Undo the change to "${p.original.slice(0, 40)}"`}
                  >
                    <IconClose size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="tradeoff">
          <b>This covers the old words, it does not remove them.</b>{" "}
          {COVER_NOT_REMOVED.replace(
            "This paints over the old words and writes new ones on top. ",
            "",
          )}
        </div>

        <p className="note">
          The replacement is drawn in a built-in font, so on a document using an
          unusual typeface it will look close rather than identical. Nothing
          rewraps, so a much longer line gets shrunk to fit and you will be told
          when that happens.
        </p>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={apply}
          disabled={changed.length === 0 || busy}
          title={changed.length === 0 ? "Retype a line first" : undefined}
        >
          {changed.length === 0
            ? "Nothing to apply"
            : `Apply ${changed.length} ${plural(changed.length, "change")}`}
        </button>
      </div>
    </>
  );
}

/** The dropdown only has round sizes, so show the closest to the real one. */
function nearest(size: number): number {
  return SIZES.reduce((best, s) =>
    Math.abs(s - size) < Math.abs(best - size) ? s : best,
  );
}
