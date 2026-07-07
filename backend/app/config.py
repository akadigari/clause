"""Runtime configuration, all overridable via environment variables."""

import os


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# LLM
MODEL = os.environ.get("CLAUSE_MODEL", "claude-opus-4-8")
MAX_ANSWER_TOKENS = _int_env("CLAUSE_MAX_ANSWER_TOKENS", 2000)

# Embeddings: "hash" (dependency-free, offline) or "minilm" (Chroma's ONNX MiniLM)
EMBEDDER = os.environ.get("CLAUSE_EMBEDDER", "hash")

# Retrieval
TOP_K = _int_env("CLAUSE_TOP_K", 6)

# Chunking
CHUNK_TARGET_CHARS = _int_env("CLAUSE_CHUNK_TARGET_CHARS", 1100)
CHUNK_OVERLAP_CHARS = _int_env("CLAUSE_CHUNK_OVERLAP_CHARS", 180)
CHUNK_HARD_MAX_CHARS = _int_env("CLAUSE_CHUNK_HARD_MAX_CHARS", 2200)

# Privacy: uploaded documents live in memory only and expire after this many
# seconds (samples never expire). Nothing is ever written to disk.
DOC_TTL_SECONDS = _int_env("CLAUSE_DOC_TTL_SECONDS", 3600)

# Upload limits
MAX_UPLOAD_MB = _int_env("CLAUSE_MAX_UPLOAD_MB", 20)
MAX_PAGES = _int_env("CLAUSE_MAX_PAGES", 300)
