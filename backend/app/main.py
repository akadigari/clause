"""Clause API.

Endpoints:
    GET    /api/health
    GET    /api/documents
    POST   /api/documents        (multipart PDF upload)
    GET    /api/documents/{id}
    DELETE /api/documents/{id}
    POST   /api/ask
    POST   /api/documents/{id}/scan   (red-flags scan)
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .embedding import get_embedder
from .flags import scan
from .llm import Answerer, AnswererError, ClaudeAnswerer, ask
from .models import (
    AskRequest,
    AskResponse,
    DocumentDetail,
    DocumentMeta,
    Health,
    PageText,
    ScanResponse,
)
from .pdf_parser import PdfParseError, extract_pages
from .store import DocumentStore, StoredDoc

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"


def _meta(doc: StoredDoc) -> DocumentMeta:
    return DocumentMeta(
        id=doc.id, name=doc.name, pages=len(doc.pages), chunks=len(doc.chunks),
        sample=doc.sample,
    )


def _detail(doc: StoredDoc) -> DocumentDetail:
    return DocumentDetail(
        **_meta(doc).model_dump(),
        page_texts=[PageText(page=i, text=t) for i, t in enumerate(doc.pages, start=1)],
    )


def load_samples(store: DocumentStore, samples_dir: Path = SAMPLES_DIR) -> None:
    for pdf_path in sorted(samples_dir.glob("*.pdf")):
        name = pdf_path.stem.replace("-", " ").replace("_", " ").title()
        store.add_document(name, extract_pages(pdf_path.read_bytes()), sample=True)


def create_app(
    store: DocumentStore | None = None,
    answerer: Answerer | None = None,
    *,
    with_samples: bool = True,
) -> FastAPI:
    store = store or DocumentStore(get_embedder())
    if answerer is None and os.environ.get("ANTHROPIC_API_KEY"):
        answerer = ClaudeAnswerer()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if with_samples and SAMPLES_DIR.is_dir():
            load_samples(store)
        yield

    app = FastAPI(title="Clause", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        return Health(
            status="ok",
            llm=answerer is not None,
            model=getattr(answerer, "model", None),
            embedder=store.embedder.name,
        )

    @app.get("/api/documents", response_model=list[DocumentMeta])
    def list_documents() -> list[DocumentMeta]:
        return [_meta(d) for d in store.list()]

    @app.post("/api/documents", response_model=DocumentDetail, status_code=201)
    async def upload_document(file: UploadFile) -> DocumentDetail:
        if not (file.filename or "").lower().endswith(".pdf"):
            raise HTTPException(400, "Only PDF files are supported.")
        data = await file.read()
        if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
            raise HTTPException(413, f"PDF is larger than {config.MAX_UPLOAD_MB}MB.")
        if not data.startswith(b"%PDF"):
            raise HTTPException(400, "That file doesn't look like a PDF.")
        try:
            pages = extract_pages(data)
        except PdfParseError as exc:
            raise HTTPException(400, str(exc)) from exc
        if len(pages) > config.MAX_PAGES:
            raise HTTPException(413, f"PDF has more than {config.MAX_PAGES} pages.")
        try:
            doc = store.add_document(file.filename or "Untitled.pdf", pages)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return _detail(doc)

    @app.get("/api/documents/{doc_id}", response_model=DocumentDetail)
    def get_document(doc_id: str) -> DocumentDetail:
        doc = store.get(doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found (uploads expire after an hour).")
        return _detail(doc)

    @app.delete("/api/documents/{doc_id}", status_code=204)
    def delete_document(doc_id: str) -> None:
        doc = store.get(doc_id)
        if doc is None:
            raise HTTPException(404, "Document not found.")
        if doc.sample:
            raise HTTPException(403, "Sample documents can't be deleted.")
        store.delete(doc_id)

    @app.post("/api/ask", response_model=AskResponse)
    def ask_question(request: AskRequest) -> AskResponse:
        if request.doc_ids is not None:
            missing = [d for d in request.doc_ids if store.get(d) is None]
            if missing:
                raise HTTPException(
                    404, "Document not found (uploads expire after an hour)."
                )
        try:
            return ask(store, answerer, request.question, request.doc_ids)
        except AnswererError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/documents/{doc_id}/scan", response_model=ScanResponse)
    def scan_document(doc_id: str) -> ScanResponse:
        if store.get(doc_id) is None:
            raise HTTPException(404, "Document not found (uploads expire after an hour).")
        try:
            return scan(store, answerer, doc_id)
        except AnswererError as exc:
            raise HTTPException(502, str(exc)) from exc

    return app


app = create_app()
