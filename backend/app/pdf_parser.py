"""PDF -> per-page text extraction.

The extracted text for each page is the canonical text for that page:
chunk character spans, citation offsets, and the frontend document viewer
all refer to offsets into these exact strings, so extraction must be
deterministic and no downstream step may re-normalize.
"""

import io
import re

from pypdf import PdfReader


class PdfParseError(Exception):
    pass


_CRLF = re.compile(r"\r\n?")
_MANY_BLANK = re.compile(r"\n{3,}")


def _normalize(text: str) -> str:
    text = _CRLF.sub("\n", text)
    text = _MANY_BLANK.sub("\n\n", text)
    return text.strip("\n")


def extract_pages(data: bytes) -> list[str]:
    """Return the text of each page (1-based page = index + 1)."""
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [_normalize(page.extract_text() or "") for page in reader.pages]
    except Exception as exc:
        raise PdfParseError(f"Could not read this PDF: {exc}") from exc

    if not pages:
        raise PdfParseError("This PDF has no pages.")
    if not any(p.strip() for p in pages):
        raise PdfParseError(
            "No text could be extracted from this PDF. It may be a scanned "
            "image; run it through OCR first."
        )
    return pages
