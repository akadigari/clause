"use client";

import { useEffect, useRef, useState } from "react";
import type { AskMode, Source } from "@/lib/api";

export type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      found: boolean;
      mode: AskMode;
      sources: Source[];
    }
  | { role: "error"; text: string };

const SUGGESTIONS = [
  "What am I actually agreeing to?",
  "How do I cancel?",
  "What fees could I be charged?",
  "Do I get my deposit back when I move out?",
];

const MODE_LABEL: Record<AskMode, string> = {
  llm: "Answer · with receipts",
  extractive: "Matching passages · no LLM key set",
  abstain: "Not found in this document",
};

function SourceList({
  sources,
  found,
  onCite,
}: {
  sources: Source[];
  found: boolean;
  onCite: (source: Source) => void;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="sources">
      <div className="sources-label">
        {found ? "Sources" : "Closest passages checked"}
      </div>
      {sources.map((source) => (
        <button
          key={source.chunk_id}
          className="source-item"
          onClick={() => onCite(source)}
          title="Show this passage in the document"
        >
          <span className="source-loc">
            {source.doc_name} · p. {source.page}
          </span>
          <span className="source-quote">
            “{source.quote.length > 150 ? source.quote.slice(0, 150) + "…" : source.quote}”
          </span>
        </button>
      ))}
    </div>
  );
}

export default function ChatPanel({
  messages,
  asking,
  docName,
  multipleDocs,
  scope,
  onScopeChange,
  onAsk,
  onCite,
}: {
  messages: ChatMessage[];
  asking: boolean;
  docName: string | null;
  multipleDocs: boolean;
  scope: "doc" | "all";
  onScopeChange: (scope: "doc" | "all") => void;
  onAsk: (question: string) => void;
  onCite: (source: Source) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, asking]);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setDraft("");
    onAsk(trimmed);
  };

  return (
    <>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !asking && (
          <div className="chat-empty">
            <h2>Ask about your document</h2>
            <p>
              Plain-English answers, and every answer shows the exact clause it
              came from. If it isn’t in the document, Clause says so instead of
              guessing.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === "user") {
            return (
              <div className="msg user" key={i}>
                {msg.text}
              </div>
            );
          }
          if (msg.role === "error") {
            return (
              <div className="msg error" key={i}>
                {msg.text}
              </div>
            );
          }
          return (
            <div
              className={`msg assistant${msg.found ? "" : " abstain"}`}
              key={i}
            >
              <span className={`msg-mode ${msg.mode}`}>
                {MODE_LABEL[msg.mode]}
              </span>
              <div className="msg-answer">{msg.text}</div>
              <SourceList sources={msg.sources} found={msg.found} onCite={onCite} />
            </div>
          );
        })}

        {asking && (
          <div className="thinking">
            Reading the document<span className="dots" />
          </div>
        )}
      </div>

      <div className="composer">
        <div className="scope-row">
          <span>Searching:</span>
          <select
            value={scope}
            onChange={(e) => onScopeChange(e.target.value as "doc" | "all")}
            disabled={!multipleDocs && scope === "doc"}
          >
            <option value="doc">
              {docName ? `This document (${docName})` : "This document"}
            </option>
            <option value="all">All documents</option>
          </select>
        </div>
        <div className="input-row">
          <textarea
            value={draft}
            placeholder="e.g. Can my landlord raise the rent mid-lease?"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
          />
          <button
            className="send-btn"
            onClick={() => submit(draft)}
            disabled={asking || draft.trim().length === 0}
          >
            Ask
          </button>
        </div>
        <div className="privacy-note">
          Documents are processed in memory only and expire after an hour —
          nothing is stored on a server.
        </div>
      </div>
    </>
  );
}
