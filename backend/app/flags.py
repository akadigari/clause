"""Red-flags scan: point out clauses a person would want to notice, up front.

This is the proactive twin of ask(). Instead of waiting for the user to ask a
question, Clause checks the document against a fixed list of risk categories
(auto-renewal, penalties, arbitration, ...) and reports the clauses that
genuinely match - each with the exact text it came from.

It reuses the same safety checks as ask(), so the "never guess" rule holds
here too:

  1. Retrieval gate - each category is a search query; only chunks that clear
     the embedder's relevance threshold become candidates. A category with no
     relevant chunk is never flagged.
  2. Model judgment - with an LLM, the model sees only the candidate excerpts
     and decides which are real instances (a chunk that merely shares keywords
     is not a flag).
  3. Citation check - a finding whose citations don't point to a real
     candidate excerpt is dropped. No receipts, no flag.

Without an API key, it falls back to extractive mode: the top passage per
matched category is shown as-is and labelled "worth reviewing" - unrated,
because without a model Clause won't claim to judge how serious it is.
"""

import re
from dataclasses import dataclass

from .llm import Answerer, _source
from .models import Flag, Source, ScanResponse
from .store import DocumentStore, Retrieved

SCAN_NOTE = (
    "These are clauses worth reviewing, pulled straight from the document and "
    "shown with the exact text. Clause points them out and cites the source - "
    "it doesn't give legal advice, and it only flags what's actually written "
    "in the document."
)

EMPTY_NOTE = (
    "Clause didn't find any of the clauses it watches for in this document. "
    "That doesn't mean there's nothing to check - only that none of its "
    "risk categories clearly matched the text."
)

# Severity rank for sorting flags (high first). "info" is the extractive-mode
# label used when no LLM is available to judge severity.
_SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2, "info": 3}


@dataclass(frozen=True)
class RiskCategory:
    id: str
    title: str  # neutral topic label; works with or without an LLM to judge it
    # Keyword-rich retrieval probe. The default embedder is lexical, so these
    # deliberately spell out the words such clauses tend to use.
    probe: str
    # One-line description handed to the model to judge a genuine match.
    hint: str
    # Distinctive substrings (lowercase) for this topic. In extractive mode -
    # where there is no LLM to judge relevance - a category is only flagged
    # when a retrieved passage literally contains one of these. That keeps a
    # single shared word (e.g. "fee" turning up under "arbitration") from
    # producing a false flag against a passage that isn't actually on-topic.
    signals: tuple[str, ...]
    # Neutral, topic-level note shown in extractive mode. It describes what the
    # topic is and why to read it - never a claim about what THIS document
    # decides, because without a model Clause can't judge that.
    why: str


