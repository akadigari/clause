"""Split page text into overlapping chunks while tracking exact character spans.

Invariant: for every chunk, ``page_text[chunk.start:chunk.end] == chunk.text``.
That guarantee is what lets the frontend highlight the exact source span of a
citation, so chunk boundaries are always cut from the original string - the
text is never rewritten, joined, or re-whitespaced.
"""

import re
from dataclasses import dataclass

from . import config

_PARA_BREAK = re.compile(r"\n{2,}")
_SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+")

Span = tuple[int, int]


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    doc_id: str
    page: int  # 1-based
    start: int  # offsets into the page's text
    end: int
    text: str


def _strip_span(text: str, start: int, end: int) -> Span | None:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    return (start, end) if end > start else None


def _paragraph_spans(text: str) -> list[Span]:
    spans: list[Span] = []
    pos = 0
    for match in _PARA_BREAK.finditer(text):
        if (span := _strip_span(text, pos, match.start())) is not None:
            spans.append(span)
        pos = match.end()
    if (span := _strip_span(text, pos, len(text))) is not None:
        spans.append(span)
    return spans


def _sentence_spans(text: str, start: int, end: int, hard_max: int) -> list[Span]:
    """Split an oversized paragraph on sentence boundaries (hard-cut as a last resort)."""
    sentences: list[Span] = []
    pos = start
    for match in _SENTENCE_BREAK.finditer(text, start, end):
        if (span := _strip_span(text, pos, match.start())) is not None:
            sentences.append(span)
        pos = match.end()
    if (span := _strip_span(text, pos, end)) is not None:
        sentences.append(span)

    result: list[Span] = []
    for s, e in sentences:
        while e - s > hard_max:
            result.append((s, s + hard_max))
            s += hard_max
        result.append((s, e))
    return result


def chunk_page(
    text: str,
    *,
    doc_id: str,
    page: int,
    target: int = config.CHUNK_TARGET_CHARS,
    overlap: int = config.CHUNK_OVERLAP_CHARS,
    hard_max: int = config.CHUNK_HARD_MAX_CHARS,
) -> list[Chunk]:
    """Greedily pack paragraphs into ~target-char chunks with ~overlap-char overlap."""
    units: list[Span] = []
    for s, e in _paragraph_spans(text):
        if e - s <= hard_max:
            units.append((s, e))
        else:
            units.extend(_sentence_spans(text, s, e, hard_max))

    if not units:
        return []

    spans: list[Span] = []
    i = 0
    while i < len(units):
        j = i
        while j + 1 < len(units) and units[j + 1][1] - units[i][0] <= target:
            j += 1
        chunk_start, chunk_end = units[i][0], units[j][1]
        spans.append((chunk_start, chunk_end))
        if j + 1 >= len(units):
            break
        # Start the next chunk at the earliest unit that keeps the overlap
        # within budget; always advance past unit i so we make progress.
        k = j + 1
        while k - 1 > i and chunk_end - units[k - 1][0] <= overlap:
            k -= 1
        i = k

    return [
        Chunk(
            chunk_id=f"{doc_id}:{page}:{idx}",
            doc_id=doc_id,
            page=page,
            start=s,
            end=e,
            text=text[s:e],
        )
        for idx, (s, e) in enumerate(spans)
    ]


def chunk_document(doc_id: str, pages: list[str], **kwargs) -> list[Chunk]:
    chunks: list[Chunk] = []
    for page_index, text in enumerate(pages, start=1):
        chunks.extend(chunk_page(text, doc_id=doc_id, page=page_index, **kwargs))
    return chunks
