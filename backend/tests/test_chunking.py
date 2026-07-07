"""The chunker's contract: exact spans, full coverage, bounded sizes, overlap."""

from app.chunking import chunk_document, chunk_page

LOREM_SENTENCES = (
    "The tenant shall maintain the premises in good condition. "
    "Rent is due on the first of the month without demand. "
    "Late payments accrue a fee as described in section three. "
    "The landlord shall provide notice before entry. "
)

MULTI_PARA_PAGE = (
    "Section 1. Introduction.\n"
    "This agreement covers the rental of the apartment.\n\n"
    "Section 2. Rent and Fees.\n"
    "Monthly rent is $1,850 due on the first. A late fee of $75 applies "
    "after the fifth day of the month.\n\n"
    "Section 3. Security Deposit.\n"
    "The deposit is $2,775 and is returned within 21 days of move-out."
)


def test_chunk_text_is_exact_span_of_page():
    """The invariant everything else depends on: chunk.text is a literal slice."""
    long_page = LOREM_SENTENCES * 40
    for chunk in chunk_page(long_page, doc_id="d", page=1):
        assert long_page[chunk.start : chunk.end] == chunk.text


def test_chunks_cover_all_content():
    long_page = (LOREM_SENTENCES + "\n\n") * 20
    chunks = chunk_page(long_page, doc_id="d", page=1)
    covered = set()
    for c in chunks:
        covered.update(range(c.start, c.end))
    uncovered = [
        i for i, ch in enumerate(long_page) if not ch.isspace() and i not in covered
    ]
    assert uncovered == []


def test_chunk_sizes_bounded():
    long_page = LOREM_SENTENCES * 60
    chunks = chunk_page(long_page, doc_id="d", page=1, target=800, hard_max=1600)
    assert len(chunks) > 1
    assert all(len(c.text) <= 1600 for c in chunks)


def test_no_content_falls_between_consecutive_chunks():
    long_page = (LOREM_SENTENCES + "\n\n") * 30
    chunks = chunk_page(long_page, doc_id="d", page=1, target=600, overlap=150)
    assert len(chunks) > 1
    for prev, nxt in zip(chunks, chunks[1:]):
        # anything between two chunks is pure whitespace (a paragraph break)
        assert long_page[prev.end : max(prev.end, nxt.start)].strip() == ""
        assert nxt.start > prev.start  # always forward progress


def test_sentence_level_overlap_carries_context_across_chunks():
    # a single giant paragraph forces sentence-sized units, small enough for
    # the overlap walk-back to actually re-include trailing sentences
    long_page = LOREM_SENTENCES * 30
    chunks = chunk_page(long_page, doc_id="d", page=1, target=600, overlap=150)
    assert len(chunks) > 1
    overlapping = [
        (prev, nxt) for prev, nxt in zip(chunks, chunks[1:]) if nxt.start < prev.end
    ]
    assert overlapping, "expected at least one overlapping pair"
    for prev, nxt in overlapping:
        assert prev.end - nxt.start <= 150  # overlap stays within budget


def test_giant_unbroken_paragraph_is_split():
    page = "x" * 5000  # no whitespace at all: forces hard character splits
    chunks = chunk_page(page, doc_id="d", page=1, target=1000, hard_max=1000)
    assert len(chunks) >= 5
    assert all(len(c.text) <= 1000 for c in chunks)
    assert all(page[c.start : c.end] == c.text for c in chunks)


def test_small_page_is_single_chunk_with_paragraphs():
    chunks = chunk_page(MULTI_PARA_PAGE, doc_id="d", page=1, target=2000)
    assert len(chunks) == 1
    assert "Section 1" in chunks[0].text and "Section 3" in chunks[0].text


def test_empty_and_whitespace_pages_produce_no_chunks():
    assert chunk_page("", doc_id="d", page=1) == []
    assert chunk_page("   \n\n   ", doc_id="d", page=1) == []


def test_chunk_document_tracks_page_numbers():
    pages = ["First page about rent.", "", "Third page about pets."]
    chunks = chunk_document("doc-1", pages)
    assert {c.page for c in chunks} == {1, 3}
    assert all(c.doc_id == "doc-1" for c in chunks)
    by_page = {c.page: c for c in chunks}
    assert "rent" in by_page[1].text
    assert "pets" in by_page[3].text


def test_chunk_ids_are_unique():
    pages = [LOREM_SENTENCES * 30, LOREM_SENTENCES * 30]
    chunks = chunk_document("doc-1", pages)
    ids = [c.chunk_id for c in chunks]
    assert len(ids) == len(set(ids))
