# Clause

**A PDF workbench that never uploads your file.**

**[clause-mauve.vercel.app](https://clause-mauve.vercel.app)**

Merge, split, turn, sign, redact, shrink and convert PDFs, and ask questions
about what they say. All of it runs in the browser tab. There is no account,
nothing comes out watermarked, and no feature is held back for a paid plan,
because there is no plan and no server to charge for.

---

## Why this exists

Rotating a page is not a hard problem. It is a solved problem. But the sites
that solve it want $9 to $15 a month, cap your free conversions per day, and
upload your document to their servers to do work a browser can do on its own.

For a lease, a contract, a medical form or a tax return, that upload is the
part that should bother you. Their privacy policy might be excellent. You
still cannot check it.

So this does the work locally and gives you something better than a promise:
a counter in the corner that reports every network request the page makes and
every byte it sends. Open your own devtools and compare. Or turn off your wifi
and keep working, which is the shortest version of the same proof.

---

## What is on the bench

| Tool | What it does |
| --- | --- |
| **Pages** | Turn, reorder, delete, duplicate, insert blanks, pull pages out to a new file |
| **Merge** | Any number of PDFs into one, in the order you choose |
| **Split** | Cut anywhere, every N pages, or by ranges. Download the parts or a zip |
| **Mark** | Text, watermarks and page numbers, anchored where you want them |
| **Sign** | Draw or type a signature once, then place it |
| **Redact** | Removes the words from the file rather than covering them |
| **Shrink** | Lossless tidy, or flatten to images, with the real before and after |
| **Convert** | Pages to PNG/JPEG, images to a PDF, pages to plain text |
| **Fields** | Fill in a form and optionally lock the answers in |
| **Details** | Read and clear the metadata a file carries about you |
| **Read** | Ask a question, get the exact clause back |

### Redaction actually redacts

Drawing a black rectangle over a name with most tools leaves the name sitting
underneath, selectable and searchable. Real documents have leaked this way,
repeatedly, including court filings.

Here, redacting a page renders it and rebuilds it as an image, so the text is
genuinely gone. That costs something and the interface says so before you
commit: those pages lose selectable text, get larger, and stop working with a
screen reader. Pages you did not redact are untouched. Afterwards you can type
a phrase you expected to remove and the app searches the output for it, so you
get a receipt rather than an assurance.

### Read: answers with the clause attached

The Read tool is the original Clause. It indexes the document in your tab,
retrieves the passages closest to your question, and shows them with the page
and the exact character range they occupy. Click one and it highlights in the
document where the words really are.

It is built to refuse. If nothing retrieved clears the relevance bar, it says
the document does not appear to say, rather than reaching for something
adjacent.

Optionally, with **your own** Anthropic API key, those retrieved passages can
be sent to a model that writes a plain-English answer about them. That is the
one thing in this app that touches the network, it is off by default, the key
lives in memory for the tab only, and the meter turns amber while it sends.
The grounding rules still run outside the model: an answer whose citations do
not map to real retrieved passages is discarded before you see it.

---

## Honest limits

Things this deliberately does not do, and why:

- **No OCR.** A scanned page is a picture of words. Reading it needs an OCR
  engine, which is a large download and a different problem.
- **No password removal.** The library used here cannot decrypt, and it cannot
  re-encrypt on save. Rather than write a silently unopenable file, the app
  refuses protected PDFs and says so.
- **No cryptographic signatures.** The Sign tool places a picture of your
  signature, which is what most e-signature services actually do and is widely
  accepted. It does not prove who signed or detect later edits.
- **No lossless compression of images already inside a PDF.** Nothing in the
  browser can rewrite those streams. "Shrink" offers a lossless tidy that saves
  a little, and a lossy flatten that saves a lot on scans and usually makes a
  text document *bigger*. It measures the result and keeps the original if
  flattening did not help.
- **Big files have a ceiling.** A browser tab has far less memory than a
  desktop app, and canvas has hard caps. Very large documents are refused with
  a number rather than crashing.

---

## Running it

Node 20 or newer.

```bash
cd frontend
npm install
npm run dev
```

Then open the printed URL. To build the static site:

```bash
npm run build
```

The output in `frontend/dist` is plain files. Serve it from anywhere, including
Vercel, GitHub Pages, a USB stick, or `file://`. The build uses a relative base
so the same output works from a domain root or a project subpath without
rebuilding.

Two deploy paths are set up and neither needs a server:

- **Vercel** via `frontend/vercel.json`, which is what the link above runs on.
- **GitHub Pages** via `.github/workflows/deploy.yml`, which typechecks, tests
  and builds on every push. It needs Pages turned on in the repository settings
  with the source set to "GitHub Actions" before it has anywhere to publish.

```bash
npm test          # 430 tests
npm run typecheck
```

### The optional Python backend

`backend/` holds the original FastAPI + Chroma implementation of the Read
engine, with 34 pytest tests. The web app does not need it: the whole engine
was ported to TypeScript in `frontend/src/lib/clause/`, including a
hand-written md5 so the retrieval vectors are identical to the Python ones. The
backend is kept because it is a working reference and a second implementation
to check against.

---

## How it is put together

```
frontend/
  src/lib/clause/     the retrieval and abstain engine, ported from Python
  src/lib/pdf/ops/    one pure module per operation: bytes in, bytes out
  src/lib/pdf/        pdf.js wrapper (render, text) and the coordinate math
  src/components/     the bench, and one lazily loaded panel per tool
backend/              the original FastAPI service, optional
```

Two rules shape most of it:

**Every edit is a pure function from bytes to bytes.** Undo is a stack of
snapshots, so it cannot drift out of step with the file, and every operation is
testable without a browser.

**Coordinates go through one place.** `src/lib/pdf/geometry.ts` converts
between what you clicked and what gets written into the PDF, handling page
rotation and a MediaBox whose origin is not `(0, 0)`. Getting this wrong is why
stamps land in the wrong corner of rotated pages in a lot of tools, so it is
the most heavily tested file in the repo.

### Built with

[pdf.js](https://mozilla.github.io/pdf.js/) to read and render,
[pdf-lib](https://pdf-lib.js.org/) to write, React and Vite, and no UI
framework. pdf.js ships its fonts and decoders as separate files, and those are
served from this site rather than a CDN, so opening a document never contacts
anyone else.

A note on dependencies: pdf-lib has not had a release since November 2021. It
is still the best pure-JS PDF writer available and everything here is pinned
and tested against it, but it is unmaintained and worth knowing about.

---

## Licence

MIT. See [LICENSE](LICENSE).

The sample lease and terms of service are fictional, written for this project.