CATEGORIES: list[RiskCategory] = [
    RiskCategory(
        "auto_renewal",
        "Automatic renewal",
        "automatically renew renewal automatic renewal term renewed for "
        "successive periods continues unless you cancel auto-renew subscription "
        "renews notice before renewal",
        "the agreement renews on its own and keeps charging unless cancelled in time",
        ("renew", "automatically renew", "auto-renew"),
        "Renewal terms decide whether this keeps going - and keeps charging you "
        "- unless you cancel in time. Worth reading to know the deadline.",
    ),
    RiskCategory(
        "fees_penalties",
        "Fees and penalties",
        "fee fees late fee penalty charge charged additional charge service "
        "charge processing fee interest surcharge non-refundable",
        "fees, penalties, or extra charges the reader might not expect",
        ("fee", "penalty", "penalties", "late charge", "non-refundable", "$"),
        "This covers fees, penalties, or extra charges. Worth reading so none "
        "of them catch you by surprise.",
    ),
    RiskCategory(
        "cancellation",
        "Cancellation and termination",
        "termination terminate cancel cancellation early termination fee notice "
        "required days written notice end the agreement break the lease penalty "
        "for ending",
        "ending or cancelling is costly or requires long advance notice",
        ("terminat", "cancel", "cancellation"),
        "This covers how to end the agreement - the notice required and any "
        "cost to leave early. Worth reading before you need to get out.",
    ),
    RiskCategory(
        "arbitration",
        "Arbitration and legal rights",
        "arbitration arbitrate binding arbitration waive right to sue class "
        "action waiver jury trial dispute resolution governing law legal claims",
        "you give up the right to sue in court or to join a class action",
        ("arbitrat", "class action", "jury trial", "waive the right"),
        "Arbitration clauses can limit your right to sue in court or join a "
        "class action. Worth reading closely to see what you'd give up.",
    ),
    RiskCategory(
        "liability",
        "Liability and warranty",
        "limitation of liability not liable no warranty as is disclaim "
        "warranties indemnify indemnification hold harmless maximum liability "
        "damages",
        "they limit what they're responsible for, or provide no warranty",
        (
            "limitation of liability",
            "not liable",
            "as is",
            "hold harmless",
            "disclaim",
            "warrant",
            "indemnif",
        ),
        "This is where responsibility is capped and warranties are limited. "
        "Worth reading to see what you're on the hook for if something breaks.",
    ),
    RiskCategory(
        "unilateral_changes",
        "Changes to the terms",
        "we may change modify these terms at any time reserve the right to "
        "modify amend update the agreement revise terms with or without notice "
        "sole discretion",
        "they can change the terms whenever they want",
        (
            "change these terms",
            "update these terms",
            "modify these terms",
            "we may change",
            "we may update",
            "add, change, or remove",
            "sole discretion",
            "reserve the right",
        ),
        "This covers whether and how the terms can change later. Worth reading "
        "to know if what you agreed to today can shift.",
    ),
    RiskCategory(
        "data_sharing",
        "Data and privacy",
        "personal information data share sell third parties collect your data "
        "privacy marketing advertisers disclose information usage data",
        "your personal data can be shared, sold, or used broadly",
        (
            "personal information",
            "personal data",
            "third part",
            "sell your",
            "share your",
            "advertis",
            "privacy",
            "your data",
        ),
        "This covers how your personal information is collected, used, and "
        "shared. Worth reading to see where your data ends up.",
    ),
]

_BY_ID = {c.id: c for c in CATEGORIES}


def _candidates(
    store: DocumentStore, doc_id: str
) -> tuple[list[Retrieved], dict[str, list[Retrieved]]]:
    """Retrieve + gate per category.

    Returns the deduplicated candidate pool (order = first time each chunk was
    seen) and, per category id, the relevant chunks it matched (best first).
    """
    pool: list[Retrieved] = []
    seen: set[str] = set()
    per_category: dict[str, list[Retrieved]] = {}
    for cat in CATEGORIES:
        retrieved = store.query(cat.probe, doc_ids=[doc_id])
        relevant = [
            r
            for r in retrieved
            if store.embedder.is_relevant(cat.probe, r.chunk.text, r.score)
        ]
        if not relevant:
            continue
        per_category[cat.id] = relevant
        for r in relevant:
            if r.chunk.chunk_id not in seen:
                seen.add(r.chunk.chunk_id)
                pool.append(r)
    return pool, per_category


def _signal_hit(cat: RiskCategory, hits: list[Retrieved]) -> Retrieved | None:
    """Best retrieved chunk (hits are best-first) that literally contains one of
    the category's signal terms - the precision gate for extractive mode."""
    for r in hits:
        low = r.chunk.text.lower()
        if any(sig in low for sig in cat.signals):
            return r
    return None


# Only real sentence punctuation ends a clause - NOT the newlines that PDF
# extraction inserts at every visual line-wrap (those would shred sentences
# into fragments, and split a section heading off from the sentence it labels).
_SENTENCE_BOUNDARY = re.compile(r"[.!?](?:\s|$)")
_MAX_CLAUSE_CHARS = 320
_MAX_LEADIN_CHARS = 220


