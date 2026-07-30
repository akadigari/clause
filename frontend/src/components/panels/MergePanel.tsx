/**
 * Merge: put several PDFs together into one.
 *
 * This is the one tool that makes sense with nothing else on the bench, so the
 * open document is simply the first row of the list and everything else gets
 * added after it. That keeps one mental model instead of two: a merge is always
 * "this file, plus these", in the order shown.
 *
 * The result lands back on the bench through session.apply rather than
 * downloading straight away. Merging is the operation people get wrong most
 * often, usually by order, and a merge you can look at and undo beats a file in
 * the downloads folder that has to be redone from scratch.
 *
 * Order is the whole point, so every row can move, including the first one. A
 * cover page belongs in front of the document, not behind it.
 */

import { useCallback, useRef, useState } from "react";

import type { PanelProps } from "../Inspector";
import { bytes as sizeOf, plural } from "../../lib/format";
import { IconTrash } from "../Icons";

/**
 * One row in the list.
 *
 * `bytes` is null for the document on the bench. Its bytes are read when the
 * merge runs, not when the row is made, so anything done with another tool in
 * the meantime goes into the merge.
 */
type Row = {
  id: number;
  name: string;
  bytes: Uint8Array | null;
  pages: number;
};

const BENCH: Row = { id: 0, name: "", bytes: null, pages: 0 };

