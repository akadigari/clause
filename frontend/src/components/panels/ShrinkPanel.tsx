/**
 * Shrink: the two honest ways to make a PDF smaller inside a browser tab.
 *
 * They are two buttons instead of one slider because they are not two points on
 * the same scale. Tidy repacks bookkeeping and changes nothing you can see.
 * Flatten throws the text away and keeps a picture of it. Putting both behind a
 * single "compress" button is how a tool ends up promising seventy percent off
 * with no loss, which is not something a browser can actually do.
 *
 * Every number shown here comes back from the operation itself, including the
 * runs that saved nothing.
 */

import { useEffect, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { CompressResult } from "../../lib/pdf/ops/compress";
import { bytes, delta, plural } from "../../lib/format";
import { IconCompress } from "../Icons";

/** Loaded on mount so the sliders can start on the values flatten would pick. */
type CompressModule = typeof import("../../lib/pdf/ops/compress");

/** What a finished run left behind. The bytes themselves went to the bench. */
type Outcome = Omit<CompressResult, "bytes">;

/**
 * Slider bounds for flatten. They match the range flatten clamps to, so the
 * dpi on screen is always the dpi that gets drawn.
 */
const DPI = { min: 36, max: 400, step: 4 } as const;
const QUALITY = { min: 0.2, max: 1, step: 0.05 } as const;

export default function ShrinkPanel({ doc, session }: PanelProps) {
  const [tools, setTools] = useState<CompressModule | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState<"tidy" | "flatten">("tidy");
  const [dpi, setDpi] = useState<number | null>(null);
  const [quality, setQuality] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The defaults live in the operation, not in a second copy here, so the
  // sliders have nothing to show until it arrives.
  useEffect(() => {
    let live = true;
    void import("../../lib/pdf/ops/compress").then(
      (mod) => {
        if (!live) return;
        setTools(mod);
        setDpi((v) => v ?? mod.FLATTEN_DEFAULTS.dpi);
        setQuality((v) => v ?? mod.FLATTEN_DEFAULTS.quality);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const defaults = tools?.FLATTEN_DEFAULTS ?? null;
  const dpiValue = dpi ?? defaults?.dpi ?? null;
  const qualityValue = quality ?? defaults?.quality ?? null;
  const estimate =
    tools && dpiValue !== null ? tools.estimateFlatten(doc.pageCount, dpiValue) : null;

  const working = session.busy !== null;
  const ready = tools !== null && dpiValue !== null && qualityValue !== null;
  const why = working
    ? "Wait for the job that is running to finish."
    : loadFailed
      ? "The shrink tools did not load. Reload the page."
      : !ready
        ? "The shrink tools are still loading."
        : undefined;

  // The size comparison describes what is sitting on the bench. After an undo
  // the bench holds something else and those numbers would be a lie, so the
  // block is matched against the file that is actually open.
  const showOutcome = outcome !== null && doc.bytes.length === outcome.after;
  const noSaving = outcome !== null && outcome.after >= outcome.before;

  function runTidy() {
    if (!tools) return;
    const { tidy } = tools;
    void session.apply(`Tidied the file, was ${bytes(doc.bytes.length)}`, async (input) => {
      const done = await tidy(input);
      setOutcome({
        before: done.before,
        after: done.after,
        method: done.method,
        warning: done.warning,
      });
      return done.bytes;
    });
  }

  function runFlatten() {
    if (!tools || dpiValue === null || qualityValue === null) return;
    const { flatten } = tools;
    const label = `Flattened ${doc.pageCount} ${plural(doc.pageCount, "page")} at ${dpiValue} dpi`;
    void session.apply(label, async (input, progress) => {
      const done = await flatten(input, {
        dpi: dpiValue,
        quality: qualityValue,
        onProgress: progress,
      });
      setOutcome({
        before: done.before,
        after: done.after,
        method: done.method,
        warning: done.warning,
      });
      return done.bytes;
    });
  }

  return (
    <>
      <div className="inspector-body">
        <div className="selection">
          <span>
            <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")} on the
            bench
          </span>
          <b className="num">{bytes(doc.bytes.length)}</b>
        </div>

        <div className="panel-section">
          <span className="label" id="shrink-how">
            How to shrink
          </span>
          <div className="pill-row" role="group" aria-labelledby="shrink-how">
            <button
              type="button"
              className={mode === "tidy" ? "pill on" : "pill"}
              aria-pressed={mode === "tidy"}
              onClick={() => setMode("tidy")}
            >
              Tidy
            </button>
            <button
              type="button"
              className={mode === "flatten" ? "pill on" : "pill"}
              aria-pressed={mode === "flatten"}
              onClick={() => setMode("flatten")}
            >
              Flatten
            </button>
          </div>
        </div>

        {mode === "tidy" && (
          <p className="note">
            Tidy repacks the file&rsquo;s internal bookkeeping and drops leftover objects that
            nothing points at anymore. Nothing you can see changes: same pages, same text, same
            pictures. It usually saves a little, and on a file that was already written well it
            saves nothing at all. If the tidied file comes out bigger, the original is kept and
            this panel says so.
          </p>
        )}

        {mode === "flatten" && dpiValue !== null && qualityValue !== null && (
          <>
            <div className="field">
              <label className="label" htmlFor="shrink-dpi">
                Detail: <span className="num">{dpiValue}</span> dpi
              </label>
              <input
                id="shrink-dpi"
                className="range"
                type="range"
                min={DPI.min}
                max={DPI.max}
                step={DPI.step}
                value={dpiValue}
                onChange={(e) => setDpi(Number(e.target.value))}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="shrink-quality">
                Picture quality: <span className="num">{Math.round(qualityValue * 100)}</span>%
              </label>
              <input
                id="shrink-quality"
                className="range"
                type="range"
                min={QUALITY.min}
                max={QUALITY.max}
                step={QUALITY.step}
                value={qualityValue}
                onChange={(e) => setQuality(Number(e.target.value))}
              />
            </div>

            {estimate && (
              <p className="note">
                Drawing <span className="num">{doc.pageCount}</span>{" "}
                {plural(doc.pageCount, "page")} at <span className="num">{dpiValue}</span> dpi is
                about <span className="num">{megapixels(estimate.pixels)}</span> megapixels, and
                the file that comes out should be roughly{" "}
                <span className="num">{bytes(estimate.roughBytes)}</span>. That is a ballpark from
                page size and dpi, not a promise.
              </p>
            )}

            {estimate?.slow && (
              <p className="note warn">
                This one will take a while. Every page has to be drawn, and at this size that is
                minutes rather than seconds. Leave the tab open while it runs, or pull the dpi down.
              </p>
            )}

            <div className="tradeoff">
              <b>Flattening turns every page into a photo of itself.</b> On a scan that is the only
              thing in this tab that makes a real dent in the size. On a document with real text it
              usually makes the file <b>BIGGER</b>, because the text was a few kilobytes of
              instructions and pictures of that text are not. Either way the text stops being
              selectable, searchable and copyable for good, and the Read tool will find nothing in
              the result. If the flattened file comes out larger, you get the original back and this
              panel says so instead of pretending it worked.
            </div>
          </>
        )}

        {loadFailed && (
          <p className="note cut">
            The shrink tools did not load. Reload the page and open this tool again. Your document
            stays where it is until you close the tab.
          </p>
        )}

        {outcome && showOutcome && (
          <div className="panel-section">
            <span className="label">
              {outcome.method === "tidy" ? "After tidying" : "After flattening"}
            </span>
            <div className="sizes">
              <span className="before num">{bytes(outcome.before)}</span>
              <span className="after num">{bytes(outcome.after)}</span>
              {delta(outcome.before, outcome.after) && (
                <span className={noSaving ? "change worse num" : "change num"}>
                  {delta(outcome.before, outcome.after)}
                </span>
              )}
            </div>
            {outcome.warning && <p className="note warn">{outcome.warning}</p>}
          </div>
        )}
      </div>

      <div className="inspector-foot">
        <button
          className="btn primary wide"
          onClick={mode === "tidy" ? runTidy : runFlatten}
          disabled={!ready || working}
          title={why}
        >
          <IconCompress size={16} />
          {mode === "tidy"
            ? "Tidy the file"
            : `Flatten ${doc.pageCount} ${plural(doc.pageCount, "page")} into pictures`}
        </button>
      </div>
    </>
  );
}

/** Pixels read as a number nobody can picture. Megapixels read as a size. */
function megapixels(pixels: number): string {
  const mp = pixels / 1_000_000;
  return mp < 10 ? mp.toFixed(1) : String(Math.round(mp));
}