def _clause_source(doc, cat: RiskCategory, hit: Retrieved) -> Source:
    """Narrow a chunk hit down to the single sentence that actually mentions the
    topic, with exact page offsets so the citation is precise (not a 1,100-char
    block) and still a verbatim slice of the page.

    Falls back to the whole chunk if the signal can't be located exactly.
    """
    page_text = doc.pages[hit.chunk.page - 1]
    low = page_text.lower()

    # Earliest signal occurrence inside the matched chunk's span.
    pos = -1
    for sig in cat.signals:
        i = low.find(sig, hit.chunk.start, hit.chunk.end)
        if i != -1 and (pos == -1 or i < pos):
            pos = i
    if pos == -1:
        return _source(hit)

    # Sentence start: just after the previous boundary before the signal. If
    # that runs too far back (e.g. the signal sits in a heading with no nearby
    # period), clamp and re-align to a word start so the quote stays tight.
    start = 0
    for m in _SENTENCE_BOUNDARY.finditer(page_text, 0, pos):
        start = m.end()
    if pos - start > _MAX_LEADIN_CHARS:
        start = pos - _MAX_LEADIN_CHARS
        while start < pos and not page_text[start - 1].isspace():
            start += 1
    # Sentence end: the next boundary at or after the signal.
    end_match = _SENTENCE_BOUNDARY.search(page_text, pos)
    end = end_match.end() if end_match else len(page_text)

    while start < end and page_text[start].isspace():
        start += 1
    while end > start and page_text[end - 1].isspace():
        end -= 1
    end = min(end, start + _MAX_CLAUSE_CHARS)

    return Source(
        chunk_id=hit.chunk.chunk_id,
        doc_id=doc.id,
        doc_name=doc.name,
        page=hit.chunk.page,
        start=start,
        end=end,
        quote=page_text[start:end],
        score=round(hit.score, 4),
    )


def _sorted(flags: list[Flag]) -> list[Flag]:
    return sorted(flags, key=lambda f: _SEVERITY_RANK.get(f.severity, 9))


def scan(
    store: DocumentStore, answerer: Answerer | None, doc_id: str
) -> ScanResponse:
    doc = store.get(doc_id)
    if doc is None:  # caller checks first; guard keeps the type-checker happy
        raise ValueError("Document not found.")

    pool, per_category = _candidates(store, doc_id)

    # Extractive mode: no model to judge, so only surface a topic when a
    # retrieved passage actually contains one of its signal terms, and quote
    # that passage. Unrated ("info"), topic-level - never a claim about what
    # this specific document decides.
    if answerer is None:
        flags = []
        for cat_id, hits in per_category.items():
            cat = _BY_ID[cat_id]
            hit = _signal_hit(cat, hits)
            if hit is None:
                continue
            flags.append(
                Flag(
                    category=cat_id,
                    title=cat.title,
                    severity="info",
                    explanation=cat.why,
                    sources=[_clause_source(doc, cat, hit)],
                )
            )
        return ScanResponse(
            doc_id=doc.id,
            doc_name=doc.name,
            mode="extractive",
            flags=_sorted(flags),
            note=SCAN_NOTE if flags else EMPTY_NOTE,
        )

    if not pool:
        return ScanResponse(
            doc_id=doc.id, doc_name=doc.name, mode="llm", flags=[], note=EMPTY_NOTE
        )

    excerpts = [(r.chunk.chunk_id, r.chunk.text) for r in pool]
    candidate_cats = [(cid, _BY_ID[cid].hint) for cid in per_category]
    findings = answerer.find_flags(excerpts, candidate_cats)

    flags: list[Flag] = []
    for finding in findings:
        cat = _BY_ID.get(finding.category)
        if cat is None:  # model used a category id we didn't offer -> drop
            continue
        # Citation check: keep only citations that map to real pool excerpts.
        cited = [
            pool[i]
            for i in dict.fromkeys(finding.citations)
            if 0 <= i < len(pool)
        ]
        if not cited:  # a flag without receipts is not a flag
            continue
        severity = finding.severity if finding.severity in _SEVERITY_RANK else "medium"
        flags.append(
            Flag(
                category=cat.id,
                title=cat.title,
                severity=severity,
                explanation=finding.explanation.strip() or cat.why,
                sources=[_source(r) for r in cited],
            )
        )

    return ScanResponse(
        doc_id=doc.id,
        doc_name=doc.name,
        mode="llm",
        flags=_sorted(flags),
        note=SCAN_NOTE if flags else EMPTY_NOTE,
    )
