"""The answering layer.

ClaudeAnswerer sends ONLY the retrieved excerpts to the model (never the whole
document) and forces a JSON response via structured outputs:

    {found: bool, answer: str, citations: [excerpt indices]}

Two guarantees are enforced *outside* the model, in ask():
  1. Retrieval gate - if no retrieved chunk clears the embedder's relevance
     threshold, Clause abstains without calling the LLM at all.
  2. Citation check - a "found" answer whose citations don't map to real
     retrieved excerpts is downgraded to an abstention. No receipts, no answer.
"""

import json
from dataclasses import dataclass
from typing import Protocol

from . import config
from .models import AskResponse, Source
from .store import DocumentStore, Retrieved

ABSTAIN_MESSAGE = (
    "I couldn't find that in this document. It may be covered somewhere I "
    "didn't retrieve, or it simply may not be addressed - try rephrasing, or "
    "check the sections below that came closest."
)

NO_LLM_NOTE = (
    "Clause is running without an LLM API key, so I can't write a plain-"
    "English answer - but here are the exact passages from the document that "
    "best match your question."
)

SYSTEM_PROMPT = """You are Clause, an assistant that explains confusing documents \
(leases, contracts, terms of service, insurance policies, manuals) to ordinary \
people in plain English.

You will receive a question and a numbered list of excerpts from the user's \
document. The excerpts are the ONLY thing you know about this document.

Rules, in priority order:
1. Never invent or assume anything that is not stated in the excerpts. Do not \
use outside knowledge about laws, typical contracts, or common practices to \
fill gaps.
2. If the excerpts do not actually answer the question, set "found" to false. \
A topically related excerpt that doesn't answer the question is NOT an answer.
3. When you do answer, set "found" to true, and cite every excerpt you relied \
on by its number in "citations". Only list excerpts you actually used.
4. Write for a smart friend, not a lawyer: short sentences, everyday words, \
and concrete numbers/dates/amounts quoted from the document. Explain any \
unavoidable legal term in parentheses.
5. If the document's answer has an important catch or condition in the \
excerpts (deadlines, fees, exceptions), mention it - that's usually what the \
user really needs to know.
6. You explain what the document says; you do not give legal advice. Do not \
add disclaimers saying so - just stick to the document.

Respond with JSON: {"found": boolean, "answer": string, "citations": number[]}. \
When "found" is false, "answer" should briefly say the document excerpts don't \
cover it, and "citations" must be empty."""

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "found": {"type": "boolean"},
        "answer": {"type": "string"},
        "citations": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["found", "answer", "citations"],
    "additionalProperties": False,
}


@dataclass
class Answer:
    found: bool
    answer: str
    citations: list[int]  # indices into the excerpt list passed to answer()


# An excerpt is (label, text), e.g. ("Sample Lease, page 3", "...clause text...")
Excerpt = tuple[str, str]


class Answerer(Protocol):
    def answer(self, question: str, excerpts: list[Excerpt]) -> Answer: ...


class AnswererError(Exception):
    """The LLM call failed; the API layer turns this into a 502."""


class ClaudeAnswerer:
    def __init__(self, model: str = config.MODEL):
        import anthropic

        self.model = model
        self._client = anthropic.Anthropic()
        self._anthropic = anthropic

    def answer(self, question: str, excerpts: list[Excerpt]) -> Answer:
        numbered = "\n\n".join(
            f"[Excerpt {i}] (from {label})\n{text}"
            for i, (label, text) in enumerate(excerpts)
        )
        prompt = (
            f"Document excerpts:\n\n{numbered}\n\n"
            f"Question: {question.strip()}"
        )
        try:
            response = self._client.messages.create(
                model=self.model,
                max_tokens=config.MAX_ANSWER_TOKENS,
                system=SYSTEM_PROMPT,
                thinking={"type": "adaptive"},
                output_config={"format": {"type": "json_schema", "schema": ANSWER_SCHEMA}},
                messages=[{"role": "user", "content": prompt}],
            )
        except self._anthropic.AuthenticationError as exc:
            raise AnswererError(f"Anthropic API key was rejected: {exc}") from exc
        except self._anthropic.APIStatusError as exc:
            raise AnswererError(f"LLM request failed ({exc.status_code}): {exc.message}") from exc
        except self._anthropic.APIConnectionError as exc:
            raise AnswererError(f"Could not reach the Anthropic API: {exc}") from exc

        if response.stop_reason == "refusal":
            return Answer(found=False, answer=ABSTAIN_MESSAGE, citations=[])

        text = next((b.text for b in response.content if b.type == "text"), "")
        try:
            data = json.loads(text)
            return Answer(
                found=bool(data["found"]),
                answer=str(data["answer"]),
                citations=[int(i) for i in data["citations"]],
            )
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
            raise AnswererError(f"LLM returned an unparseable answer: {exc}") from exc


def _source(r: Retrieved) -> Source:
    return Source(
        chunk_id=r.chunk.chunk_id,
        doc_id=r.doc.id,
        doc_name=r.doc.name,
        page=r.chunk.page,
        start=r.chunk.start,
        end=r.chunk.end,
        quote=r.chunk.text,
        score=round(r.score, 4),
    )


def ask(
    store: DocumentStore,
    answerer: Answerer | None,
    question: str,
    doc_ids: list[str] | None = None,
) -> AskResponse:
    retrieved = store.query(question, doc_ids=doc_ids)

    # Layer 1: retrieval gate. Nothing relevant enough -> abstain, no LLM call.
    relevant = [
        r for r in retrieved
        if store.embedder.is_relevant(question, r.chunk.text, r.score)
    ]
    if not relevant:
        return AskResponse(
            found=False,
            mode="abstain",
            answer=ABSTAIN_MESSAGE,
            sources=[_source(r) for r in retrieved[:3]],
        )

    if answerer is None:
        return AskResponse(
            found=False,
            mode="extractive",
            answer=NO_LLM_NOTE,
            sources=[_source(r) for r in relevant],
        )

    excerpts = [
        (f"{r.doc.name}, page {r.chunk.page}", r.chunk.text) for r in relevant
    ]
    result = answerer.answer(question, excerpts)

    # Layer 2: the model says the excerpts don't answer the question.
    if not result.found:
        return AskResponse(
            found=False,
            mode="abstain",
            answer=result.answer or ABSTAIN_MESSAGE,
            sources=[_source(r) for r in relevant[:3]],
        )

    # Layer 3: citation check. Keep only citations that map to real excerpts;
    # an answer with no valid receipts is not an answer.
    cited = [relevant[i] for i in dict.fromkeys(result.citations) if 0 <= i < len(relevant)]
    if not cited:
        return AskResponse(
            found=False,
            mode="abstain",
            answer=ABSTAIN_MESSAGE,
            sources=[_source(r) for r in relevant[:3]],
        )

    return AskResponse(
        found=True,
        mode="llm",
        answer=result.answer,
        sources=[_source(r) for r in cited],
    )
