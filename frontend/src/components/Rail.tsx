/**
 * The tool rail.
 *
 * Grouped by what you are doing to the document, not alphabetically: change
 * the stack, put something on a page, change the whole file, then read it.
 * The separators carry that meaning, so they are not decoration.
 */

import {
  IconAsk,
  IconCompress,
  IconConvert,
  IconEditText,
  IconForm,
  IconMerge,
  IconPages,
  IconRedact,
  IconSign,
  IconSplit,
  IconStamp,
  IconTag,
} from "./Icons";

export type ToolId =
  | "pages"
  | "merge"
  | "split"
  | "edit"
  | "stamp"
  | "sign"
  | "redact"
  | "shrink"
  | "convert"
  | "forms"
  | "details"
  | "ask";

type Entry = {
  id: ToolId;
  label: string;
  Icon: (props: { size?: number }) => React.JSX.Element;
  /** Merge and Convert can start from an empty bench. The rest need a file. */
  needsDoc: boolean;
};

const GROUPS: Entry[][] = [
  [
    { id: "pages", label: "Pages", Icon: IconPages, needsDoc: true },
    { id: "merge", label: "Merge", Icon: IconMerge, needsDoc: false },
    { id: "split", label: "Split", Icon: IconSplit, needsDoc: true },
  ],
  [
    { id: "edit", label: "Edit", Icon: IconEditText, needsDoc: true },
    { id: "stamp", label: "Mark", Icon: IconStamp, needsDoc: true },
    { id: "sign", label: "Sign", Icon: IconSign, needsDoc: true },
    { id: "redact", label: "Redact", Icon: IconRedact, needsDoc: true },
  ],
  [
    { id: "shrink", label: "Shrink", Icon: IconCompress, needsDoc: true },
    { id: "convert", label: "Convert", Icon: IconConvert, needsDoc: false },
  ],
  [
    { id: "forms", label: "Fields", Icon: IconForm, needsDoc: true },
    { id: "details", label: "Details", Icon: IconTag, needsDoc: true },
  ],
  [{ id: "ask", label: "Read", Icon: IconAsk, needsDoc: true }],
];

type Props = {
  active: ToolId;
  hasDoc: boolean;
  onPick: (tool: ToolId) => void;
  onShowPages: () => void;
};

export default function Rail({ active, hasDoc, onPick, onShowPages }: Props) {
  return (
    <nav className="rail" aria-label="Tools">
      {hasDoc && (
        <>
          <button
            type="button"
            className="rail-btn only-narrow"
            onClick={onShowPages}
            aria-label="Show the page strip"
          >
            <IconPages size={19} />
            <span>Stack</span>
          </button>
          <div className="rail-sep only-narrow" />
        </>
      )}

      {GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} style={{ display: "contents" }}>
          {group.map(({ id, label, Icon }) => {
            const locked = !hasDoc && GROUPS.flat().find((e) => e.id === id)?.needsDoc;
            return (
              <button
                key={id}
                type="button"
                className={`rail-btn ${active === id ? "on" : ""}`}
                onClick={() => onPick(id)}
                disabled={Boolean(locked)}
                title={locked ? "Open a PDF first" : label}
                aria-current={active === id ? "true" : undefined}
              >
                <Icon size={19} />
                <span>{label}</span>
              </button>
            );
          })}
          {groupIndex < GROUPS.length - 1 && <div className="rail-sep" />}
        </div>
      ))}
    </nav>
  );
}
