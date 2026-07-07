"""The "never guess" contract.

Three independent layers must each be able to force an abstention:
  1. Retrieval gate - nothing relevant retrieved => abstain WITHOUT calling the LLM.
  2. Model judgment - the LLM says the excerpts don't answer => abstain.
  3. Citation check - a "found" answer with no valid citations => abstain.
"""

from app.llm import ABSTAIN_MESSAGE, Answer, ask
from tests.conftest import FakeAnswerer

GIBBERISH = "quantum zebra harmonics flugelhorn recipe"


def test_irrelevant_question_abstains_without_llm_call(store, lease, fake_answerer):
    response = ask(store, fake_answerer, GIBBERISH)
    assert response.found is False
    assert response.mode == "abstain"
    assert "couldn't find" in response.answer
    assert fake_answerer.calls == [], "LLM must not be called when retrieval fails"


def test_llm_saying_not_found_abstains(store, lease):
    answerer = FakeAnswerer(
        Answer(found=False, answer="The excerpts don't cover parking.", citations=[])
    )
    response = ask(store, answerer, "What are the rules about rent payment?")
    assert response.found is False
    assert response.mode == "abstain"
    assert "parking" in response.answer
    assert len(answerer.calls) == 1, "retrieval passed, so the LLM should be consulted"


def test_found_answer_with_invalid_citations_is_downgraded(store, lease):
    answerer = FakeAnswerer(Answer(found=True, answer="Made up!", citations=[99, -1]))
    response = ask(store, answerer, "What is the late fee?")
    assert response.found is False
    assert response.mode == "abstain"
    assert response.answer == ABSTAIN_MESSAGE
    assert "Made up!" not in response.answer


def test_found_answer_with_no_citations_is_downgraded(store, lease):
    answerer = FakeAnswerer(Answer(found=True, answer="Trust me.", citations=[]))
    response = ask(store, answerer, "What is the late fee?")
    assert response.found is False
    assert response.mode == "abstain"


def test_valid_answer_passes_with_exact_receipts(store, lease):
    answerer = FakeAnswerer(
        Answer(found=True, answer="The late fee is $75 plus $10/day.", citations=[0])
    )
    response = ask(store, answerer, "What is the late fee if I pay rent late?")
    assert response.found is True
    assert response.mode == "llm"
    assert len(response.sources) == 1
    source = response.sources[0]
    # the receipt must be an exact, verifiable span of the original page
    page_text = lease.pages[source.page - 1]
    assert page_text[source.start : source.end] == source.quote
    assert "late fee" in source.quote.lower()


def test_citations_are_deduplicated_and_ordered(store, lease):
    answerer = FakeAnswerer(Answer(found=True, answer="ok", citations=[1, 0, 1, 0]))
    response = ask(store, answerer, "rent late fee and pet fee")
    assert response.found is True
    ids = [s.chunk_id for s in response.sources]
    assert len(ids) == len(set(ids)) == 2


def test_no_llm_key_returns_extractive_mode(store, lease):
    response = ask(store, None, "What is the late fee?")
    assert response.found is False
    assert response.mode == "extractive"
    assert response.sources, "extractive mode must still show the matching passages"


def test_abstain_still_shows_closest_passages_when_any_exist(store, lease):
    # "pet" overlaps the lease, so retrieval passes and the LLM gets consulted -
    # but deposits aren't in the excerpts, so it says not-found (layer 2)
    answerer = FakeAnswerer(Answer(found=False, answer="Not covered.", citations=[]))
    response = ask(store, answerer, "What deposit do I pay for a pet?")
    assert response.mode == "abstain"
    assert len(answerer.calls) == 1
    assert 1 <= len(response.sources) <= 3
