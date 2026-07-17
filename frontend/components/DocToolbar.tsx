"use client";

import { useState } from "react";
import type { DocumentMeta } from "@/lib/api";

export default function DocToolbar({
  docs,
  activeId,
  uploading,
  onSelect,
  onDelete,
  onUpload,
}: {
  docs: DocumentMeta[];
  activeId: string | null;
  uploading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onUpload: (file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const pickFile = (files: FileList | null) => {
    const file = files?.[0];
    if (file) onUpload(file);
  };

  return (
    <div
      className="doc-toolbar"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pickFile(e.dataTransfer.files);
      }}
    >
      {docs.map((doc) => (
        <span
          key={doc.id}
          className={`doc-tab${doc.id === activeId ? " active" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(doc.id)}
          onKeyDown={(e) => e.key === "Enter" && onSelect(doc.id)}
          title={`${doc.name}, ${doc.pages} page${doc.pages === 1 ? "" : "s"}`}
        >
          <span className="doc-tab-name">{doc.name}</span>
          {doc.sample ? (
            <span className="sample-flag">sample</span>
          ) : (
            <button
              className="doc-close"
              aria-label={`Remove ${doc.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(doc.id);
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}

      <label className={`upload-chip${dragging ? " dragging" : ""}`}>
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => {
            pickFile(e.target.files);
            e.target.value = "";
          }}
        />
        {uploading ? "Uploading…" : "+ Upload PDF"}
      </label>
    </div>
  );
}
