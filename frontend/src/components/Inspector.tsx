/**
 * The inspector: controls for whichever tool is out.
 *
 * Every panel gets the same props and does its own work through
 * `session.apply`, which handles undo, progress, and errors in one place. A
 * panel never touches pdf-lib directly on the main path: it calls an operation
 * from lib/pdf/ops and hands the result back.
 *
 * Panels are loaded on demand. Someone who only ever merges two files should
 * not download the redaction tool.
 */

import { Suspense, lazy } from "react";

import type { ToolId } from "./Rail";
import type { StageMark } from "./Stage";
import type { OpenDoc, useSession } from "../lib/session";
import { IconSpinner } from "./Icons";

export type PanelProps = {
  doc: OpenDoc;
  session: ReturnType<typeof useSession>;
  /** Pages picked in the strip, as indexes. */
  selected: number[];
  onSelect: (indexes: number[]) => void;
  /** Cut points placed in the strip, as "after this index". */
  cuts: number[];
  onCutsChange: (cuts: number[]) => void;
  /** Boxes drawn on the page, used by the redaction tool. */
  marks: StageMark[];
  onClearMarks: () => void;
  current: number;
  onGoTo: (index: number) => void;
  /** Scroll the stage to a character range on a page and highlight it. */
  onShowCitation: (page: number, start: number, end: number) => void;
};

const PANELS: Record<ToolId, React.LazyExoticComponent<React.ComponentType<PanelProps>>> = {
  pages: lazy(() => import("./panels/PagesPanel")),
  merge: lazy(() => import("./panels/MergePanel")),
  split: lazy(() => import("./panels/SplitPanel")),
  stamp: lazy(() => import("./panels/StampPanel")),
  sign: lazy(() => import("./panels/SignPanel")),
  redact: lazy(() => import("./panels/RedactPanel")),
  shrink: lazy(() => import("./panels/ShrinkPanel")),
  convert: lazy(() => import("./panels/ConvertPanel")),
  forms: lazy(() => import("./panels/FormsPanel")),
  details: lazy(() => import("./panels/DetailsPanel")),
  ask: lazy(() => import("./panels/AskPanel")),
};

/** Title and one line on what the tool is for, shown above every panel. */
const HEADINGS: Record<ToolId, { title: string; why: string }> = {
  pages: { title: "Pages", why: "Turn, reorder, remove or pull out pages." },
  merge: { title: "Merge", why: "Put several PDFs together into one." },
  split: {
    title: "Split",
    why: "Cut this into separate files. Click between pages in the strip to place a cut.",
  },
  stamp: { title: "Mark", why: "Add text, a watermark, or page numbers." },
  sign: { title: "Sign", why: "Draw your signature once, then place it." },
  redact: {
    title: "Redact",
    why: "Take words out of the file for good, not just cover them up.",
  },
  shrink: { title: "Shrink", why: "Make the file smaller, with the real numbers." },
  convert: { title: "Convert", why: "Pages to images, images to pages, or plain text." },
  forms: { title: "Fields", why: "Fill in a form and lock the answers in." },
  details: { title: "Details", why: "See and clear what the file says about itself." },
  ask: { title: "Read", why: "Ask a question and get the exact clause back." },
};

type Props = PanelProps & { tool: ToolId };

export default function Inspector({ tool, ...panelProps }: Props) {
  const Panel = PANELS[tool];
  const heading = HEADINGS[tool];

  return (
    <aside className="inspector" aria-label={heading.title}>
      <div className="inspector-head">
        <div>
          <h2>{heading.title}</h2>
          <p className="why">{heading.why}</p>
        </div>
      </div>

      <Suspense
        fallback={
          <div className="inspector-body" style={{ display: "grid", placeItems: "center" }}>
            <IconSpinner size={20} />
          </div>
        }
      >
        <Panel {...panelProps} />
      </Suspense>
    </aside>
  );
}
