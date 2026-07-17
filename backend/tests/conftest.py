import io

import pytest
from fastapi.testclient import TestClient
from fpdf import FPDF

from app.embedding import HashingEmbedder
from app.llm import Answer, FlagFinding
from app.main import create_app
from app.store import DocumentStore, StoredDoc


def make_pdf(pages: list[list[str]]) -> bytes:
    """Build a small in-memory PDF; each inner list is one page of paragraphs."""
    pdf = FPDF(format="letter")
    pdf.set_auto_page_break(auto=False)
    pdf.set_margins(20, 20, 20)
    pdf.set_font("helvetica", "", 11)
    for paragraphs in pages:
        pdf.add_page()
        for para in paragraphs:
            pdf.multi_cell(0, 6, para, new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
    return bytes(pdf.output())


class FakeAnswerer:
    """Scripted stand-in for ClaudeAnswerer; records every call."""

    def __init__(
        self,
        result: Answer | None = None,
        flags: list[FlagFinding] | None = None,
    ):
        self.result = result or Answer(found=True, answer="stub", citations=[0])
        self.flags = flags or []
        self.calls: list[tuple[str, list[tuple[str, str]]]] = []
        self.flag_calls: list[tuple[list[tuple[str, str]], list[tuple[str, str]]]] = []

    def answer(self, question, excerpts):
        self.calls.append((question, excerpts))
        return self.result

    def find_flags(self, excerpts, categories):
        self.flag_calls.append((excerpts, categories))
        return self.flags


LEASE_PAGES = [
    "Section 3. Rent. Monthly rent is $1,850 due on the first day of each "
    "month. If rent is not received by the fifth day, the tenant pays a late "
    "fee of $75 plus $10 per additional day, capped at $250 per month.",
    "Section 7. Pets. No pets are permitted without prior written consent. "
    "An approved pet requires a one-time fee of $300 and pet rent of $40 per "
    "month.",
    "Section 12. Early Termination. Ending the lease early requires sixty "
    "days written notice and an early termination fee equal to two months "
    "of rent.",
]

MANUAL_PAGES = [
    "Blender Care. Wash the pitcher by hand with warm soapy water. The "
    "blade assembly is not dishwasher safe.",
    "Warranty. The blender motor is covered for five years from the date of "
    "purchase. Register the product online to activate coverage.",
]


@pytest.fixture
def store() -> DocumentStore:
    return DocumentStore(HashingEmbedder())


@pytest.fixture
def lease(store) -> StoredDoc:
    # one page per clause so retrieval assertions can check page numbers
    return store.add_document("Test Lease.pdf", LEASE_PAGES)


@pytest.fixture
def manual(store) -> StoredDoc:
    return store.add_document("Blender Manual.pdf", MANUAL_PAGES)


@pytest.fixture
def fake_answerer() -> FakeAnswerer:
    return FakeAnswerer()


@pytest.fixture
def client(store, fake_answerer) -> TestClient:
    app = create_app(store=store, answerer=fake_answerer, with_samples=False)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def keyless_client(store, monkeypatch) -> TestClient:
    """App with no LLM configured at all (extractive mode)."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    app = create_app(store=store, answerer=None, with_samples=False)
    with TestClient(app) as test_client:
        yield test_client
