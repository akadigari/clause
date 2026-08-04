/**
 * The bench.
 *
 * App owns the small amount of state that more than one panel cares about:
 * which tool is out, which pages are picked, where the cut marks are, and
 * which marks have been drawn on the page. Everything else lives in the panel
 * that needs it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import Landing from "./components/Landing";
import Rail, { type ToolId } from "./components/Rail";
import Ribbon from "./components/Ribbon";
import Stage, {
  lineKey,
  type OpenEdit,
  type StageMark,
  type StageMode,
  type TextLine,
} from "./components/Stage";
import type { PendingEdit } from "./components/panels/EditPanel";
import Topbar from "./components/Topbar";
import Toasts from "./components/Toasts";
import Inspector from "./components/Inspector";
import { useSession } from "./lib/session";
import type { Rect } from "./lib/pdf/geometry";

export type Cite = { page: number; start: number; end: number; nonce: number };

export default function App() {
  const session = useSession();
  const { doc } = session;

  const [tool, setTool] = useState<ToolId>("pages");
  const [selected, setSelected] = useState<number[]>([]);
  const [cuts, setCuts] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const [marks, setMarks] = useState<StageMark[]>([]);
  const [cite, setCite] = useState<Cite | null>(null);
  const [mobilePane, setMobilePane] = useState<"stage" | "ribbon" | "inspector">("stage");

  // Text editing. `open` is the line being retyped right now, `pending` are the
  // ones already retyped and waiting to be written into the file.
  const [open, setOpen] = useState<OpenEdit | null>(null);
  const [pending, setPending] = useState<PendingEdit[]>([]);
  const [editStyle, setEditStyle] = useState({
    color: "#000000",
    background: "#ffffff",
    transparent: true,
  });

  // A new document invalidates everything that referred to the old one.
  const docKey = doc ? `${doc.name}:${doc.version}` : null;
  useEffect(() => {
    setSelected([]);
    setCuts([]);
    setMarks([]);
    setCite(null);
    setOpen(null);
    setPending([]);
    setCurrent((page) => (doc ? Math.min(page, doc.pageCount - 1) : 0));
  }, [docKey, doc]);

  const addMark = useCallback((page: number, rect: Rect, kind: StageMark["kind"]) => {
    setMarks((list) => [
      ...list,
      { id: `${kind}-${page}-${list.length}-${Math.round(rect.x)}x${Math.round(rect.y)}`, page, rect, kind },
    ]);
  }, []);

  const removeMark = useCallback((id: string) => {
    setMarks((list) => list.filter((m) => m.id !== id));
  }, []);

  /**
   * What the page overlay does right now. Only the redaction tool wants
   * drags, so everything else leaves the text selectable.
   */
  /** Park whatever is open into the pending list, keeping any real change. */
  const keepOpen = useCallback(() => {
    setOpen((current) => {
      if (!current) return null;
      setPending((list) => [
        ...list.filter((p) => p.key !== current.key),
        { ...current, color: editStyle.color, background: bg(editStyle) },
      ]);
      return null;
    });
  }, [editStyle]);

  const pickLine = useCallback(
    (page: number, line: TextLine | null) => {
      keepOpen();
      if (!line) return;
      const key = lineKey(page, line);
      const already = pending.find((p) => p.key === key);
      setOpen({
        page,
        key,
        rect: { x: line.x, y: line.y, width: line.width, height: line.height },
        baseline: line.baseline,
        original: line.text,
        text: already?.text ?? line.text,
        fontSize: already?.fontSize ?? line.fontSize,
        // A line squeezed to fit its column has to stay squeezed, or the
        // replacement comes out wider than the space it is going into.
        squeeze: line.pieces[0]?.squeeze ?? 1,
      });
    },
    [keepOpen, pending],
  );

  const stageMode: StageMode = useMemo(() => {
    if (tool === "edit") {
      return {
        kind: "edit",
        hint: "Click any line to retype it. The old words come out of the file.",
        open,
        doneKeys: pending.filter((p) => p.text !== p.original).map((p) => p.key),
        onPick: pickLine,
        onType: (text: string) => setOpen((c) => (c ? { ...c, text } : c)),
      };
    }
    if (tool === "redact") {
      return {
        kind: "box",
        hint: "Drag over anything that should be removed. Click a box to take it back off.",
        onBox: (page, rect) => addMark(page, rect, "redact"),
      };
    }
    return { kind: "read" };
  }, [tool, addMark, open, pending, pickLine]);

  const goTo = useCallback((index: number) => {
    setCurrent(index);
    setMobilePane("stage");
  }, []);

  const showCitation = useCallback((page: number, start: number, end: number) => {
    setCurrent(page);
    setCite((prev) => ({ page, start, end, nonce: (prev?.nonce ?? 0) + 1 }));
    setMobilePane("stage");
  }, []);

  // Keyboard shortcuts. A bench with no shortcuts is a toy.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? session.redo() : session.undo());
        return;
      }
      if (!doc) return;
      if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        setCurrent((p) => Math.min(p + 1, doc.pageCount - 1));
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        setCurrent((p) => Math.max(p - 1, 0));
      } else if (meta && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelected(Array.from({ length: doc.pageCount }, (_, i) => i));
      } else if (event.key === "Escape") {
        setSelected([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, session]);

  return (
    <div className="bench">
      <Topbar
        doc={doc}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        lastStep={session.lastStep}
        onUndo={() => void session.undo()}
        onRedo={() => void session.redo()}
        onClose={session.close}
        onRename={session.rename}
        onProblem={(message) => session.say(message, "bad")}
      />

      <main className={`main ${doc ? "" : "no-doc"}`} data-mobile={mobilePane}>
        <Rail
          active={tool}
          hasDoc={doc !== null}
          onPick={(next) => {
            setTool(next);
            setMobilePane("inspector");
          }}
          onShowPages={() => setMobilePane("ribbon")}
        />

        {doc ? (
          <>
            <Ribbon
              doc={doc}
              selected={selected}
              onSelect={setSelected}
              cuts={cuts}
              onCutsChange={setCuts}
              current={current}
              onGoTo={goTo}
              onReorder={(from, to) => {
                void session.apply(`Moved page ${from + 1}`, async (bytes) => {
                  const { movePage } = await import("./lib/pdf/ops/pages");
                  return movePage(bytes, from, to);
                });
                setCurrent(to);
              }}
            />

            <Stage
              doc={doc}
              page={current}
              mode={stageMode}
              marks={marks}
              cite={cite}
              onRemoveMark={removeMark}
            />

            <Inspector
              tool={tool}
              session={session}
              doc={doc}
              selected={selected}
              onSelect={setSelected}
              cuts={cuts}
              onCutsChange={setCuts}
              marks={marks}
              onClearMarks={() => setMarks([])}
              current={current}
              onGoTo={goTo}
              onShowCitation={showCitation}
              extra={
                tool === "edit"
                  ? {
                      open,
                      pending,
                      style: editStyle,
                      onStyle: setEditStyle,
                      onSizeChange: (size: number) =>
                        setOpen((c) => (c ? { ...c, fontSize: size } : c)),
                      onKeep: keepOpen,
                      onDrop: (key: string) =>
                        setPending((list) => list.filter((p) => p.key !== key)),
                      onClearAll: () => {
                        setPending([]);
                        setOpen(null);
                      },
                    }
                  : undefined
              }
            />
          </>
        ) : (
          <Landing
            onOpen={(file) => void session.open(file)}
            onOpenBytes={(name, bytes) => void session.openBytes(name, bytes)}
            onProblem={(message) => session.say(message, "bad")}
          />
        )}
      </main>

      <StatusBar doc={doc} page={current} selected={selected} cuts={cuts} />

      <Toasts notes={session.notes} onDismiss={session.dismiss} />

      {session.busy && (
        <div className="working" role="status" aria-live="polite">
          <div className="working-card">
            <span className="what">{session.busy.what}</span>
            <div className="bar">
              <i
                style={{
                  width: `${
                    session.busy.total > 0
                      ? Math.round((session.busy.done / session.busy.total) * 100)
                      : 8
                  }%`,
                }}
              />
            </div>
            <span className="label num">
              {session.busy.total > 1
                ? `${session.busy.done} of ${session.busy.total}`
                : "working"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBar({
  doc,
  page,
  selected,
  cuts,
}: {
  doc: ReturnType<typeof useSession>["doc"];
  page: number;
  selected: number[];
  cuts: number[];
}) {
  if (!doc) {
    return (
      <footer className="statusbar">
        <span>Nothing open</span>
        <span className="grow">Everything below runs in this tab</span>
      </footer>
    );
  }
  const shape = doc.pages[page];
  const wide = shape ? Math.round((shape.width / 72) * 25.4) : 0;
  const tall = shape ? Math.round((shape.height / 72) * 25.4) : 0;

  return (
    <footer className="statusbar">
      <span>
        page <b>{page + 1}</b> / {doc.pageCount}
      </span>
      {shape && (
        <span>
          {wide} &times; {tall} mm
        </span>
      )}
      {shape && shape.rotation % 360 !== 0 && <span>turned {shape.rotation % 360}&deg;</span>}
      {selected.length > 0 && (
        <span>
          <b>{selected.length}</b> selected
        </span>
      )}
      {cuts.length > 0 && (
        <span>
          <b>{cuts.length + 1}</b> parts marked
        </span>
      )}
      <span className="grow">nothing has been uploaded</span>
    </footer>
  );
}

/**
 * What to paint behind replacement text.
 *
 * "Match the paper" is the honest default because nothing here samples the
 * page: on white paper white is right, and anywhere else the person has to
 * pick the colour themselves.
 */
function bg(style: { background: string; transparent: boolean }): string {
  return style.transparent ? "#ffffff" : style.background;
}
