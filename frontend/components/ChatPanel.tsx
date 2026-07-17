"use client";

import { useEffect, useRef, useState } from "react";
import type { AskMode, Flag, Severity, Source } from "@/lib/api";

export type ChatMessage =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      found: boolean;
      mode: AskMode;
      sources: Source[];
    }
  | {
      role: "scan";
      docName: string;
      mode: "llm" | "extractive";
      flags: Flag[];
      note: string;
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

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Worth reviewing",
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

function ScanResult({
  docName,
  mode,
  flags,
  note,
  onCite,
}: {
  docName: string;
  mode: "llm" | "extractive";
  flags: Flag[];
  note: string;
  onCite: (source: Source) => void;
}) {
  return (
    <div className="msg scan">
      <span className="msg-mode scan-mode">
        {flags.length > 0
          ? `Red-flag scan · ${flags.length} clause${flags.length === 1 ? "" : "s"} to review`
          : "Red-flag scan · nothing flagged"}
        {mode === "extractive" ? " · no LLM key set" : ""}
      </span>
      <div className="scan-note">{note}</div>
      {flags.map((flag) => (
        <div className={`flag-card sev-${flag.severity}`} key={flag.category}>
          <div className="flag-head">
            <span className={`sev-pill sev-${flag.severity}`}>
              {SEVERITY_LABEL[flag.severity]}
            </span>
            <span className="flag-title">{flag.title}</span>
          </div>
          {flag.explanation && (
            <div className="flag-explain">{flag.explanation}</div>
          )}
          {flag.sources.map((source) => (
            <button
              key={source.chunk_id}
              className="source-item"
              onClick={() => onCite(source)}
              title="Show this clause in the document"
            >
              <span className="source-loc">
                {docName} · p. {source.page}
              </span>
              <span className="source-quote">
                “{source.quote.length > 150 ? source.quote.slice(0, 150) + "…" : source.quote}”
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function ChatPanel({
  messages,
  asking,
  scanning,
  canScan,
  docName,
  multipleDocs,
  scope,
  onScopeChange,
  onAsk,
  onScan,
  onCite,
}: {
  messages: ChatMessage[];
  asking: boolean;
  scanning: boolean;
  canScan: boolean;
  docName: string | null;
  multipleDocs: boolean;
  scope: "doc" | "all";
  onScopeChange: (scope: "doc" | "all") => void;
  onAsk: (question: string) => void;
  onScan: () => void;
  onCite: (source: Source) => void;
}) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, asking, scanning]);

  const submit = (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || asking) return;
    setDraft("");
    onAsk(trimmed);
  };

  return (
    <>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && !asking && !scanning && (
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
            <button
              className="scan-cta"
              onClick={onScan}
              disabled={!canScan}
              title="Point out the clauses worth noticing — each with the exact text"
            >
              <span className="scan-flag">⚑</span> Scan this document for red flags
            </button>
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
          if (msg.role === "scan") {
            return (
              <ScanResult
                key={i}
                docName={msg.docName}
                mode={msg.mode}
                flags={msg.flags}
                note={msg.note}
                onCite={onCite}
              />
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
        {scanning && (
          <div className="thinking">
            Scanning for red flags<span className="dots" />
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
          <button
            className="scan-btn"
            onClick={onScan}
            disabled={!canScan || scanning}
            title="Point out the clauses worth noticing in this document"
          >
            <span className="scan-flag">⚑</span>
            {scanning ? "Scanning…" : "Scan for red flags"}
          </button>
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
