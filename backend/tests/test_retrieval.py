"""Retrieval: the right chunk, from the right page, from the right document."""


def test_query_finds_the_relevant_chunk_and_page(store, lease):
    results = store.query("Am I allowed to keep a pet?")
    assert results, "expected at least one hit"
    top = results[0]
    assert "pets" in top.chunk.text.lower()
    assert top.chunk.page == 2  # the pets clause lives on page 2 of the fixture


def test_query_scores_are_sorted_descending(store, lease):
    results = store.query("late fee for paying rent after the fifth")
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)
    assert "late" in results[0].chunk.text.lower()


def test_quote_matches_exact_page_span(store, lease):
    """A citation must be reproducible: quote == page_text[start:end]."""
    for r in store.query("early termination fee"):
        page_text = r.doc.pages[r.chunk.page - 1]
        assert page_text[r.chunk.start : r.chunk.end] == r.chunk.text


def test_multi_document_query_picks_the_right_doc(store, lease, manual):
    results = store.query("how long is the blender motor warranty")
    assert results[0].doc.id == manual.id
    assert "warranty" in results[0].chunk.text.lower()

    results = store.query("what is the late fee on rent")
    assert results[0].doc.id == lease.id


def test_doc_ids_filter_restricts_search(store, lease, manual):
    results = store.query("how long is the warranty", doc_ids=[lease.id])
    assert all(r.doc.id == lease.id for r in results)


def test_top_k_limits_results(store, lease, manual):
    results = store.query("rent and fees", top_k=2)
    assert len(results) <= 2


def test_unknown_doc_filter_returns_nothing(store, lease):
    assert store.query("rent", doc_ids=["doc-does-not-exist"]) == []


def test_deleted_document_is_not_searchable(store, lease):
    assert store.query("late fee")[0].doc.id == lease.id
    store.delete(lease.id)
    assert store.query("late fee") == []
    assert store.get(lease.id) is None
