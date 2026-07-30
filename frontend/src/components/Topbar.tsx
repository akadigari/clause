import { useEffect, useState } from "react";

import type { OpenDoc } from "../lib/session";
import { bytes as fmtBytes, baseName, plural } from "../lib/format";
import { savePdfBytes } from "../lib/save";
import NetMeter from "./NetMeter";
import { IconClose, IconDownload, IconLamp, IconRedo, IconUndo } from "./Icons";

type Props = {
  doc: OpenDoc | null;
  canUndo: boolean;
  canRedo: boolean;
  lastStep: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  onRename: (name: string) => void;
  onProblem: (message: string) => void;
};

export default function Topbar({
  doc,
  canUndo,
  canRedo,
  lastStep,
  onUndo,
  onRedo,
  onClose,
  onRename,
  onProblem,
}: Props) {
  const [lamp, setLamp] = useState<"dark" | "light">(
    () => (document.documentElement.dataset.bench as "dark" | "light") ?? "dark",
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    document.documentElement.dataset.bench = lamp;
    try {
      localStorage.setItem("clause.bench", lamp);
    } catch {
      /* storage blocked, the theme just will not stick between visits */
    }
  }, [lamp]);

  const commit = () => {
    const cleaned = draft.trim();
    if (cleaned) onRename(cleaned.endsWith(".pdf") ? cleaned : `${cleaned}.pdf`);
    setEditing(false);
  };

  return (
    <header className="topbar">
      <span className="wordmark">
        <span className="reg" />
        Clause
      </span>

      {doc ? (
        <div className="doc-title">
          {editing ? (
            <input
              className="input"
              style={{ maxWidth: 300, height: 28 }}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              aria-label="File name"
            />
          ) : (
            <button
              type="button"
              className="name"
              title="Click to rename"
              onClick={() => {
                setDraft(baseName(doc.name));
                setEditing(true);
              }}
            >
              {doc.name}
            </button>
          )}
          <span className="facts num">
            {doc.pageCount} {plural(doc.pageCount, "page")}
            <span className="dot">/</span>
            {fmtBytes(doc.bytes.byteLength)}
          </span>
        </div>
      ) : (
        <span className="doc-title">
          <span className="facts">Free, no account, nothing leaves your device</span>
        </span>
      )}

      <div className="topbar-right">
        {doc && (
          <>
            <button
              type="button"
              className="btn ghost"
              onClick={onUndo}
              disabled={!canUndo}
              title={lastStep ? `Undo: ${lastStep.toLowerCase()}` : "Nothing to undo"}
              aria-label="Undo"
            >
              <IconUndo size={16} />
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
              aria-label="Redo"
            >
              <IconRedo size={16} />
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                void savePdfBytes(doc.bytes, doc.name).catch(() =>
                  onProblem("The browser would not save that file."),
                );
              }}
            >
              <IconDownload size={16} />
              Save
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={onClose}
              title="Close this document"
              aria-label="Close document"
            >
              <IconClose size={16} />
            </button>
          </>
        )}

        <NetMeter />

        <button
          type="button"
          className="lamp"
          onClick={() => setLamp((v) => (v === "dark" ? "light" : "dark"))}
          aria-label={lamp === "dark" ? "Turn the bench lamp on" : "Turn the bench lamp off"}
          title={lamp === "dark" ? "Lamp on" : "Lamp off"}
        >
          <IconLamp size={17} on={lamp === "light"} />
        </button>
      </div>
    </header>
  );
}
