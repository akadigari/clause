"""The red-flags scan keeps the same "never guess" contract as ask().

A flag may only exist if (1) a risk-category probe retrieved a relevant chunk,
(2) the model judged it a genuine instance, and (3) that judgment cites a real
candidate excerpt. Break any link and the flag disappears.
"""

from app.flags import scan
from app.llm import FlagFinding
from tests.conftest import FakeAnswerer

BENIGN_PAGES = [
    "The sky is blue on a clear day. Water is wet. Birds tend to sing at "
    "dawn, and the grass turns green after rain."
]


def test_extractive_scan_surfaces_matched_categories(store, lease):
    # No answerer at all -> extractive mode: passages, unrated, verbatim.
    response = scan(store, None, lease.id)
    assert response.mode == "extractive"
    assert response.flags, "the lease has fees and an early-termination clause"
    for flag in response.flags:
        assert flag.severity == "info"  # no model, so no severity claim
        assert flag.sources
        # every receipt is an exact, verifiable slice of the original page
        for src in flag.sources:
            page_text = lease.pages[src.page - 1]
            assert page_text[src.start : src.end] == src.quote


def test_llm_scan_returns_grounded_flags(store, lease):
    answerer = FakeAnswerer(
        flags=[
            FlagFinding(
                category="fees_penalties",
                severity="high",
                explanation="Late rent costs $75 plus $10/day, up to $250.",
                citations=[0],
            )
        ]
    )
    response = scan(store, answerer, lease.id)
    assert response.mode == "llm"
    assert len(answerer.flag_calls) == 1, "the model should be consulted once"
    assert len(response.flags) == 1
    flag = response.flags[0]
    assert flag.category == "fees_penalties"
    assert flag.title == "Fees and penalties"
    assert flag.severity == "high"
    src = flag.sources[0]
    assert lease.pages[src.page - 1][src.start : src.end] == src.quote


def test_flag_with_invalid_citations_is_dropped(store, lease):
    answerer = FakeAnswerer(
        flags=[
            FlagFinding("fees_penalties", "high", "Made up.", citations=[99, -1])
        ]
    )
    response = scan(store, answerer, lease.id)
    assert response.flags == []  # no receipts, no flag
    assert response.note  # still explains why nothing showed


def test_unknown_category_is_dropped(store, lease):
    answerer = FakeAnswerer(
        flags=[FlagFinding("totally_made_up", "high", "Nope.", citations=[0])]
    )
    response = scan(store, answerer, lease.id)
    assert response.flags == []


def test_no_matching_clauses_returns_empty_without_calling_llm(store):
    doc = store.add_document("Benign.pdf", BENIGN_PAGES)
    answerer = FakeAnswerer(
        flags=[FlagFinding("fees_penalties", "high", "x", citations=[0])]
    )
    response = scan(store, answerer, doc.id)
    assert response.flags == []
    assert answerer.flag_calls == [], "nothing relevant retrieved -> no LLM call"


def test_scan_endpoint_returns_flags(client, lease):
    res = client.post(f"/api/documents/{lease.id}/scan")
    assert res.status_code == 200
    body = res.json()
    assert body["doc_id"] == lease.id
    assert body["mode"] in {"llm", "extractive"}
    assert "note" in body and isinstance(body["flags"], list)


def test_scan_endpoint_404_for_unknown_document(client):
    res = client.post("/api/documents/doc-does-not-exist/scan")
    assert res.status_code == 404
