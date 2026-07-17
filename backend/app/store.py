"""In-memory document store + Chroma vector index.

Privacy model: everything lives in RAM. Uploaded PDFs are parsed, chunked,
embedded, and the raw bytes discarded; nothing is written to disk. Uploaded
documents expire after a TTL; bundled sample documents never expire. The
Chroma client is ephemeral, so the vector index also vanishes on restart.
"""

# This class has both a method named list() and type hints like list[str].
# Without this import, Python checks those type hints the moment it reads the
# class - and at that moment, "list" means our list() method, not Python's
# built-in list type, which crashes the import. This import tells Python to
# check type hints later instead, so it sees the real list type. (Python
# 3.14+ does this automatically; we add it so older Python versions work too.)
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

import chromadb

from . import config
from .chunking import Chunk, chunk_document
from .embedding import Embedder


@dataclass
class StoredDoc:
    id: str
    name: str
    pages: list[str]  # page text, index 0 = page 1
    chunks: dict[str, Chunk]  # chunk_id -> Chunk
    sample: bool
    created_at: float = field(default_factory=time.time)


@dataclass(frozen=True)
class Retrieved:
    chunk: Chunk
    doc: StoredDoc
    score: float  # 1 - cosine distance, clamped to [0, 1]


class DocumentStore:
    def __init__(self, embedder: Embedder, ttl_seconds: int = config.DOC_TTL_SECONDS):
        self.embedder = embedder
        self.ttl_seconds = ttl_seconds
        self._client = chromadb.EphemeralClient()
        self._docs: dict[str, StoredDoc] = {}

    # -- lifecycle ---------------------------------------------------------

    def add_document(self, name: str, pages: list[str], *, sample: bool = False) -> StoredDoc:
        doc_id = f"doc-{uuid.uuid4().hex[:12]}"
        chunks = chunk_document(doc_id, pages)
        if not chunks:
            raise ValueError("Document contains no extractable text.")

        collection = self._client.create_collection(
            doc_id, metadata={"hnsw:space": "cosine"}
        )
        collection.add(
            ids=[c.chunk_id for c in chunks],
            embeddings=self.embedder.embed([c.text for c in chunks]),
            metadatas=[{"page": c.page, "start": c.start, "end": c.end} for c in chunks],
        )

        doc = StoredDoc(
            id=doc_id,
            name=name,
            pages=pages,
            chunks={c.chunk_id: c for c in chunks},
            sample=sample,
        )
        self._docs[doc_id] = doc
        return doc

    def get(self, doc_id: str) -> StoredDoc | None:
        self.sweep_expired()
        return self._docs.get(doc_id)

    def list(self) -> list[StoredDoc]:
        self.sweep_expired()
        return sorted(self._docs.values(), key=lambda d: (not d.sample, d.created_at))

    def delete(self, doc_id: str) -> None:
        self._client.delete_collection(doc_id)
        del self._docs[doc_id]

    def sweep_expired(self) -> None:
        cutoff = time.time() - self.ttl_seconds
        expired = [
            d.id for d in self._docs.values() if not d.sample and d.created_at < cutoff
        ]
        for doc_id in expired:
            self.delete(doc_id)

    # -- retrieval ---------------------------------------------------------

    def query(
        self,
        question: str,
        doc_ids: list[str] | None = None,
        top_k: int = config.TOP_K,
    ) -> list[Retrieved]:
        """Top-k most relevant chunks across the given documents, best first."""
        self.sweep_expired()
        targets = (
            [self._docs[d] for d in doc_ids if d in self._docs]
            if doc_ids is not None
            else list(self._docs.values())
        )
        if not targets:
            return []

        query_embedding = self.embedder.embed([question])[0]
        results: list[Retrieved] = []
        for doc in targets:
            collection = self._client.get_collection(doc.id)
            hits = collection.query(
                query_embeddings=[query_embedding],
                n_results=min(top_k, len(doc.chunks)),
                include=["distances"],
            )
            for chunk_id, distance in zip(hits["ids"][0], hits["distances"][0]):
                score = max(0.0, min(1.0, 1.0 - distance))
                results.append(Retrieved(chunk=doc.chunks[chunk_id], doc=doc, score=score))

        results.sort(key=lambda r: r.score, reverse=True)
        return results[:top_k]
