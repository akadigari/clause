"""Pluggable embedders.

Two implementations:

- HashingEmbedder (default): a dependency-free lexical embedder. Tokens are
  hashed into a fixed-size vector with signed buckets and sublinear TF
  weighting, then L2-normalized, so cosine similarity approximates weighted
  term overlap. It runs fully offline, is deterministic (important for
  tests), and works well for single-document Q&A where the question shares
  vocabulary with the clause that answers it.

- MiniLMEmbedder: Chroma's bundled ONNX all-MiniLM-L6-v2 sentence embedder.
  Better semantic recall (matches paraphrases that share no words), but
  downloads a ~80MB model on first use and needs onnxruntime.

Select with CLAUSE_EMBEDDER=hash|minilm. Each embedder carries its own
``min_relevance``: the retrieval-gate threshold below which Clause abstains
without even asking the LLM (score = 1 - cosine distance).
"""

import hashlib
import math
import re
from collections import Counter
from typing import Protocol

from . import config

_TOKEN = re.compile(r"[a-z0-9']+")

# Small stopword list: keeps question scaffolding ("what am i agreeing to")
# from matching every chunk and inflating relevance scores.
_STOPWORDS = frozenset(
    """a an and are as at be but by can could do does did for from had has have
    how i if in into is it its may me my of on or our shall should so than that
    the their them then there these they this to under upon was we were what
    when where which who whom will with would you your""".split()
)


class Embedder(Protocol):
    name: str
    min_relevance: float

    def embed(self, texts: list[str]) -> list[list[float]]: ...

    def is_relevant(self, question: str, chunk_text: str, score: float) -> bool:
        """Retrieval-gate judgment: does this chunk plausibly bear on the question?

        Chunks that fail this for every retrieved result cause Clause to
        abstain without consulting the LLM at all.
        """
        ...


class HashingEmbedder:
    name = "hash"
    # Low bar on the cosine score itself: a genuine single-term match inside a
    # long chunk can score ~0.05. Hash-bucket collisions can also produce small
    # spurious scores, so is_relevant() additionally demands a real shared
    # content token - that check, not the score, is what makes the abstain
    # gate deterministic.
    min_relevance = 0.03

    def __init__(self, dims: int = 512):
        self.dims = dims

    def _tokens(self, text: str) -> list[str]:
        return [t for t in _TOKEN.findall(text.lower()) if t not in _STOPWORDS]

    def is_relevant(self, question: str, chunk_text: str, score: float) -> bool:
        if score < self.min_relevance:
            return False
        # cosine on hashed vectors can collide; exact token overlap cannot
        return bool(set(self._tokens(question)) & set(self._tokens(chunk_text)))

    def embed(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vec = [0.0] * self.dims
            for token, count in Counter(self._tokens(text)).items():
                digest = int.from_bytes(
                    hashlib.md5(token.encode()).digest()[:4], "big"
                )
                sign = 1.0 if digest & 0x80000000 else -1.0
                vec[digest % self.dims] += sign * (1.0 + math.log(count))
            norm = math.sqrt(sum(x * x for x in vec)) or 1.0
            vectors.append([x / norm for x in vec])
        return vectors


class MiniLMEmbedder:
    name = "minilm"
    # MiniLM cosine similarity between unrelated sentence pairs is typically
    # 0.0-0.2; related pairs sit above 0.35.
    min_relevance = 0.25

    def __init__(self):
        from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2

        self._ef = ONNXMiniLM_L6_V2()

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[float(x) for x in vec] for vec in self._ef(texts)]

    def is_relevant(self, question: str, chunk_text: str, score: float) -> bool:
        return score >= self.min_relevance


def get_embedder() -> Embedder:
    if config.EMBEDDER == "minilm":
        try:
            return MiniLMEmbedder()
        except Exception as exc:  # onnxruntime missing / model download failed
            print(f"[clause] MiniLM unavailable ({exc}); falling back to hash embedder")
    return HashingEmbedder()
