/**
 * Read: ask a question about the document, get the exact clause back.
 *
 * This is the original Clause. The rule it is built around is that it would
 * rather say "I could not find that" than guess, and every answer it does give
 * points at the words it came from, in the document, where you can read them
 * yourself.
 *
 * Two modes:
 *
 *   Passages (the default, and what runs with no setup). The engine indexes
 *   the document in this tab, retrieves the closest passages, and shows them.
 *   No writing, no interpretation, no network.
 *
 *   Plain English (optional). If you paste in your own Anthropic key, the
 *   retrieved passages are sent to a model that writes an answer about them.
 *   The abstain rules still run outside the model, so an answer with no
 *   receipts is thrown away before you see it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { PanelProps } from "../Inspector";
import {
  IconAsk,
  IconCheck,
  IconFlag,
  IconSearch,
  IconSpinner,
} from "../Icons";
import { plural } from "../../lib/format";
import { allPageText } from "../../lib/pdf/viewer";
import type {
  AskResult,
  Answerer,
  ScanResult,
  Source,
} from "../../lib/clause";
import { DocumentStore, HashingEmbedder, ask, scan } from "../../lib/clause";
import { DEFAULT_MODEL, MODELS } from "../../lib/clause/models";

type Turn =
  | { kind: "you"; text: string }
  | { kind: "answer"; result: AskResult }
  | { kind: "scan"; result: ScanResult }
  | { kind: "bad"; text: string };

const SUGGESTIONS = [
  "What am I agreeing to here?",
  "How do I get out of this, and what does it cost?",
  "What fees are in this document?",
  "Can they change the terms later?",
];

export default function AskPanel({ doc, session, onShowCitation }: PanelProps) {
  const [index, setIndex] = useState<{ store: DocumentStore; docId: string } | null>(
    null,
  );
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const [answerer, setAnswerer] = useState<Answerer | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const scroll = useRef<HTMLDivElement>(null);

  // Reading the text out of a PDF costs real time on a long document, so it
  // happens once, when this tool is first opened, and again only if the
  // document itself changed underneath.
  useEffect(() => {
    let cancelled = false;
    setIndex(null);
    setTurns([]);

    void (async () => {
      setIndexing({ done: 0, total: doc.pageCount });
      try {
        const pages = await allPageText(doc.pdf, (done, total) => {
          if (!cancelled) setIndexing({ done, total });
        });
        if (cancelled) return;
        const store = new DocumentStore(new HashingEmbedder());
        const stored = store.addDocument(doc.name, pages);
        setIndex({ store, docId: stored.id });
      } catch {
        if (!cancelled) {
          setTurns([
            {
              kind: "bad",
              text: "This document's text could not be read. If it is a scan, the pages are pictures of words rather than words, and reading them would need OCR, which this tool does not do.",
            },
          ]);
        }
      } finally {
        if (!cancelled) setIndexing(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc.pdf, doc.name, doc.pageCount, doc.version]);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [turns, thinking]);

  const put = useCallback((turn: Turn) => setTurns((list) => [...list, turn]), []);

  const send = useCallback(
    async (text: string) => {
      const cleaned = text.trim();
      if (!cleaned || !index || thinking) return;
      setQuestion("");
      put({ kind: "you", text: cleaned });
      setThinking(true);
      try {
        const result = await ask(index.store, answerer, cleaned, [index.docId]);
        put({ kind: "answer", result });
      } catch (err) {
        put({ kind: "bad", text: err instanceof Error ? err.message : String(err) });
      } finally {
        setThinking(false);
      }
    },
    [answerer, index, put, thinking],
  );

  const runScan = useCallback(async () => {
    if (!index || thinking) return;
    put({ kind: "you", text: "Point out anything in here worth noticing" });
    setThinking(true);
    try {
      const result = await scan(index.store, answerer, index.docId);
      put({ kind: "scan", result });
    } catch (err) {
      put({ kind: "bad", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setThinking(false);
    }
  }, [answerer, index, put, thinking]);

  const jumpTo = useCallback(
    (source: Source) => {
      // The engine counts pages from 1, the viewer counts from 0.
      onShowCitation(source.page - 1, source.start, source.end);
    },
    [onShowCitation],
  );

  const connect = useCallback(async () => {
    const key = keyDraft.trim();
    if (!key) return;
    const { ClaudeAnswerer } = await import("../../lib/clause/claude");
    setAnswerer(new ClaudeAnswerer(key, model));
    setKeyDraft("");
    setShowKey(false);
    session.say("Plain-English answers are on. Your key stays in this tab.");
  }, [keyDraft, model, session]);

  const ready = index !== null;

  return (
    <div className="ask">
      <div className="ask-scroll" ref={scroll}>
        {indexing && (
          <div className="note">
            <IconSpinner size={13} /> Reading the document, page{" "}
            <b className="num">{indexing.done}</b> of{" "}
            <b className="num">{indexing.total}</b>. This happens once, in this tab.
          </div>
        )}

        {showKey && (
          <div className="keybox">
            <h4>Plain-English answers</h4>
            <p>
              Everything else on this bench runs on your machine. This one thing
              does not: with your own Anthropic key, the passages Clause found
              get sent to a model that writes an answer about them. Your key is
              kept in this tab only and never saved. The meter in the corner
              turns amber while it is sending.
            </p>
            <div className="field">
              <span className="label">Anthropic API key</span>
              <input
                className="input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                aria-label="Anthropic API key"
              />
            </div>
            <div className="field">
              <span className="label">Model</span>
              <select
                className="select"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                aria-label="Model"
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.note})
                  </option>
                ))}
              </select>
            </div>
            <div className="pill-row">
              <button type="button" className="btn primary sm" onClick={() => void connect()}>
                Turn it on
              </button>
              <button type="button" className="btn ghost sm" onClick={() => setShowKey(false)}>
                Not now
              </button>
            </div>
          </div>
        )}

        {turns.length === 0 && !indexing && (
          <div className="ask-empty">
            <h3>Ask it anything</h3>
            <p>
              Every answer comes back with the exact words it came from. If the
              document does not say, Clause says so instead of guessing.
            </p>
            <div className="suggests">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="suggest"
                  disabled={!ready}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, i) => (
          <TurnView key={i} turn={turn} onJump={jumpTo} />
        ))}

        {thinking && (
          <div className="note">
            <IconSpinner size={13} /> Looking through the document
          </div>
        )}
      </div>

      <div className="composer">
        <div className="pill-row">
          <button
            type="button"
            className="pill"
            onClick={() => void runScan()}
            disabled={!ready || thinking}
            title={ready ? undefined : "Waiting for the document to be read"}
          >
            <IconFlag size={13} /> Check it over
          </button>
          {!answerer && (
            <button
              type="button"
              className="pill"
              onClick={() => setShowKey((v) => !v)}
            >
              <IconAsk size={13} /> Plain-English answers
            </button>
          )}
          {answerer && (
            <button
              type="button"
              className="pill on"
              onClick={() => {
                setAnswerer(null);
                session.say("Back to passages only. Nothing leaves this tab.");
              }}
              title="Turn plain-English answers off"
            >
              <IconCheck size={13} /> {model}
            </button>
          )}
        </div>

        <div className="composer-row">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(question);
              }
            }}
            placeholder={ready ? "Ask about this document" : "Reading the document..."}
            disabled={!ready}
            rows={1}
            aria-label="Your question"
          />
          <button
            type="button"
            className="send"
            onClick={() => void send(question)}
            disabled={!ready || thinking || question.trim() === ""}
            aria-label="Ask"
          >
            <IconSearch size={16} />
          </button>
        </div>

        <p className="under">
          {answerer
            ? "Passages are sent to Anthropic with your key"
            : "Runs in this tab, nothing is sent"}
        </p>
      </div>
    </div>
  );
}

function TurnView({ turn, onJump }: { turn: Turn; onJump: (s: Source) => void }) {
  if (turn.kind === "you") {
    return <div className="turn you">{turn.text}</div>;
  }

  if (turn.kind === "bad") {
    return <div className="turn bad">{turn.text}</div>;
  }

  if (turn.kind === "scan") {
    const { result } = turn;
    return (
      <div className="turn it">
        <span className="turn-mode">
          {result.flags.length > 0
            ? `${result.flags.length} ${plural(result.flags.length, "thing")} worth reading`
            : "nothing matched"}
        </span>
        <p className="turn-body" style={{ marginTop: 0 }}>
          {result.note}
        </p>
        {result.flags.map((flag) => (
          <div className={`flag sev-${flag.severity}`} key={flag.category}>
            <div className="flag-top">
              <span className={`sev sev-${flag.severity}`}>{flag.severity}</span>
              <span className="flag-name">{flag.title}</span>
            </div>
            <p className="flag-what">{flag.explanation}</p>
            {flag.sources.map((source) => (
              <Receipt key={source.chunkId} source={source} onJump={onJump} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const { result } = turn;
  return (
    <div className={`turn it ${result.found ? "" : "abstained"}`}>
      <span className={`turn-mode ${result.found ? "found" : "abstain"}`}>
        {result.mode === "llm"
          ? "answered from the document"
          : result.mode === "extractive"
            ? "closest passages"
            : "not found in this document"}
      </span>
      <div className="turn-body">{result.answer}</div>
      {result.sources.length > 0 && (
        <div className="receipts">
          <span className="label">
            {result.found ? "Where this came from" : "Closest passages"}
          </span>
          {result.sources.map((source) => (
            <Receipt key={source.chunkId} source={source} onJump={onJump} />
          ))}
        </div>
      )}
    </div>
  );
}

function Receipt({ source, onJump }: { source: Source; onJump: (s: Source) => void }) {
  return (
    <button
      type="button"
      className="receipt"
      onClick={() => onJump(source)}
      title="Show this on the page"
    >
      <span className="where num">page {source.page}</span>
      <span className="quote">{source.quote}</span>
    </button>
  );
}
