"""Pydantic schemas shared by the API layer."""

from pydantic import BaseModel, Field


class PageText(BaseModel):
    page: int  # 1-based
    text: str


class DocumentMeta(BaseModel):
    id: str
    name: str
    pages: int
    chunks: int
    sample: bool


class DocumentDetail(DocumentMeta):
    page_texts: list[PageText]


class Source(BaseModel):
    """One receipt: an exact span of the original document."""

    chunk_id: str
    doc_id: str
    doc_name: str
    page: int  # 1-based
    start: int  # character offset into that page's extracted text
    end: int
    quote: str  # exactly page_text[start:end]
    score: float  # relevance in [0, 1]


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    doc_ids: list[str] | None = None  # None => search every document


class AskResponse(BaseModel):
    found: bool
    # "llm"        -> answer written by the model, sources are its citations
    # "extractive" -> no API key configured; sources are the closest passages
    # "abstain"    -> the answer is not in the document(s)
    mode: str
    answer: str
    sources: list[Source]


class Health(BaseModel):
    status: str
    llm: bool
    model: str | None
    embedder: str
