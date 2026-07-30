/**
 * The open document, and everything that has been done to it.
 *
 * There is exactly one source of truth: the current PDF bytes. Every edit is a
 * function from bytes to bytes, so undo is a stack of snapshots rather than a
 * pile of inverse operations that have to be kept in step. That costs memory,
 * which is why the stack is capped, and it buys an undo that cannot drift out
 * of sync with the file.
 *
 * Nothing here writes to a server, a cookie, or local storage. Close the tab
 * and the document is gone, because it never existed anywhere else.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { openForViewing, type PDFDocumentProxy } from "./pdf/viewer";
import { PdfOpError, checkSize, looksLikePdf } from "./pdf/ops/common";

/** How many steps back you can go. Each one holds a full copy of the file. */
const HISTORY_DEPTH = 20;

export type PageShape = {
  /** Width in points, as displayed, so a turned page is already swapped. */
  width: number;
  height: number;
  rotation: number;
};

export type OpenDoc = {
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  /** Shuts down the worker behind this document. See viewer.ts for why. */
  close(): Promise<void>;
  pageCount: number;
  pages: PageShape[];
  /** Bumped on every change so children know to repaint. */
  version: number;
};

type Snapshot = { name: string; bytes: Uint8Array; label: string };

export type Busy = { what: string; done: number; total: number } | null;

export type Note = {
  id: number;
  text: string;
  tone: "ok" | "bad" | "busy";
};

async function describe(pdf: PDFDocumentProxy): Promise<PageShape[]> {
  const shapes: PageShape[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    shapes.push({
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate ?? 0,
    });
    // No cleanup: page objects are shared with the viewer, see allPageText.
  }
  return shapes;
}

