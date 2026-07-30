/**
 * Marking a page: text, a watermark, or page numbers.
 *
 * All three draw with the fourteen fonts every PDF reader already carries, so
 * nothing gets embedded and the file barely grows. The price is that those
 * fonts only cover Western European characters, which is why this panel says
 * so up front instead of letting someone type Greek and find out at the end.
 *
 * There are seven anchors, not nine. Nothing pins to the middle of a side, so
 * those two cells in the grid sit there disabled rather than quietly missing,
 * which would read as a layout bug.
 */

import { useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { Anchor } from "../../lib/pdf/ops/stamp";
import { plural, ranges } from "../../lib/format";
import { IconStamp } from "../Icons";

type Mode = "text" | "watermark" | "numbers";

const MODES: ReadonlyArray<{ id: Mode; name: string }> = [
  { id: "text", name: "Text" },
  { id: "watermark", name: "Watermark" },
  { id: "numbers", name: "Page numbers" },
];

/** Reading order, so slicing this by threes gives the rows of the grid. */
const ANCHOR_CELLS: ReadonlyArray<{ anchor: Anchor | null; name: string }> = [
  { anchor: "top-left", name: "Top left" },
  { anchor: "top-center", name: "Top centre" },
  { anchor: "top-right", name: "Top right" },
  { anchor: null, name: "Middle left" },
  { anchor: "center", name: "Centre" },
  { anchor: null, name: "Middle right" },
  { anchor: "bottom-left", name: "Bottom left" },
  { anchor: "bottom-center", name: "Bottom centre" },
  { anchor: "bottom-right", name: "Bottom right" },
];

const NO_MIDDLE_SIDES =
  "A mark can sit at a corner, the middle of the top or bottom, or dead centre.";

function anchorName(anchor: Anchor): string {
  return ANCHOR_CELLS.find((cell) => cell.anchor === anchor)?.name ?? "Top left";
}

/**
 * The nine cell position picker.
 *
 * Position in the grid carries the meaning, so every cell also has its name on
 * the hover and in its label, and the chosen one is spelled out above.
 */
function AnchorGrid({
  caption,
  value,
  onChange,
}: {
  caption: string;
  value: Anchor;
  onChange: (next: Anchor) => void;
}) {
  const rows = [
    ANCHOR_CELLS.slice(0, 3),
    ANCHOR_CELLS.slice(3, 6),
    ANCHOR_CELLS.slice(6, 9),
  ];

  return (
    <div className="field" role="group" aria-label={caption}>
      <span className="label">
        {caption}: {anchorName(value)}
      </span>
      {rows.map((row, index) => (
        <div className="pill-row" key={index}>
          {row.map((cell) => {
            const chosen = cell.anchor !== null && cell.anchor === value;
            return (
              <button
                key={cell.name}
                type="button"
                className={chosen ? "pill on" : "pill"}
                aria-label={cell.anchor ? cell.name : `${cell.name}, not available`}
                aria-pressed={cell.anchor ? chosen : undefined}
                title={cell.anchor ? cell.name : NO_MIDDLE_SIDES}
                disabled={cell.anchor === null}
                onClick={() => {
                  if (cell.anchor) onChange(cell.anchor);
                }}
              >
                <span aria-hidden="true">•</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function StampPanel({ doc, session, selected }: PanelProps) {
  const [mode, setMode] = useState<Mode>("text");

  const [text, setText] = useState("");
  const [textSize, setTextSize] = useState("12");
  const [textColor, setTextColor] = useState("#000000");
  const [textOpacity, setTextOpacity] = useState(1);
  const [textAnchor, setTextAnchor] = useState<Anchor>("top-right");

  const [markText, setMarkText] = useState("DRAFT");
  const [markAngle, setMarkAngle] = useState(45);
  const [markOpacity, setMarkOpacity] = useState(0.12);
  const [markSize, setMarkSize] = useState("48");

  const [format, setFormat] = useState("{n}");
  const [start, setStart] = useState("1");
  const [numAnchor, setNumAnchor] = useState<Anchor>("bottom-center");
  const [numSize, setNumSize] = useState("10");

  // Nothing picked means the whole document, which is what people expect from
  // a watermark and from page numbers.
  const targets = useMemo(
    () =>
      selected.length > 0
        ? selected
        : Array.from({ length: doc.pageCount }, (_, i) => i),
    [selected, doc.pageCount],
  );

  const count = targets.length;
  const textSizeNum = Number(textSize);
  const markSizeNum = Number(markSize);
  const numSizeNum = Number(numSize);
  const startNum = Number(start);

  // What the first numbered page will read. "of {total}" counts the numbers
  // that actually get printed, so this is the honest example, not a guess.
  const preview = useMemo(() => {
    const first = Number.isFinite(startNum) ? startNum : 1;
    const highest = first + count - 1;
    return format
      .replace(/\{n\}/g, String(first))
      .replace(/\{total\}/g, String(highest));
  }, [format, startNum, count]);

  function stamp() {
    void session.apply(
      `Stamped text on ${count} ${plural(count, "page")}`,
      async (bytes) => {
        const { stampText } = await import("../../lib/pdf/ops/stamp");
        return stampText(bytes, {
          pages: targets,
          text,
          anchor: textAnchor,
          size: textSizeNum,
          color: textColor,
          opacity: textOpacity,
        });
      },
    );
  }

  function watermark() {
    void session.apply(
      `Added a watermark to ${count} ${plural(count, "page")}`,
      async (bytes) => {
        const { addWatermark } = await import("../../lib/pdf/ops/stamp");
        return addWatermark(bytes, {
          pages: targets,
          text: markText,
          size: markSizeNum,
          opacity: markOpacity,
          angle: markAngle,
        });
      },
    );
  }

  function number() {
    void session.apply(
      `Numbered ${count} ${plural(count, "page")}`,
      async (bytes) => {
        const { addPageNumbers } = await import("../../lib/pdf/ops/stamp");
        return addPageNumbers(bytes, {
          pages: targets,
          start: startNum,
          anchor: numAnchor,
          size: numSizeNum,
          format,
        });
      },
    );
  }

  let verb = "Stamp text on";
  let run = stamp;
  let stop = "";

  if (mode === "text") {
    if (text.trim() === "") stop = "Type the text you want on the page first.";
    else if (!(textSizeNum > 0)) stop = "Text size has to be bigger than zero.";
  } else if (mode === "watermark") {
    verb = "Add a watermark to";
    run = watermark;
    if (markText.trim() === "") stop = "Type the word you want across the page first.";
    else if (!(markSizeNum > 0)) stop = "Watermark size has to be bigger than zero.";
  } else {
    verb = "Number";
    run = number;
    if (format.trim() === "") stop = "Type a format, such as {n}.";
    else if (!Number.isFinite(startNum)) stop = "The starting number has to be a number.";
    else if (!(numSizeNum > 0)) stop = "Page number size has to be bigger than zero.";
  }

  if (count === 0) stop = "This document has no pages to mark.";

  return (
    <>
      <div className="inspector-body">
        <div className="pill-row" role="group" aria-label="What to add">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={mode === m.id ? "pill on" : "pill"}
              aria-pressed={mode === m.id}
              onClick={() => setMode(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>

        <div className={selected.length > 0 ? "selection" : "selection empty"}>
          <span>{selected.length > 0 ? "Marking picked pages" : "Marking every page"}</span>
          <b className="num">{ranges(targets)}</b>
        </div>

        {mode === "text" && (
          <>
            <label className="field">
              <span className="label">Text</span>
              <textarea
                className="input"
                rows={2}
                value={text}
                placeholder="Received 29 July 2026"
                onChange={(e) => setText(e.target.value)}
              />
            </label>

            <div className="row">
              <label className="field">
                <span className="label">Size in points</span>
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={400}
                  step={1}
                  value={textSize}
                  onChange={(e) => setTextSize(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">Colour</span>
                <input
                  className="input"
                  type="color"
                  value={textColor}
                  onChange={(e) => setTextColor(e.target.value)}
                />
              </label>
            </div>

            <label className="field">
              <span className="label">
                Opacity <span className="num">{Math.round(textOpacity * 100)}</span>%
              </span>
              <input
                className="range"
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={textOpacity}
                onChange={(e) => setTextOpacity(Number(e.target.value))}
              />
            </label>

            <AnchorGrid
              caption="Where it sits"
              value={textAnchor}
              onChange={setTextAnchor}
            />
          </>
        )}

        {mode === "watermark" && (
          <>
            <label className="field">
              <span className="label">Watermark</span>
              <input
                className="input"
                type="text"
                value={markText}
                placeholder="DRAFT"
                onChange={(e) => setMarkText(e.target.value)}
              />
            </label>

            <label className="field">
              <span className="label">
                Angle <span className="num">{markAngle}</span> degrees
              </span>
              <input
                className="range"
                type="range"
                min={-90}
                max={90}
                step={5}
                value={markAngle}
                onChange={(e) => setMarkAngle(Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span className="label">
                Opacity <span className="num">{Math.round(markOpacity * 100)}</span>%
              </span>
              <input
                className="range"
                type="range"
                min={0.02}
                max={1}
                step={0.02}
                value={markOpacity}
                onChange={(e) => setMarkOpacity(Number(e.target.value))}
              />
            </label>

            <label className="field">
              <span className="label">Size in points</span>
              <input
                className="input num"
                type="number"
                min={1}
                max={400}
                step={1}
                value={markSize}
                onChange={(e) => setMarkSize(e.target.value)}
              />
            </label>

            <p className="note warn">
              A watermark is <strong>painted into the page</strong>. It becomes part of the
              document, not a layer anyone can switch off later. Undo takes it back off
              while this tab is open. Text set too big is shrunk to fit the page.
            </p>
          </>
        )}

        {mode === "numbers" && (
          <>
            <div className="field">
              <label className="label" htmlFor="stamp-format">
                Format
              </label>
              <input
                id="stamp-format"
                className="input"
                type="text"
                value={format}
                placeholder="{n}"
                onChange={(e) => setFormat(e.target.value)}
              />
              <p className="note">
                <strong>{"{n}"}</strong> is the number on the page and{" "}
                <strong>{"{total}"}</strong> is the last number printed. So{" "}
                {'"Page {n} of {total}"'} gives{" "}
                <span className="num">{`Page 1 of ${count}`}</span>. Yours reads{" "}
                <span className="num">{preview || "nothing"}</span> on the first page.
              </p>
            </div>

            <div className="row">
              <label className="field">
                <span className="label">Start at</span>
                <input
                  className="input num"
                  type="number"
                  step={1}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">Size in points</span>
                <input
                  className="input num"
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={numSize}
                  onChange={(e) => setNumSize(e.target.value)}
                />
              </label>
            </div>

            <AnchorGrid
              caption="Where the number sits"
              value={numAnchor}
              onChange={setNumAnchor}
            />
          </>
        )}

        <p className="note">
          <strong>Western European characters only.</strong> These marks use the fonts every
          PDF reader already has, which keeps the file small. Accents like é and ü are fine.
          Chinese, Japanese, Korean, Arabic, Hebrew, Greek and Cyrillic get turned down with
          a message that names the character, rather than drawn as blank boxes.
        </p>
      </div>

      <div className="inspector-foot">
        <button
          type="button"
          className="btn primary wide"
          onClick={run}
          disabled={stop !== ""}
          title={stop || undefined}
        >
          <IconStamp />
          {verb}
          {selected.length > 0 ? " " : " all "}
          <span className="num">{count}</span>
          {selected.length > 0 ? " selected " : " "}
          {plural(count, "page")}
        </button>
      </div>
    </>
  );
}
