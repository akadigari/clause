import type { Note } from "../lib/session";
import { IconClose } from "./Icons";

export default function Toasts({
  notes,
  onDismiss,
}: {
  notes: Note[];
  onDismiss: (id: number) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {notes.map((note) => (
        <div key={note.id} className={`toast ${note.tone === "bad" ? "bad" : ""}`}>
          <span className="tick" />
          <span>{note.text}</span>
          <button
            type="button"
            className="round"
            onClick={() => onDismiss(note.id)}
            aria-label="Dismiss"
          >
            <IconClose size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
