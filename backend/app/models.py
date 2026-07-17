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


class Flag(BaseModel):
    """One clause worth noticing, with the exact text it came from."""

    category: str  # stable id, e.g. "auto_renewal"
    title: str  # human label, e.g. "Automatic renewal"
    # "high" | "medium" | "low" when an LLM judged it; "info" in extractive mode
    # (no key set, so Clause surfaces the passage but won't rate its severity).
    severity: str
    explanation: str  # plain-English why-it-matters; generic in extractive mode
    sources: list[Source]


class ScanResponse(BaseModel):
    doc_id: str
    doc_name: str
    # "llm"        -> an LLM judged which clauses are genuine risks
    # "extractive" -> no API key; passages that matched a risk category, unrated
    mode: str
    flags: list[Flag]
    note: str  # framing shown above the results (what this is / is not)


class Health(BaseModel):
    status: str
    llm: bool
    model: str | None
    embedder: str
