# Clause.

**Plain-English answers about confusing documents, with receipts.**

## What it does

Upload a lease, a contract, a terms of service, an insurance policy, or a
product manual, and ask questions the way you'd ask a friend: *"What am I
actually agreeing to?"*, *"Can my landlord charge me for this?"*, *"How do I
cancel?"* Clause answers in clear, friendly language, and every answer shows
the **exact clause and page** it came from. Click a citation and the source
text lights up in the document viewer.

And when the answer isn't in the document, Clause says
**"I couldn't find that in this document."** It never guesses. That's the
whole point: see [why below](#why-cite-the-exact-clause-never-guess-is-the-whole-point).

Clause also has a proactive **red-flags scan** that checks a document for the
clauses people most often get burned by, without you having to know what to
ask. See [Red-flags scan](#red-flags-scan) below.

```
┌─────────────────────────────┬──────────────────────────────┐
│  Document viewer            │  Chat                        │
│                             │                              │
│  Page 1 ─────────────────   │  You: What's the late fee?   │
│  Page 2 ─────────────────   │                              │
│   ...a late fee of $75,     │  Clause: If your rent is     │
│   plus $10 for each         │  more than 5 days late,      │
│  ▓▓▓additional day▓▓▓...    │  you owe $75 plus $10/day,   │
│         ▲                   │  capped at $250/month.       │
│         └── click a source  │  Sources:                    │
│             to highlight it │  [Lease · p.1 "...late fee   │
│                             │   of $75, plus $10..."]      │
└─────────────────────────────┴──────────────────────────────┘
```

## Demo

![Clause: ask a question, click the citation, see the exact clause highlight](docs/demo.gif)

*Asking about late fees, clicking the citation to highlight the exact clause,
then running the red-flags scan. (Recording script: [`docs/RECORDING.md`](docs/RECORDING.md).)*

## Why "cite the exact clause, never guess" is the whole point

For legal and contract documents, a *plausible-sounding but wrong* answer is
worse than no answer. If a tool tells you "you can cancel anytime" and the
contract actually says "60 days written notice plus a two-month fee," the tool
didn't save you time. It cost you $3,700. General-purpose chatbots fail here
in two ways: they blend the document with their prior knowledge of "typical"
contracts, and they can't show *where* an answer came from, so you can't check
them without reading the whole document anyway, which defeats the purpose.

Clause is built so that trust never has to be assumed:

1. **Answers can only come from the document.** The model never sees anything
   except retrieved excerpts of the uploaded file, and is instructed to use
   nothing else: no outside knowledge of laws or "standard" terms.
2. **Every claim carries a receipt.** Each source is an exact character span
   (`page`, `start`, `end`) of the extracted text. The quote is
   *reproducible*: `page_text[start:end] == quote`, byte for byte. Clicking it
   shows the real clause in context, so verifying an answer takes seconds.
3. **Abstention is enforced, not requested.** Three independent layers can
   each force an "I couldn't find that" (see below), including one that
   *runs after* the model answers and throws the answer away if its citations
   don't check out.

## How it works (RAG)

```
 PDF upload                              question
     │                                       │
     ▼                                       ▼
 ┌─────────┐   ┌──────────┐   ┌────────┐  ┌────────┐
 │  pypdf   │──▶│ chunker  │──▶│ embed  │─▶│ Chroma │◀─ embed(question)
 │ per-page │   │ ~1100ch  │   │        │  │ cosine │
 │  text    │   │ +overlap │   └────────┘  └───┬────┘
 └─────────┘   │ page+span│                    │ top-k chunks
               └──────────┘                    ▼
                                     ┌──────────────────┐
                                     │  gate: relevant? │──no──▶ "couldn't find"
                                     └────────┬─────────┘
                                              ▼ yes
                                     ┌──────────────────┐
                                     │ Claude (excerpts │
                                     │ ONLY + strict    │──not found─▶ "couldn't find"
                                     │ JSON output)     │
                                     └────────┬─────────┘
                                              ▼ found
                                     ┌──────────────────┐
                                     │ citation check:  │──invalid──▶ "couldn't find"
                                     │ map to real spans│
                                     └────────┬─────────┘
                                              ▼
                                     answer + exact quotes
```

**Chunking** ([backend/app/chunking.py](backend/app/chunking.py)): each PDF
page's text is split into ~1,100-character chunks along paragraph (falling
back to sentence, falling back to raw character) boundaries, with ~180
characters of overlap so a clause that straddles a boundary is fully present
in at least one chunk. The core invariant, covered by tests: every chunk is a
**literal slice** of its page's text (`page_text[start:end] == text`). Nothing
is rewritten, so citations can always be mapped back to the original.

**Embeddings** ([backend/app/embedding.py](backend/app/embedding.py)):
pluggable via `CLAUSE_EMBEDDER`:

| Embedder | How it works | Trade-off |
|---|---|---|
| `hash` (default) | Dependency-free lexical embedder: tokens hashed into signed buckets with sublinear TF weighting, L2-normalized. | Fully offline, deterministic, instant startup. Matches shared vocabulary ("pet fee" → pets clause) but not pure paraphrases ("dog" ↛ "pets"). |
| `minilm` | Chroma's bundled ONNX `all-MiniLM-L6-v2` sentence transformer. | Real semantic matching; downloads ~80MB once and needs `onnxruntime`. |

**Vector store** ([backend/app/store.py](backend/app/store.py)): an
**ephemeral, in-memory** Chroma collection per document (cosine space). On a
question, the query is embedded once and the top-k chunks are retrieved across
whichever documents are in scope (one or all: multi-document search merges
per-document results by score).

**Answering** ([backend/app/llm.py](backend/app/llm.py)): the retrieved
excerpts (only them, never the full document) go to Claude
(`claude-opus-4-8` by default) with a system prompt that forbids outside
knowledge, and a **structured-output JSON schema** forcing
`{found, answer, citations[]}`. Citation indices are resolved back to chunk
spans server-side.

### The three abstain layers

| Layer | Where | What it catches |
|---|---|---|
| 1. Retrieval gate | before the LLM | Nothing in the document is even topically related → abstain **without spending an LLM call**. For the lexical embedder this requires an actual shared content word, so hash collisions can't sneak an irrelevant chunk past the gate. |
| 2. Model judgment | in the LLM | Chunks are topically related but don't answer the question (asked about parking, retrieved the pets clause) → model returns `found: false`. |
| 3. Citation check | after the LLM | Model claims an answer but cites nothing, or cites excerpts that don't exist → the answer is **discarded** and Clause abstains. No receipts, no answer. |

## Red-flags scan

Ask-and-answer is reactive: you have to know what to ask. The **red-flags
scan** (`POST /api/documents/{id}/scan`, the ⚑ button in the UI) is the
proactive twin: it probes a document for the clauses people most often get
burned by (automatic renewal, fees and penalties, cancellation and
termination, arbitration and legal rights, liability and warranty, changes to
the terms, data and privacy) and reports each match **with the exact clause it
came from**.

It reuses the same safety checks as ask, so the "never guess" rule still
holds: each risk category is a retrieval query, only chunks that clear the
relevance gate are candidates, and, with an LLM, a flag is dropped if its
citation doesn't map to a real excerpt. Same as answers: no receipts, no flag.

The scan runs in whichever mode the server is in:

- **With an API key** the model judges which candidate clauses are genuine
  instances, rates severity (high / medium / low), and explains in plain
  English why each matters to you.
- **Without a key** (extractive mode) it can't judge, so it stays deliberately
  conservative: a topic is surfaced only when a passage literally contains one
  of that topic's signal terms (not just a shared word), the labels are neutral
  topics rather than accusations, and the citation is narrowed to the single
  sentence that mentions the topic, never a claim about what the document
  *decides*, only "here's the relevant clause, read it."

## Privacy

Documents are **never written to disk**. Uploads are parsed and indexed in
RAM, the raw bytes discarded, and each uploaded document expires after an hour
(configurable via `CLAUSE_DOC_TTL_SECONDS`). The vector store is ephemeral;
restarting the server erases everything except the bundled samples. The only
data that leaves the machine is the retrieved excerpts sent to the Anthropic
API for answering.

## Quick start

**Requirements:** Python 3.11+, Node 20+, and (optional) an Anthropic API key.
Without a key, Clause still runs. It just shows the matching passages
instead of writing plain-English answers (see below).

**Backend** (Python 3.11+):

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...        # optional but recommended
.venv/bin/uvicorn app.main:app --port 8000
```

**Frontend** (Node 20+):

```bash
cd frontend
npm install
npm run dev                                 # http://localhost:3000
```

Two sample documents (a fictional apartment lease and a fictional terms of
service) load automatically, so the demo works with zero setup: try
*"How do I cancel my subscription?"* on the Terms of Service.

Without `ANTHROPIC_API_KEY`, Clause runs in **quote-only mode**: it still
retrieves and shows the exact passages that match your question, it just won't
write the plain-English summary. It degrades to showing receipts, never to
guessing.

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Enables plain-English answers |
| `CLAUSE_MODEL` | `claude-opus-4-8` | Claude model for answering |
| `CLAUSE_EMBEDDER` | `hash` | `hash` or `minilm` |
| `CLAUSE_TOP_K` | `6` | Chunks retrieved per question |
| `CLAUSE_DOC_TTL_SECONDS` | `3600` | Upload lifetime |
| `CLAUSE_MAX_UPLOAD_MB` | `20` | Upload size limit |

## Tests

```bash
cd backend && .venv/bin/python -m pytest
```

41 tests cover the pillars:

- **Chunking**: the exact-span invariant, full content coverage, size
  bounds, overlap behavior, page tracking, and degenerate inputs (empty
  pages, 5,000 characters with no whitespace).
- **Retrieval**: right chunk / right page / right document, multi-document
  scoping and filtering, and quote reproducibility.
- **Abstention**: each of the three layers independently forces "I couldn't
  find that": irrelevant questions never reach the LLM, a `found: false`
  verdict abstains, and a fabricated answer with invalid citations is
  discarded (verified with a scripted fake LLM, no API key needed to run the
  suite).
- **Red-flags scan**: signal-gated topic matching, sentence-level citations,
  and the same grounding drops (invalid citation / unknown category → no flag).

Plus end-to-end API tests that upload a real generated PDF and walk the full
upload → ask → cite → verify-quote loop.

The whole suite runs offline with a scripted fake LLM. To exercise the **real**
Anthropic API (auth, model, structured output, grounding round-trip), set
`ANTHROPIC_API_KEY` and run the otherwise-skipped live smoke test:

```bash
ANTHROPIC_API_KEY=sk-ant-... .venv/bin/python -m pytest tests/test_live_llm.py -v
```

## Files

```
clause/
├── backend/
│   ├── app/
│   │   ├── main.py         # FastAPI routes
│   │   ├── pdf_parser.py   # pypdf → per-page text
│   │   ├── chunking.py     # span-tracked chunker
│   │   ├── embedding.py    # hash / MiniLM embedders + relevance gate
│   │   ├── store.py        # in-memory registry + ephemeral Chroma
│   │   ├── llm.py          # Claude answerer, abstain layers, prompts
│   │   ├── flags.py        # red-flags scan: risk categories + grounding
│   │   ├── models.py       # API schemas
│   │   └── config.py
│   ├── samples/            # generated demo PDFs
│   ├── scripts/make_samples.py
│   └── tests/
└── frontend/               # Next.js app (viewer + chat + citations)
    ├── app/
    ├── components/
    └── lib/api.ts
```

*Clause explains what a document says; it doesn't give legal advice.*
