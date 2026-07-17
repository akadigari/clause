export interface PageText {
  page: number;
  text: string;
}

export interface DocumentMeta {
  id: string;
  name: string;
  pages: number;
  chunks: number;
  sample: boolean;
}

export interface DocumentDetail extends DocumentMeta {
  page_texts: PageText[];
}

export interface Source {
  chunk_id: string;
  doc_id: string;
  doc_name: string;
  page: number;
  start: number;
  end: number;
  quote: string;
  score: number;
}

export type AskMode = "llm" | "extractive" | "abstain";

export interface AskResponse {
  found: boolean;
  mode: AskMode;
  answer: string;
  sources: Source[];
}

export interface Health {
  status: string;
  llm: boolean;
  model: string | null;
  embedder: string;
}

export type Severity = "high" | "medium" | "low" | "info";

export interface Flag {
  category: string;
  title: string;
  severity: Severity;
  explanation: string;
  sources: Source[];
}

export interface ScanResponse {
  doc_id: string;
  doc_name: string;
  mode: "llm" | "extractive";
  flags: Flag[];
  note: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      /* keep default message */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => jsonOrThrow<Health>(r)),

  listDocuments: () =>
    fetch("/api/documents").then((r) => jsonOrThrow<DocumentMeta[]>(r)),

  getDocument: (id: string) =>
    fetch(`/api/documents/${id}`).then((r) => jsonOrThrow<DocumentDetail>(r)),

  uploadDocument: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/documents", { method: "POST", body: form }).then((r) =>
      jsonOrThrow<DocumentDetail>(r),
    );
  },

  deleteDocument: (id: string) =>
    fetch(`/api/documents/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error(`Delete failed (${r.status})`);
    }),

  ask: (question: string, docIds: string[] | null) =>
    fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, doc_ids: docIds }),
    }).then((r) => jsonOrThrow<AskResponse>(r)),

  scan: (docId: string) =>
    fetch(`/api/documents/${docId}/scan`, { method: "POST" }).then((r) =>
      jsonOrThrow<ScanResponse>(r),
    ),
};
