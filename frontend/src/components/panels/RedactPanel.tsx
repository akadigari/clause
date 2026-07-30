/**
 * The redaction panel.
 *
 * This is the one tool in the bench where a confident interface is dangerous.
 * A black rectangle drawn over a name looks finished and is not, and documents
 * redacted that way have been read straight out of the file by anyone who
 * thought to press ctrl A. So this panel does two things beyond collecting
 * boxes: it says out loud what the operation costs before it runs, and it gives
 * a way to check the result afterwards instead of asking the user to take it on
 * faith.
 *
 * The list of marked areas is deliberately one row per box drawn on the page,
 * including the ones set aside. Nothing the stage shows is missing from this
 * list, and nothing in this list is invisible on the stage, because a panel
 * that quietly disagrees with the page is how a box gets forgotten.
 */

import { useCallback, useMemo, useState } from "react";

import type { PanelProps } from "../Inspector";
import { PdfOpError } from "../../lib/pdf/ops/common";
// This panel is itself only loaded when the tool is picked, and nothing else
// uses the redaction module, so a plain import keeps it in this panel's chunk.
// redactionCost also has to rerun on every step of the DPI slider, so it needs
// to be here rather than behind an await.
import {
  DEFAULT_REDACT_DPI,
  normalizeRedactBox,
  redact,
  redactionCost,
  verifyRedaction,
  type RedactBox,
} from "../../lib/pdf/ops/redact";
import { bytes, pageNo, plural, ranges } from "../../lib/format";
import { IconSearch, IconSpinner } from "../Icons";

/** The op clamps to this range too. Below 72 a page stops being readable. */
const MIN_DPI = 72;
const MAX_DPI = 400;

type Marked = { id: string; box: RedactBox };

type Done = {
  /** Zero based indexes of the pages that came back as pictures. */
  pages: number[];
  dpi: number;
  textRemoved: boolean;
  /** Page text as it was before the redaction, needed for the check after. */
  before: string[];
};

type Verdict = { phrase: string; clean: boolean; found: string[] };