export function useSession() {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  /** What is open right now, so it can be closed without a state updater. */
  const live = useRef<OpenDoc | null>(null);
  const version = useRef(0);
  const [, forceRender] = useState(0);

  const say = useCallback((text: string, tone: Note["tone"] = "ok") => {
    const id = version.current * 1000 + Math.floor(performance.now());
    setNotes((list) => [...list.slice(-3), { id, text, tone }]);
    if (tone !== "busy") {
      setTimeout(() => {
        setNotes((list) => list.filter((n) => n.id !== id));
      }, 5200);
    }
    return id;
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotes((list) => list.filter((n) => n.id !== id));
  }, []);

  /** Replace what is on the bench, reopening it for display. */
  const install = useCallback(
    async (name: string, bytes: Uint8Array): Promise<OpenDoc> => {
      // pdf.js detaches whatever buffer it is handed, so it gets its own copy
      // and the session keeps the authoritative one.
      const opened = await openForViewing(bytes);
      const pages = await describe(opened.doc);
      version.current += 1;
      const next: OpenDoc = {
        name,
        bytes,
        pdf: opened.doc,
        close: opened.close,
        pageCount: opened.doc.numPages,
        pages,
        version: version.current,
      };
      // Shut the previous document's worker down. Skipping it leaks a worker
      // per edit, and every edit reopens the document.
      //
      // This deliberately does NOT live inside the setDoc updater. A state
      // updater has to be pure: React calls it more than once in development
      // to check that it is, and on the second call it passes the value it
      // just stored. Closing "the previous document" in there therefore closed
      // the one that had only just been opened, which left the viewer with a
      // torn down worker, an empty text layer and no way to edit anything.
      const previous = live.current;
      live.current = next;
      setDoc(next);
      if (previous) void previous.close().catch(() => undefined);
      return next;
    },
    [],
  );

  /** Open a file the user chose. */
  const open = useCallback(
    async (file: File) => {
      setBusy({ what: `Opening ${file.name}`, done: 0, total: 1 });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        checkSize(bytes);
        if (!looksLikePdf(bytes)) {
          throw new PdfOpError(
            `${file.name} is not a PDF.`,
            "This bench only opens PDFs. Images can be turned into one from the Convert tool.",
          );
        }
        past.current = [];
        future.current = [];
        await install(file.name, bytes);
        say(`Opened ${file.name}`);
      } catch (err) {
        reportProblem(err, say);
      } finally {
        setBusy(null);
      }
    },
    [install, say],
  );

  /** Open bytes we already have, such as a bundled sample. */
  const openBytes = useCallback(
    async (name: string, bytes: Uint8Array) => {
      setBusy({ what: `Opening ${name}`, done: 0, total: 1 });
      try {
        past.current = [];
        future.current = [];
        await install(name, bytes);
        say(`Opened ${name}`);
      } catch (err) {
        reportProblem(err, say);
      } finally {
        setBusy(null);
      }
    },
    [install, say],
  );

  /**
   * Run an edit.
   *
   * The label is what appears in the undo tooltip and in the toast, so it is
   * written as the thing that happened: "Rotated 3 pages", not "rotate".
   */
  const apply = useCallback(
    async (
      label: string,
      run: (bytes: Uint8Array, progress: (done: number, total: number) => void) => Promise<Uint8Array>,
    ) => {
      const current = doc;
      if (!current) return;
      setBusy({ what: label, done: 0, total: 1 });
      try {
        const next = await run(current.bytes, (done, total) =>
          setBusy({ what: label, done, total }),
        );
        past.current = [
          ...past.current.slice(-(HISTORY_DEPTH - 1)),
          { name: current.name, bytes: current.bytes, label },
        ];
        future.current = [];
        await install(current.name, next);
        say(label);
      } catch (err) {
        reportProblem(err, say);
      } finally {
        setBusy(null);
        forceRender((n) => n + 1);
      }
    },
    [doc, install, say],
  );

  const undo = useCallback(async () => {
    const step = past.current.pop();
    const current = doc;
    if (!step || !current) return;
    future.current.push({ name: current.name, bytes: current.bytes, label: step.label });
    await install(step.name, step.bytes);
    say(`Undid: ${step.label.toLowerCase()}`);
    forceRender((n) => n + 1);
  }, [doc, install, say]);

  const redo = useCallback(async () => {
    const step = future.current.pop();
    const current = doc;
    if (!step || !current) return;
    past.current.push({ name: current.name, bytes: current.bytes, label: step.label });
    await install(step.name, step.bytes);
    say(`Redid: ${step.label.toLowerCase()}`);
    forceRender((n) => n + 1);
  }, [doc, install, say]);

  const rename = useCallback((name: string) => {
    setDoc((prev) => (prev ? { ...prev, name } : prev));
  }, []);

  const close = useCallback(() => {
    // Same rule as install: the teardown happens here, not in the updater.
    const previous = live.current;
    live.current = null;
    setDoc(null);
    if (previous) void previous.close().catch(() => undefined);
    past.current = [];
    future.current = [];
  }, []);

  // Warn before leaving with unsaved work. The document only exists in this
  // tab, so a stray reload really does lose it.
  useEffect(() => {
    if (!doc || past.current.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [doc, doc?.version]);

  return {
    doc,
    busy,
    notes,
    say,
    dismiss,
    open,
    openBytes,
    apply,
    undo,
    redo,
    rename,
    close,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    lastStep: past.current[past.current.length - 1]?.label ?? null,
  };
}

/**
 * Turn a thrown value into something worth reading.
 *
 * Anything that is a PdfOpError was raised deliberately and already reads as a
 * sentence. Anything else is a bug in this app, and saying so is more useful
 * than blaming the file.
 */
function reportProblem(err: unknown, say: (text: string, tone: Note["tone"]) => void): void {
  if (err instanceof PdfOpError) {
    say(err.hint ? `${err.message} ${err.hint}` : err.message, "bad");
    return;
  }
  const detail = err instanceof Error ? err.message : String(err);
  say(`Something in Clause broke, not your file. ${detail}`, "bad");
  console.error("[clause]", err);
}