export default function MergePanel({ doc, session }: PanelProps) {
  const [rows, setRows] = useState<Row[]>([BENCH]);
  const [over, setOver] = useState(false);
  const [reading, setReading] = useState(false);
  const nextId = useRef(1);

  const nameOf = (row: Row) => (row.bytes ? row.name : doc.name);
  const pagesOf = (row: Row) => (row.bytes ? row.pages : doc.pageCount);

  const totalPages = rows.reduce((sum, row) => sum + pagesOf(row), 0);
  const added = rows.filter((row) => row.bytes !== null).length;
  const totalBytes = rows.reduce(
    (sum, row) => sum + (row.bytes ? row.bytes.byteLength : doc.bytes.byteLength),
    0,
  );

  /** Read what was dropped or picked, count the pages, and add the good ones. */
  const takeFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setReading(true);
      try {
        const { looksLikePdf, pageCount } = await import("../../lib/pdf/ops/common");
        const fresh: Row[] = [];
        const notPdf: string[] = [];
        const unreadable: string[] = [];

        for (const file of files) {
          const data = new Uint8Array(await file.arrayBuffer());
          if (!looksLikePdf(data)) {
            notPdf.push(file.name);
            continue;
          }
          try {
            // Counted now rather than at merge time, because the list is what
            // someone checks the order against and a row with no page count is
            // not something you can check.
            const pages = await pageCount(data);
            fresh.push({ id: nextId.current++, name: file.name, bytes: data, pages });
          } catch {
            unreadable.push(file.name);
          }
        }

        if (fresh.length > 0) setRows((list) => [...list, ...fresh]);

        if (notPdf.length === 1) {
          session.say(
            `${notPdf[0]} is not a PDF, so it was left out. Images become pages in the Convert tool.`,
            "bad",
          );
        } else if (notPdf.length > 1) {
          session.say(
            `${notPdf.length} files were left out because they are not PDFs: ${notPdf.join(", ")}. Images become pages in the Convert tool.`,
            "bad",
          );
        }

        if (unreadable.length === 1) {
          session.say(
            `${unreadable[0]} is a PDF, but damaged enough that its pages could not be counted, so it was left out. Re-export it and add it again.`,
            "bad",
          );
        } else if (unreadable.length > 1) {
          session.say(
            `${unreadable.length} files were left out because they could not be read: ${unreadable.join(", ")}. Re-export them and add them again.`,
            "bad",
          );
        }
      } finally {
        setReading(false);
      }
    },
    [session],
  );

  const move = useCallback((index: number, by: -1 | 1) => {
    setRows((list) => {
      const to = index + by;
      const from = list[index];
      const swap = list[to];
      if (!from || !swap) return list;
      const next = [...list];
      next[index] = swap;
      next[to] = from;
      return next;
    });
  }, []);

  const remove = useCallback((id: number) => {
    setRows((list) => list.filter((row) => row.id !== id));
  }, []);

  const merge = () => {
    const count = rows.length;
    const label = `Merged ${count} ${plural(count, "file")} into ${totalPages} ${plural(totalPages, "page")}`;
    void session.apply(label, async (current, progress) => {
      const { mergePdfs } = await import("../../lib/pdf/ops/merge");
      const inputs = rows.map((row) => ({
        name: row.bytes ? row.name : doc.name,
        bytes: row.bytes ?? current,
      }));
      const result = await mergePdfs(inputs, progress);
      return result.bytes;
    });
  };

  const ready = rows.length >= 2 && !reading;

  return (
    <>
      <div
        className="inspector-body"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={(event) => {
          // Moving between children fires dragleave on the way out, so only a
          // pointer that has actually left the panel counts.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setOver(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          void takeFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <div className={rows.length >= 2 ? "selection" : "selection empty"}>
          <span>
            <b className="num">{rows.length}</b> {plural(rows.length, "file")} in this order
          </span>
          <span className="num">
            {totalPages} {plural(totalPages, "page")}, {sizeOf(totalBytes)}
          </span>
        </div>

        <div className="panel-section">
          <span className="label">The merge, top to bottom</span>
          {rows.map((row, i) => {
            const name = nameOf(row);
            const pages = pagesOf(row);
            const bench = row.bytes === null;
            return (
              <div className="file-row" key={row.id}>
                <span className="fname" title={bench ? `${name}, the file on the bench` : name}>
                  {name}
                </span>
                <span className="fpages num">
                  {pages} {plural(pages, "page")}
                </span>
                <button
                  className="btn ghost sm"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${name} up`}
                  title={i === 0 ? `${name} is already first` : `Move ${name} up`}
                >
                  Up
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => move(i, 1)}
                  disabled={i === rows.length - 1}
                  aria-label={`Move ${name} down`}
                  title={i === rows.length - 1 ? `${name} is already last` : `Move ${name} down`}
                >
                  Down
                </button>
                <button
                  className="btn ghost sm"
                  onClick={() => remove(row.id)}
                  disabled={bench}
                  aria-label={`Take ${name} out of the merge`}
                  title={
                    bench
                      ? "This one is open on the bench, and the merge lands on it"
                      : `Take ${name} out of the merge`
                  }
                >
                  <IconTrash size={15} />
                </button>
              </div>
            );
          })}

          {added > 0 && (
            <button className="btn ghost sm" onClick={() => setRows([BENCH])}>
              Start the list again
            </button>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor="merge-add">
            Add PDFs
          </label>
          <input
            id="merge-add"
            className="input"
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(event) => {
              const picked = Array.from(event.target.files ?? []);
              // Clearing it means picking the same file twice still fires.
              event.target.value = "";
              void takeFiles(picked);
            }}
          />
        </div>

        <div className={over ? "note warn" : "note"}>
          {over ? (
            <strong>Let go to add them to the bottom of the list.</strong>
          ) : reading ? (
            "Reading the files you picked."
          ) : (
            "Drop PDFs anywhere in this panel to add them. New files go to the bottom, then move them where you want."
          )}
        </div>

        <p className="tradeoff">
          <b>Page sizes are left alone.</b> A Letter contract followed by an A4
          invoice comes out as both sizes, because scaling one to fit the other
          cannot be undone. Bookmarks do not survive a merge, and when two files
          use the same form field name the second one is renamed.
        </p>
      </div>

      <div className="inspector-foot">
        <button
          className="btn primary wide"
          onClick={merge}
          disabled={!ready}
          title={
            reading
              ? "Still reading the files you added"
              : rows.length < 2
                ? "Add at least one more PDF to merge with this one"
                : undefined
          }
        >
          Merge <span className="num">{rows.length}</span> {plural(rows.length, "file")} into{" "}
          <span className="num">{totalPages}</span> {plural(totalPages, "page")}
        </button>
      </div>
    </>
  );
}