export default function RedactPanel({
  doc,
  session,
  marks,
  onClearMarks,
  current,
  onGoTo,
}: PanelProps) {
  const [dpi, setDpi] = useState(DEFAULT_REDACT_DPI);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Done | null>(null);
  const [phrase, setPhrase] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const drawn = useMemo<Marked[]>(
    () =>
      marks
        .filter((mark) => mark.kind === "redact")
        .map((mark) => ({
          id: mark.id,
          // A drag that went up and to the left has negative sides until this
          // folds it, and the sizes shown below have to match what runs.
          box: normalizeRedactBox({ page: mark.page, ...mark.rect }),
        })),
    [marks],
  );

  const groups = useMemo(() => {
    const byPage = new Map<number, Marked[]>();
    for (const item of drawn) {
      const list = byPage.get(item.box.page);
      if (list) list.push(item);
      else byPage.set(item.box.page, [item]);
    }
    return [...byPage.entries()].sort((a, b) => a[0] - b[0]);
  }, [drawn]);

  // A box with no size covers nothing on screen, so the op drops it. It stays
  // in the list, labelled, rather than counting towards work that will not
  // happen.
  const live = useMemo(
    () => drawn.filter((m) => !skipped.has(m.id) && m.box.width > 0 && m.box.height > 0),
    [drawn, skipped],
  );

  const pages = useMemo(
    () => [...new Set(live.map((m) => m.box.page))].sort((a, b) => a - b),
    [live],
  );

  const cost = redactionCost(pages.length, doc.pageCount, dpi);

  const toggle = useCallback((id: string) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function clearAll(): void {
    onClearMarks();
    setSkipped(new Set());
  }

  function run(): void {
    if (pages.length === 0) return;
    const boxes = live.map((m) => m.box);
    const count = pages.length;
    const wanted = dpi;

    void session.apply(
      `Removed the text from ${count} ${plural(count, "page")}`,
      async (source, progress) => {
        // Read the words out of the document while they are still there. Once
        // the pages are pictures there is no way to tell "this phrase is gone"
        // apart from "this phrase was never here", and those two answers mean
        // opposite things to somebody about to send the file.
        const { allPageText } = await import("../../lib/pdf/viewer");
        const before = await allPageText(doc.pdf);
        const result = await redact(source, { boxes, dpi: wanted, onProgress: progress });

        setDone({
          pages: result.pagesRasterized,
          dpi: wanted,
          textRemoved: result.textRemoved,
          before,
        });
        setVerdict(null);
        setPhrase("");
        // The boxes have been spent. Leaving them drawn would let the next
        // click black out a page that is already a picture.
        clearAll();
        return result.bytes;
      },
    );
  }

  async function check(): Promise<void> {
    const target = phrase.trim();
    if (!done || !target) return;
    setChecking(true);
    setVerdict(null);
    try {
      const result = await verifyRedaction(done.before, doc.bytes, [target]);
      setVerdict({ phrase: target, clean: result.clean, found: result.found });
    } catch (err) {
      if (err instanceof PdfOpError) {
        session.say(err.hint ? `${err.message} ${err.hint}` : err.message, "bad");
      } else {
        const detail = err instanceof Error ? err.message : String(err);
        session.say(`The check did not run, so nothing is proved. ${detail}`, "bad");
      }
    } finally {
      setChecking(false);
    }
  }

  const nothingMarked = drawn.length === 0;
  const ready = pages.length > 0;

  return (
    <>
      <div className="inspector-body">
        {nothingMarked ? (
          <div className="panel-section">
            <div className="selection empty">
              <span>Marked to remove</span>
              <b>nothing yet</b>
            </div>
            <p className="note">
              Drag across anything on the page that should be removed. A name, a
              number, a whole paragraph. Every box you draw shows up here before
              anything happens to the file.
            </p>
          </div>
        ) : (
          <>
            <div className={ready ? "selection" : "selection empty"}>
              <span>
                Pages <span className="num">{ranges(pages)}</span>
              </span>
              <b>
                <span className="num">{live.length}</span> {plural(live.length, "area")}
              </b>
            </div>

            {groups.map(([page, items]) => (
              <div className="panel-section" key={page}>
                <span className="label">
                  Page <span className="num">{pageNo(page, doc.pageCount)}</span>
                </span>
                <div className="results">
                  {items.map((item) => {
                    const wide = Math.round(item.box.width);
                    const tall = Math.round(item.box.height);
                    const sizeless = item.box.width <= 0 || item.box.height <= 0;
                    const off = skipped.has(item.id);
                    const where = `the ${wide} by ${tall} point area on page ${page + 1}`;
                    return (
                      <div className="result" key={item.id}>
                        <span className="rname">
                          Page <span className="num">{pageNo(page, doc.pageCount)}</span>
                          {", "}
                          <span className="num">{wide}</span> by{" "}
                          <span className="num">{tall}</span> pt
                        </span>
                        <span className="rsize">
                          {sizeless ? "no size" : off ? "set aside" : "goes"}
                        </span>
                        <button
                          className="btn sm ghost"
                          onClick={() => toggle(item.id)}
                          aria-label={off ? `Put back ${where}` : `Set aside ${where}`}
                          title={
                            off
                              ? "Put this area back in the list."
                              : "Leave this area alone. The box stays drawn on the page so you can still see it."
                          }
                        >
                          {off ? "Put back" : "Set aside"}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {page !== current && (
                  <button
                    className="btn sm ghost"
                    onClick={() => onGoTo(page)}
                    title="Look at this page before you commit."
                  >
                    Show page {page + 1}
                  </button>
                )}
              </div>
            ))}

            <button
              className="btn sm ghost"
              onClick={clearAll}
              title="Take every box off the page and start again."
            >
              Clear all
            </button>
          </>
        )}

        <div className="panel-section">
          <div className="field">
            <label className="label" htmlFor="redact-dpi">
              Quality of the redrawn pages, <span className="num">{dpi}</span> dpi
            </label>
            <input
              id="redact-dpi"
              className="range"
              type="range"
              min={MIN_DPI}
              max={MAX_DPI}
              step={2}
              value={dpi}
              onChange={(event) => setDpi(Number(event.target.value))}
            />
          </div>
          {ready ? (
            <>
              <div className="sizes">
                <span className="after num">{bytes(cost.roughBytes)}</span>
                <span className="change worse">added, near enough</span>
              </div>
              <p className={cost.slow ? "note warn" : "note"}>{cost.note}</p>
            </>
          ) : (
            <p className="note">
              Lower dpi means a smaller file and a softer page.{" "}
              <span className="num">150</span> still reads and prints fine,{" "}
              <span className="num">{DEFAULT_REDACT_DPI}</span> looks like a
              document rather than a fax.
            </p>
          )}
        </div>

        <div className="tradeoff">
          <p>
            <b>What happens.</b> Every page you marked is redrawn as a picture,
            with your boxes painted flat black onto the pixels before the picture
            is made. The words underneath are not hidden, they are not in the
            file. That is the difference between this and dragging a black
            rectangle over a name: a rectangle sits on top of the letters, and
            the letters stay in the file, selectable and searchable. Court
            filings and government releases have been published that way and
            read straight back out.
          </p>
          <p>
            <b>What it costs you.</b> On the pages you redact there is no
            selectable text left, so no searching, no copying and no Clause
            citations from them. There is nothing for a screen reader to read
            out, which is a real loss for anyone who needs one and it cannot be
            undone in the saved file. Those pages also get bigger, because a
            picture of a paragraph weighs far more than the paragraph, and they
            go soft if you zoom a long way in.
          </p>
          <p>
            <b>What it leaves alone.</b> Pages you did not mark are copied
            straight through. They keep their real text, their sharpness and
            their size.
          </p>
        </div>

        {done && (
          <div className="panel-section">
            <span className="label">Check it</span>

            {!done.textRemoved && (
              <p className="note cut">
                <strong>Not confirmed.</strong> The redrawn pages were reopened
                and either something still read back as text or the check could
                not run. Do not send this file until you have opened it yourself
                and tried to select the words.
              </p>
            )}

            <p className="note">
              <span className="num">{done.pages.length}</span>{" "}
              {plural(done.pages.length, "page")} (
              <span className="num">{ranges(done.pages)}</span>){" "}
              {done.pages.length === 1 ? "is" : "are"} now a picture at{" "}
              <span className="num">{done.dpi}</span> dpi. Type something that
              should be gone and this reads the file on the bench back, every
              page and the metadata, looking for it.
            </p>

            <div className="field">
              <label className="label" htmlFor="redact-phrase">
                Phrase that should be gone
              </label>
              <input
                id="redact-phrase"
                className="input"
                type="text"
                value={phrase}
                placeholder="a name, an account number, a sentence"
                onChange={(event) => {
                  setPhrase(event.target.value);
                  setVerdict(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void check();
                }}
              />
            </div>

            <button
              className="btn"
              onClick={() => void check()}
              disabled={checking || phrase.trim().length === 0}
              title={
                phrase.trim().length === 0
                  ? "Type the phrase you expect to be gone first."
                  : "Read the whole file back and look for it."
              }
            >
              {checking ? <IconSpinner size={14} /> : <IconSearch size={14} />}
              {checking ? "Reading the file" : "Look for it"}
            </button>

            {verdict && verdict.found.length > 0 && (
              <p className="note cut">
                <strong>Still in the file.</strong> "{verdict.phrase}" can be
                read out of this PDF right now. Either it is on a page nobody
                marked, or a box missed it, or it is sitting in the document
                title. Do not send this file. Undo, mark it, and run it again.
              </p>
            )}

            {verdict && verdict.found.length === 0 && verdict.clean && (
              <p className="note">
                <strong>Gone.</strong> "{verdict.phrase}" was in the document
                before and cannot be found anywhere in it now, on any page or in
                the metadata.
              </p>
            )}

            {verdict && verdict.found.length === 0 && !verdict.clean && (
              <p className="note warn">
                <strong>This proves nothing.</strong> "{verdict.phrase}" was not
                in the document before the redaction either, so it being absent
                now says nothing at all. Check the spelling, or try wording you
                can see on the page. Text that was only ever part of a scan
                cannot be searched by anyone, including this.
              </p>
            )}

            <p className="note warn">
              This reads text and nothing else. If a box landed in the wrong
              place the words are still there in the picture, plainly readable,
              and no check in here can see that. Open the pages you redacted and
              look at them.
            </p>
          </div>
        )}
      </div>

      <div className="inspector-foot">
        <button
          className="btn danger wide"
          onClick={run}
          disabled={!ready}
          title={
            nothingMarked
              ? "Drag a box over the words you want gone first."
              : !ready
                ? "Every box is set aside or has no size, so there is nothing to remove."
                : "The words under these boxes stop existing in the file."
          }
        >
          Remove the text from <span className="num">{pages.length}</span>{" "}
          {plural(pages.length, "page")}
        </button>
      </div>
    </>
  );
}
