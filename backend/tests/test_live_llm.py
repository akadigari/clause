"""Live smoke test against the real Anthropic API.

Everything else in this suite uses a scripted FakeAnswerer, so the actual API
call - auth, the configured model, structured-output JSON, the grounding
round-trip - is never exercised by `pytest` alone. This module fills that gap.

It is SKIPPED unless ANTHROPIC_API_KEY is set, so the default suite stays
offline, free, and deterministic. To run it:

    export ANTHROPIC_API_KEY=sk-ant-...
    # optionally: export CLAUSE_MODEL=claude-...   (if the default isn't on your key)
    pytest backend/tests/test_live_llm.py -v

Assertions stay structural (grounded? exact-slice citations? honest abstain?)
rather than checking exact wording, since real model output varies.
"""

import os

import pytest

from app.flags import scan
from app.llm import ClaudeAnswerer, ask

pytestmark = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="live LLM test: set ANTHROPIC_API_KEY to run",
)


@pytest.fixture
def live_answerer() -> ClaudeAnswerer:
    # Reads ANTHROPIC_API_KEY (and CLAUSE_MODEL) from the environment.
    return ClaudeAnswerer()


def test_live_answer_is_grounded(store, lease, live_answerer):
    """A question the lease actually answers -> a real answer whose every
    citation is a verbatim slice of the page it points to."""
    resp = ask(store, live_answerer, "What is the late fee if I pay rent late?", [lease.id])
    assert resp.found is True
    assert resp.mode == "llm"
    assert resp.sources, "a found answer must carry its receipts"
    for s in resp.sources:
        assert lease.pages[s.page - 1][s.start : s.end] == s.quote


def test_live_abstains_on_absent_topic(store, lease, live_answerer):
    """The lease says nothing about parking, so Clause must NOT invent an
    answer - whether the retrieval gate or the model's own judgment catches it,
    the result is an honest abstention."""
    resp = ask(store, live_answerer, "Does this lease let me park a car in the garage?", [lease.id])
    assert resp.found is False
    assert resp.mode == "abstain"


def test_live_scan_returns_rated_grounded_flags(store, lease, live_answerer):
    """The real scan should rate the flags it returns and cite exact clauses."""
    resp = scan(store, live_answerer, lease.id)
    assert resp.mode == "llm"
    assert isinstance(resp.flags, list)
    for f in resp.flags:
        assert f.severity in {"high", "medium", "low"}
        assert f.sources, "a flag without receipts should have been dropped"
        for s in f.sources:
            assert lease.pages[s.page - 1][s.start : s.end] == s.quote
