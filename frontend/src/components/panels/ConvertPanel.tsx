/**
 * The Convert panel: pages out as pictures, pictures in as pages, words out as
 * text.
 *
 * Two of the three make a new file and leave the open document alone, so they
 * run their operation directly and save the result. There is nothing to undo
 * when the bench copy never changed, which is why only the images-to-PDF path
 * goes through session.apply. That one really does replace what is on the
 * bench, so it lands on the undo stack and can be edited straight after.
 */

import { useEffect, useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import type { ImageOut } from "../../lib/pdf/ops/convert";
import { baseName, bytes, parseRanges, plural, ranges, safeName } from "../../lib/format";
import { saveBlob, saveText } from "../../lib/save";
import { IconClose, IconCopy, IconDownload } from "../Icons";

type Mode = "toimages" | "topdf" | "totext";

/** Past this many pages a render is slow enough to be worth warning about. */
const MANY_PAGES = 120;

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

export default function ConvertPanel({ doc, session, selected }: PanelProps) {
  const [mode, setMode] = useState<Mode>("toimages");

  // Pages out as pictures.
  const [kind, setKind] = useState<"image/png" | "image/jpeg">("image/png");
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(82);
  // null means follow the strip. A typed range takes over from there.
  const [typedRange, setTypedRange] = useState<string | null>(null);
  const [shots, setShots] = useState<ImageOut[]>([]);

  // Pictures in as pages.
  const [images, setImages] = useState<File[]>([]);
  const [pageSize, setPageSize] = useState<"auto" | "a4" | "letter">("auto");
  const [margin, setMargin] = useState(36);

  // Words out as text.
  const [text, setText] = useState("");

  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<{ done: number; total: number } | null>(null);

  const busy = session.busy !== null || running;
  const held = busy ? "Wait for the job that is running to finish." : undefined;

  // Results belong to the file as it was. Once the document changes underneath
  // them they are describing something that is no longer on the bench.
  useEffect(() => {
    setShots([]);
    setText("");
  }, [doc.version]);

  const everyPage = useMemo(
    () => Array.from({ length: doc.pageCount }, (_, i) => i),
    [doc.pageCount],
  );

  const pages = useMemo(() => {
    if (typedRange === null) return selected.length > 0 ? selected : everyPage;
    return parseRanges(typedRange, doc.pageCount);
  }, [typedRange, selected, everyPage, doc.pageCount]);

  const rangeShown =
    typedRange ?? (selected.length > 0 ? ranges(selected) : "all");

  // What the first chosen page will come out at, so the dial means something
  // before anyone commits to a render.
  const firstIndex = pages[0];
  const firstShape = firstIndex === undefined ? undefined : doc.pages[firstIndex];
  const guess = firstShape
    ? {
        width: Math.max(1, Math.floor((firstShape.width * dpi) / 72)),
        height: Math.max(1, Math.floor((firstShape.height * dpi) / 72)),
      }
    : null;

  const firstShot = shots[0];
  const shotWeight = shots.reduce((sum, shot) => sum + shot.blob.size, 0);
  const imageWeight = images.reduce((sum, file) => sum + file.size, 0);

  /* -- pages out as pictures ---------------------------------------------- */

  async function renderImages() {
    setRunning(true);
    setShots([]);
    setStep({ done: 0, total: pages.length });
    try {
      const { pagesToImages } = await import("../../lib/pdf/ops/convert");
      const out = await pagesToImages(doc.bytes, {
        pages,
        dpi,
        type: kind,
        quality: quality / 100,
        baseName: baseName(doc.name),
        onProgress: (done, total) => setStep({ done, total }),
      });
      setShots(out);
      session.say(`Rendered ${out.length} ${plural(out.length, "page")} at ${dpi} DPI`);
    } catch (err) {
      session.say(reason(err), "bad");
    } finally {
      setRunning(false);
      setStep(null);
    }
  }

  async function saveOne(shot: ImageOut) {
    try {
      const saved = await saveBlob(shot.blob, shot.name);
      // A cancelled save dialog is not a failure, so it gets no toast.
      if (saved) session.say(`Saved ${shot.name}`);
    } catch (err) {
      session.say(reason(err), "bad");
    }
  }

  async function saveZip() {
    const name = safeName(`${baseName(doc.name)}-images.zip`);
    setRunning(true);
    try {
      const { zipFiles } = await import("../../lib/pdf/ops/convert");
      const packed: Array<{ name: string; data: Uint8Array }> = [];
      for (const shot of shots) {
        packed.push({ name: shot.name, data: new Uint8Array(await shot.blob.arrayBuffer()) });
      }
      const archive = await zipFiles(packed);
      const saved = await saveBlob(archive, name);
      if (saved) session.say(`Saved ${shots.length} ${plural(shots.length, "image")} as ${name}`);
    } catch (err) {
      session.say(reason(err), "bad");
    } finally {
      setRunning(false);
    }
  }

  /* -- pictures in as pages ------------------------------------------------ */

  function addImages(list: FileList | null) {
    if (!list || list.length === 0) return;
    setImages((current) => [...current, ...Array.from(list)]);
  }

  function makePdf() {
    const count = images.length;
    void session.apply(
      `Built a PDF from ${count} ${plural(count, "image")}`,
      async (_bytes, progress) => {
        const { imagesToPdf } = await import("../../lib/pdf/ops/convert");
        const loaded: Array<{ name: string; bytes: Uint8Array }> = [];
        for (const file of images) {
          loaded.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        return imagesToPdf(loaded, { pageSize, margin, onProgress: progress });
      },
    );
  }

  /* -- words out as text ---------------------------------------------------- */

  async function readText() {
    setRunning(true);
    setText("");
    setStep({ done: 0, total: doc.pageCount });
    try {
      const { pdfToText } = await import("../../lib/pdf/ops/convert");
      const out = await pdfToText(doc.bytes, {
        onProgress: (done, total) => setStep({ done, total }),
      });
      setText(out);
      session.say(`Read ${doc.pageCount} ${plural(doc.pageCount, "page")}`);
    } catch (err) {
      session.say(reason(err), "bad");
    } finally {
      setRunning(false);
      setStep(null);
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      session.say("Copied the text");
    } catch {
      session.say(
        "The browser blocked the clipboard. Click in the box, select all, and copy with the keyboard.",
        "bad",
      );
    }
  }

  async function keepText() {
    const name = safeName(`${baseName(doc.name)}.txt`);
    try {
      const saved = await saveText(text, name);
      if (saved) session.say(`Saved ${name}`);
    } catch (err) {
      session.say(reason(err), "bad");
    }
  }

  /* -- why the main button might be off ------------------------------------ */

  const needPages =
    held ?? (pages.length > 0 ? undefined : "Type some page numbers first, like 1-3, 7.");
  const needImages =
    held ?? (images.length > 0 ? undefined : "Choose some PNG or JPEG files first.");

  return (
    <>
      <div className="inspector-body">
        <div className="panel-section">
          <div className="pill-row" role="group" aria-label="What to convert">
            <button
              type="button"
              className={mode === "toimages" ? "pill on" : "pill"}
              aria-pressed={mode === "toimages"}
              onClick={() => setMode("toimages")}
            >
              Pages to images
            </button>
            <button
              type="button"
              className={mode === "topdf" ? "pill on" : "pill"}
              aria-pressed={mode === "topdf"}
              onClick={() => setMode("topdf")}
            >
              Images to a PDF
            </button>
            <button
              type="button"
              className={mode === "totext" ? "pill on" : "pill"}
              aria-pressed={mode === "totext"}
              onClick={() => setMode("totext")}
            >
              Pages to text
            </button>
          </div>
        </div>

        {mode === "toimages" && (
          <>
            <div className={pages.length > 0 ? "selection" : "selection empty"}>
              {pages.length > 0 ? (
                <span>
                  Rendering <b className="num">{ranges(pages)}</b>,{" "}
                  <span className="num">{pages.length}</span> of{" "}
                  <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")}
                </span>
              ) : (
                <span>
                  <b>No pages picked.</b> Type a range below, like 1-3, 7.
                </span>
              )}
              {typedRange !== null && (
                <button type="button" className="btn sm" onClick={() => setTypedRange(null)}>
                  Follow the strip
                </button>
              )}
            </div>

            <div className="panel-section">
              <span className="label">File type</span>
              <div className="pill-row">
                <button
                  type="button"
                  className={kind === "image/png" ? "pill on" : "pill"}
                  aria-pressed={kind === "image/png"}
                  onClick={() => setKind("image/png")}
                  title="Sharp edges and text stay crisp. Bigger files."
                >
                  PNG
                </button>
                <button
                  type="button"
                  className={kind === "image/jpeg" ? "pill on" : "pill"}
                  aria-pressed={kind === "image/jpeg"}
                  onClick={() => setKind("image/jpeg")}
                  title="Much smaller on photos and scans. Text edges get fuzzy."
                >
                  JPEG
                </button>
              </div>
            </div>

            <div className="field">
              <label className="label" htmlFor="convert-dpi">
                Dots per inch <span className="num">{dpi}</span>
              </label>
              <input
                id="convert-dpi"
                className="range"
                type="range"
                min={36}
                max={600}
                step={6}
                value={dpi}
                onChange={(e) => setDpi(Number(e.target.value))}
              />
              {guess && (
                <p className="note">
                  Page <span className="num">{(firstIndex ?? 0) + 1}</span> comes out{" "}
                  <span className="num">{guess.width}</span> by{" "}
                  <span className="num">{guess.height}</span> pixels.{" "}
                  <span className="num">150</span> reads well on screen,{" "}
                  <span className="num">300</span> matches a scanner.
                </p>
              )}
            </div>

            {kind === "image/jpeg" && (
              <div className="field">
                <label className="label" htmlFor="convert-quality">
                  JPEG quality <span className="num">{quality}</span>
                </label>
                <input
                  id="convert-quality"
                  className="range"
                  type="range"
                  min={30}
                  max={100}
                  step={1}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </div>
            )}

            <div className="field">
              <label className="label" htmlFor="convert-range">
                Pages
              </label>
              <input
                id="convert-range"
                className="input num"
                type="text"
                value={rangeShown}
                onChange={(e) => setTypedRange(e.target.value)}
                placeholder="1-3, 7, 9-"
              />
            </div>

            {pages.length > MANY_PAGES && (
              <p className="note warn">
                <strong>
                  <span className="num">{pages.length}</span> pages is a long render.
                </strong>{" "}
                Every image is held in the tab until you save it, so this one is worth doing in
                batches on an older machine.
              </p>
            )}

            {shots.length > 0 && (
              <div className="panel-section">
                <span className="label">
                  <span className="num">{shots.length}</span> {plural(shots.length, "file")},{" "}
                  <span className="num">{bytes(shotWeight)}</span>
                  {firstShot && (
                    <>
                      {", first one "}
                      <span className="num">{firstShot.width}</span> by{" "}
                      <span className="num">{firstShot.height}</span> pixels
                    </>
                  )}
                </span>
                <div className="results">
                  {shots.map((shot) => (
                    <div className="result" key={shot.name}>
                      <span className="rname">{shot.name}</span>
                      <span className="rsize num">{bytes(shot.blob.size)}</span>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => void saveOne(shot)}
                        aria-label={`Download ${shot.name}`}
                      >
                        <IconDownload size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn wide"
                  onClick={() => void saveZip()}
                  disabled={busy}
                  title={held}
                >
                  <IconDownload size={15} />
                  Download all as a zip
                </button>
              </div>
            )}

            <p className="tradeoff">
              Images are <b>separate files</b>, so the PDF on the bench is left exactly as it is.
              Nothing here lands on the undo stack.
            </p>
          </>
        )}

        {mode === "topdf" && (
          <>
            <div className="field">
              <label className="label" htmlFor="convert-images">
                Pictures to turn into pages
              </label>
              <input
                id="convert-images"
                className="input"
                type="file"
                accept="image/png,image/jpeg"
                multiple
                onChange={(e) => {
                  addImages(e.target.files);
                  // Clearing lets the same file be picked twice in a row.
                  e.target.value = "";
                }}
              />
            </div>

            {images.length > 0 && (
              <div className="panel-section">
                <span className="label">
                  <span className="num">{images.length}</span> {plural(images.length, "image")},{" "}
                  <span className="num">{bytes(imageWeight)}</span>, in this order
                </span>
                {images.map((file, i) => (
                  <div className="file-row" key={`${file.name}-${i}`}>
                    <span className="fpages num">{i + 1}</span>
                    <span className="fname">{file.name}</span>
                    <span className="fpages num">{bytes(file.size)}</span>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => setImages(images.filter((_, n) => n !== i))}
                      aria-label={`Take ${file.name} out`}
                    >
                      <IconClose size={14} />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn sm" onClick={() => setImages([])}>
                  Clear the list
                </button>
              </div>
            )}

            <div className="row">
              <div className="field">
                <label className="label" htmlFor="convert-size">
                  Page size
                </label>
                <select
                  id="convert-size"
                  className="select"
                  value={pageSize}
                  onChange={(e) => setPageSize(e.target.value as "auto" | "a4" | "letter")}
                >
                  <option value="auto">Auto, one page per picture</option>
                  <option value="a4">A4</option>
                  <option value="letter">Letter</option>
                </select>
              </div>
              {pageSize !== "auto" && (
                <div className="field">
                  <label className="label" htmlFor="convert-margin">
                    Margin
                  </label>
                  <input
                    id="convert-margin"
                    className="input num"
                    type="number"
                    min={0}
                    max={200}
                    step={6}
                    value={margin}
                    onChange={(e) => setMargin(Number(e.target.value))}
                  />
                </div>
              )}
            </div>

            <p className="note">
              <strong>Auto</strong> gives every page the exact size of its own picture, so nothing
              is cropped and nothing is padded. That is the one to use for phone photos and
              screenshots. A4 and Letter put each picture on the same fixed sheet, centred, with its
              shape kept. Margins are in points, <span className="num">72</span> to the inch.
            </p>

            <p className="tradeoff">
              The new PDF <b>replaces what is on the bench</b>, so you can edit it straight away.
              Undo puts the old one back.
            </p>
          </>
        )}

        {mode === "totext" && (
          <>
            <p className="note">
              A scanned page holds a <strong>picture of the words</strong>, not the words, so
              nothing will come out of it. Getting text off a scan needs OCR, and this tool does not
              do OCR.
            </p>

            {text && (
              <div className="field">
                <label className="label" htmlFor="convert-text">
                  <span className="num">{text.length}</span> characters from{" "}
                  <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")}
                </label>
                <textarea
                  id="convert-text"
                  className="input"
                  readOnly
                  rows={14}
                  value={text}
                  spellCheck={false}
                />
                <div className="pill-row">
                  <button type="button" className="btn sm" onClick={() => void copyText()}>
                    <IconCopy size={14} />
                    Copy
                  </button>
                  <button type="button" className="btn sm" onClick={() => void keepText()}>
                    <IconDownload size={14} />
                    Save as a text file
                  </button>
                </div>
              </div>
            )}

            <p className="tradeoff">
              Text comes out in the order the page stores it, which is usually reading order but is
              not promised to be. Columns and tables can come out interleaved.
            </p>
          </>
        )}
      </div>

      <div className="inspector-foot">
        {step && step.total > 0 && (
          <p className="note">
            Page <span className="num">{step.done}</span> of{" "}
            <span className="num">{step.total}</span>
          </p>
        )}

        {mode === "toimages" && (
          <button
            type="button"
            className="btn primary wide"
            onClick={() => void renderImages()}
            disabled={Boolean(needPages)}
            title={needPages ?? "Writes separate image files. This PDF stays as it is."}
          >
            <IconDownload size={16} />
            Render <span className="num">{pages.length}</span> {plural(pages.length, "page")} as{" "}
            {kind === "image/jpeg" ? "JPEG" : "PNG"}
          </button>
        )}

        {mode === "topdf" && (
          <button
            type="button"
            className="btn primary wide"
            onClick={makePdf}
            disabled={Boolean(needImages)}
            title={needImages ?? "The result goes on the bench, ready to edit."}
          >
            Make a PDF from <span className="num">{images.length}</span>{" "}
            {plural(images.length, "image")}
          </button>
        )}

        {mode === "totext" && (
          <button
            type="button"
            className="btn primary wide"
            onClick={() => void readText()}
            disabled={busy}
            title={held ?? "Reads the text layer. Nothing leaves the tab."}
          >
            Read <span className="num">{doc.pageCount}</span> {plural(doc.pageCount, "page")} as
            text
          </button>
        )}
      </div>
    </>
  );
}
