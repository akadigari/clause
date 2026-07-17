"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type DocumentDetail,
  type DocumentMeta,
  type Health,
  type Source,
} from "@/lib/api";
import ChatPanel, { type ChatMessage } from "@/components/ChatPanel";
import DocToolbar from "@/components/DocToolbar";
import DocViewer, { type Highlight } from "@/components/DocViewer";

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [scope, setScope] = useState<"doc" | "all">("doc");
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const details = useRef(new Map<string, DocumentDetail>());
  const [activeDetail, setActiveDetail] = useState<DocumentDetail | null>(null);

  const openDoc = useCallback(async (id: string) => {
    setActiveId(id);
    const cached = details.current.get(id);
    if (cached) {
      setActiveDetail(cached);
      return;
    }
    setActiveDetail(null);
    try {
      const detail = await api.getDocument(id);
      details.current.set(id, detail);
      setActiveDetail(detail);
    } catch {
      setActiveDetail(null);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api
      .listDocuments()
      .then((list) => {
        setDocs(list);
        if (list.length > 0) void openDoc(list[0].id);
      })
      .catch(() =>
        setMessages([
          {
            role: "error",
            text: "Can't reach the Clause backend. Is it running on port 8000?",
          },
        ]),
      );
  }, [openDoc]);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const detail = await api.uploadDocument(file);
      details.current.set(detail.id, detail);
      setDocs(await api.listDocuments());
      setActiveId(detail.id);
      setActiveDetail(detail);
      setScope("doc");
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "error", text: err instanceof Error ? err.message : "Upload failed." },
      ]);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteDocument(id);
      details.current.delete(id);
      const list = await api.listDocuments();
      setDocs(list);
      if (activeId === id) {
        if (list.length > 0) void openDoc(list[0].id);
        else {
          setActiveId(null);
          setActiveDetail(null);
        }
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "error", text: err instanceof Error ? err.message : "Delete failed." },
      ]);
    }
  };

  const handleAsk = async (question: string) => {
    setMessages((m) => [...m, { role: "user", text: question }]);
    setAsking(true);
    try {
      const docIds = scope === "doc" && activeId ? [activeId] : null;
      const res = await api.ask(question, docIds);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          text: res.answer,
          found: res.found,
          mode: res.mode,
          sources: res.sources,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: "error",
          text: err instanceof Error ? err.message : "Something went wrong.",
        },
      ]);
    } finally {
      setAsking(false);
    }
  };

  const handleScan = async () => {
    if (!activeId || scanning) return;
    const doc = docs.find((d) => d.id === activeId);
    setMessages((m) => [
      ...m,
      { role: "user", text: `Scan “${doc?.name ?? "this document"}” for red flags` },
    ]);
    setScanning(true);
    try {
      const res = await api.scan(activeId);
      setMessages((m) => [
        ...m,
        {
          role: "scan",
          docName: res.doc_name,
          mode: res.mode,
          flags: res.flags,
          note: res.note,
        },
      ]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "error", text: err instanceof Error ? err.message : "Scan failed." },
      ]);
    } finally {
      setScanning(false);
    }
  };

  const handleCite = (source: Source) => {
    void openDoc(source.doc_id);
    setHighlight((prev) => ({
      docId: source.doc_id,
      page: source.page,
      start: source.start,
      end: source.end,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  };

  const activeDoc = docs.find((d) => d.id === activeId) ?? null;

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          Clause<span className="brand-dot">.</span>
        </span>
        <span className="tagline">
          Plain-English answers about confusing documents, with receipts.
        </span>
        <span className="topbar-right">
          {health &&
            (health.llm ? (
              <span className="badge ok" title={`Model: ${health.model}`}>
                ● {health.model}
              </span>
            ) : (
              <span
                className="badge warn"
                title="Set ANTHROPIC_API_KEY on the backend to enable plain-English answers"
              >
                ● no LLM key (passages only)
              </span>
            ))}
        </span>
      </header>

      <main className="layout">
        <section className="pane" aria-label="Document viewer">
          <DocToolbar
            docs={docs}
            activeId={activeId}
            uploading={uploading}
            onSelect={(id) => void openDoc(id)}
            onDelete={(id) => void handleDelete(id)}
            onUpload={(file) => void handleUpload(file)}
          />
          <DocViewer doc={activeDetail} highlight={highlight} />
        </section>

        <section className="pane" aria-label="Chat">
          <ChatPanel
            messages={messages}
            asking={asking}
            scanning={scanning}
            canScan={activeId !== null}
            docName={activeDoc?.name ?? null}
            multipleDocs={docs.length > 1}
            scope={scope}
            onScopeChange={setScope}
            onAsk={(q) => void handleAsk(q)}
            onScan={() => void handleScan()}
            onCite={handleCite}
          />
        </section>
      </main>
    </div>
  );
}
