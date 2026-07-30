/**
 * Split: cut one document into several files.
 *
 * This is the one tool that does not go through `session.apply`. A split does
 * not change the document on the bench, it makes new files out of it, so there
 * is nothing to undo. The parts sit in this panel until they are saved, which
 * is also why they are thrown away the moment the document changes underneath
 * them.
 */

import { useEffect, useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { SplitPart } from "../../lib/pdf/ops/split";
import { IconDownload, IconScissors } from "../Icons";
import { baseName, bytes, parseRanges, plural, ranges } from "../../lib/format";
import { saveBlob, savePdfBytes } from "../../lib/save";

type Mode = "cuts" | "every" | "ranges";

export default function SplitPanel({ doc, session, cuts, onCutsChange }: PanelProps) {
  const [mode, setMode] = useState<Mode>("cuts");
  const [size, setSize] = useState("1");
  const [typed, setTyped] = useState("");
  const [parts, setParts] = useState<SplitPart[]>([]);
  const [step, setStep] = useState<{ done: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);

  // A part holds the bytes the document had when it was made, so any edit
  // leaves it out of date. Offering a download of pages that have since been
  // deleted is worse than making someone split again.
  useEffect(() => {
    setParts([]);
  }, [doc.version]);

  /**
   * The cuts that will actually produce a part. A cut after the last page has
   * nothing behind it, and a cut left over from before pages were deleted can
   * sit past the end, so both are dropped here for the same reason splitAt
   * drops them: the count on the button has to be the count you get.
   */
  const liveCuts = useMemo(
    () =>
      [...new Set(cuts)]
        .filter((cut) => Number.isInteger(cut) && cut >= 0 && cut < doc.pageCount - 1)
        .sort((a, b) => a - b),
    [cuts, doc.pageCount],
  );

  const everyN = Number.parseInt(size, 10);
  const everyOk = Number.isInteger(everyN) && everyN >= 1;

  /**
   * One part per group the person typed, so "1-3, 7" is two files and not one
   * file with four pages in it. parseRanges folds everything it is given into a
   * single sorted list, which is right for a selection and wrong here, so each
   * comma separated piece is parsed on its own.
   */
  const groups = useMemo(() => {
    const out: number[][] = [];
    for (const piece of typed.split(/[,;]/)) {
      if (!piece.trim()) continue;
      const pages = parseRanges(piece, doc.pageCount);
      if (pages.length > 0) out.push(pages);
    }
    return out;
  }, [typed, doc.pageCount]);

  const pieces = typed.split(/[,;]/).filter((piece) => piece.trim().length > 0).length;
  const dropped = pieces - groups.length;

  const partCount =
    mode === "cuts"
      ? liveCuts.length + 1
      : mode === "every"
        ? everyOk
          ? Math.ceil(doc.pageCount / everyN)
          : 0
        : groups.length;

  const blocked = running
    ? "This split is still running."
    : session.busy
      ? "Wait for the job on the bench to finish."
      : mode === "cuts" && liveCuts.length === 0
        ? "Place a cut first: click the line between two pages in the strip."
        : mode === "every" && !everyOk
          ? "Type a whole number of pages, one or more."
          : mode === "ranges" && groups.length === 0
            ? "Type which pages go in each part, like 1-3, 7, 9-12."
            : null;

  async function run() {
    setRunning(true);
    setStep({ done: 0, total: partCount });
    setParts([]);
    try {
      const { splitAt, splitEvery, splitByRanges } = await import("../../lib/pdf/ops/split");
      const base = baseName(doc.name);
      const watch = (done: number, total: number) => setStep({ done, total });

      const made =
        mode === "cuts"
          ? await splitAt(doc.bytes, liveCuts, base, watch)
          : mode === "every"
            ? await splitEvery(doc.bytes, everyN, base, watch)
            : await splitByRanges(doc.bytes, groups, base, watch);

      setParts(made);
      session.say(`Split into ${made.length} ${plural(made.length, "file")}`);
    } catch (err) {
      session.say(why(err), "bad");
    } finally {
      setRunning(false);
      setStep(null);
    }
  }

  async function savePart(part: SplitPart) {
    try {
      const saved = await savePdfBytes(part.bytes, part.name);
      if (saved) session.say(`Saved ${part.name}`);
    } catch (err) {
      session.say(why(err), "bad");
    }
  }

  async function saveZip() {
    try {
      const { zipFiles } = await import("../../lib/pdf/ops/convert");
      const blob = await zipFiles(parts.map((part) => ({ name: part.name, data: part.bytes })));
      const saved = await saveBlob(blob, `${baseName(doc.name)}-parts.zip`);
      if (saved) session.say(`Saved ${parts.length} ${plural(parts.length, "part")} in one zip`);
    } catch (err) {
      session.say(why(err), "bad");
    }
  }

  return (
    <>
      <div className="inspector-body">
        <div className="panel-section">
          <span className="label" id="split-how">
            Where to cut
          </span>
          <div className="pill-row" role="group" aria-labelledby="split-how">
            <button
              type="button"
              className={mode === "cuts" ? "pill on" : "pill"}
              aria-pressed={mode === "cuts"}
              onClick={() => setMode("cuts")}
            >
              At the cut marks
            </button>
            <button
              type="button"
              className={mode === "every" ? "pill on" : "pill"}
              aria-pressed={mode === "every"}
              onClick={() => setMode("every")}
            >
              Every few pages
            </button>
            <button
              type="button"
              className={mode === "ranges" ? "pill on" : "pill"}
              aria-pressed={mode === "ranges"}
              onClick={() => setMode("ranges")}
            >
              By page ranges
            </button>
          </div>
        </div>

        {mode === "cuts" && (
          <div className="panel-section">
            {liveCuts.length > 0 ? (
              <>
                <div className="selection">
                  <span>Cut after {plural(liveCuts.length, "page")}</span>
                  <b className="num">{ranges(liveCuts)}</b>
                </div>
                <p className="note">
                  That makes <span className="num">{partCount}</span>{" "}
                  {plural(partCount, "file")}, in the order the pages are in now.
                </p>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => onCutsChange([])}
                  disabled={running}
                  title={running ? "This split is still running." : undefined}
                >
                  Clear the cuts
                </button>
              </>
            ) : (
              <>
                <div className="selection empty">
                  <span>No cuts yet</span>
                  <b className="num">0</b>
                </div>
                <p className="note">
                  Click the line between two pages in the strip to place a cut. Each cut
                  starts a new file, so <span className="num">2</span> cuts give you{" "}
                  <span className="num">3</span> of them.
                </p>
              </>
            )}
          </div>
        )}

        {mode === "every" && (
          <div className="panel-section">
            <div className="field">
              <label className="label" htmlFor="split-size">
                Pages in each part
              </label>
              <input
                id="split-size"
                className="input num"
                type="number"
                min={1}
                max={doc.pageCount}
                step={1}
                value={size}
                onChange={(e) => setSize(e.target.value)}
              />
            </div>
            {everyOk ? (
              <p className="note">
                <span className="num">{doc.pageCount}</span> pages cut into{" "}
                <span className="num">{partCount}</span> {plural(partCount, "file")}.
                {doc.pageCount % everyN !== 0 && (
                  <>
                    {" "}
                    The last one gets <span className="num">{doc.pageCount % everyN}</span>{" "}
                    {plural(doc.pageCount % everyN, "page")}.
                  </>
                )}
              </p>
            ) : (
              <p className="note cut">
                A part needs a whole number of pages, one or more. This document has{" "}
                <span className="num">{doc.pageCount}</span>.
              </p>
            )}
          </div>
        )}

        {mode === "ranges" && (
          <div className="panel-section">
            <div className="field">
              <label className="label" htmlFor="split-ranges">
                Pages in each part
              </label>
              <textarea
                id="split-ranges"
                className="input"
                rows={3}
                placeholder="1-3, 7, 9-12"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>

            {groups.length > 0 ? (
              <p className="note">
                Read as <span className="num">{groups.length}</span>{" "}
                {plural(groups.length, "part")}:{" "}
                {groups.map((group, i) => (
                  <span key={`${i}-${group[0] ?? 0}`}>
                    {i > 0 ? ", " : ""}
                    <span className="num">{ranges(group)}</span>
                  </span>
                ))}
                . Pages may appear in more than one part.
              </p>
            ) : typed.trim() ? (
              <p className="note cut">
                None of that points at a page in this document. It has{" "}
                <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")},
                numbered <span className="num">1</span> to{" "}
                <span className="num">{doc.pageCount}</span>.
              </p>
            ) : (
              <p className="note">
                One part per group, separated by commas. Typing 1-3, 7, 9-12 gives you{" "}
                <span className="num">3</span> files.
              </p>
            )}

            {dropped > 0 && groups.length > 0 && (
              <p className="note cut">
                <span className="num">{dropped}</span> of what you typed is outside this
                document and was left out. Highest page here is{" "}
                <span className="num">{doc.pageCount}</span>.
              </p>
            )}
          </div>
        )}

        {parts.length > 0 && (
          <div className="panel-section">
            <span className="label">
              <span className="num">{parts.length}</span> {plural(parts.length, "part")}, ready
              to save
            </span>
            <div className="results">
              {parts.map((part) => (
                <div className="result" key={part.name}>
                  <span className="rname" title={`Pages ${ranges(part.pages)}`}>
                    {part.name}
                  </span>
                  <span className="rsize num">{bytes(part.bytes.length)}</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void savePart(part)}
                    aria-label={`Save ${part.name}`}
                  >
                    <IconDownload size={14} />
                    Save
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="inspector-foot">
        {parts.length > 1 && (
          <button type="button" className="btn wide" onClick={() => void saveZip()}>
            <IconDownload size={15} />
            Download all <span className="num">{parts.length}</span> as a zip
          </button>
        )}
        <button
          type="button"
          className="btn primary wide"
          onClick={() => void run()}
          disabled={blocked !== null}
          title={blocked ?? undefined}
        >
          {running ? (
            step ? (
              <>
                Writing part <span className="num">{Math.min(step.done + 1, step.total)}</span> of{" "}
                <span className="num">{step.total}</span>
              </>
            ) : (
              "Working"
            )
          ) : blocked ? (
            "Split"
          ) : (
            <>
              <IconScissors size={15} />
              Split into <span className="num">{partCount}</span> {plural(partCount, "file")}
            </>
          )}
        </button>
      </div>
    </>
  );
}

/**
 * What to tell someone when a split fails.
 *
 * The ops throw PdfOpError, which already carries a sentence and a hint. This
 * reads them off the shape rather than importing the class, so the pdf code
 * stays out of the bundle until a split is actually run.
 */
function why(err: unknown): string {
  if (err && typeof err === "object") {
    const problem = err as { message?: unknown; hint?: unknown };
    const head = typeof problem.message === "string" && problem.message ? problem.message : "";
    const tail = typeof problem.hint === "string" && problem.hint ? problem.hint : "";
    if (head) return tail ? `${head} ${tail}` : head;
  }
  return "The split did not finish. Try again, or cut the document into fewer parts at once.";
}
