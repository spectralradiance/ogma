"""Curated + user-added model catalog for generation and embedding pickers.

Generation models are instruction-tuned causal LLMs that write prose; embedding
models are encoder-only models that map text to a fixed vector for search and
similarity. The two jobs need different model architectures, so a given entry
is tagged with exactly one ``kind`` rather than being usable for both.
"""

import json
from pathlib import Path

from huggingface_hub import scan_cache_dir

# Mirrors the WRITER_MODELS/EMBEDDING_MODELS lists the frontend used to hardcode.
# Kept server-side now so custom additions can be persisted and merged with them.
BUILTIN_MODELS: list[dict] = [
    {"value": "Qwen/Qwen2.5-7B-Instruct", "label": "Local GPU · Qwen2.5 7B", "kind": "generation", "provider": "local"},
    {"value": "Qwen/Qwen2.5-14B-Instruct", "label": "Local GPU · Qwen2.5 14B", "kind": "generation", "provider": "local"},
    {"value": "claude-opus-5", "label": "Claude API · Opus 5", "kind": "generation", "provider": "claude"},
    {"value": "claude-sonnet-5", "label": "Claude API · Sonnet 5", "kind": "generation", "provider": "claude"},
    {"value": "BAAI/bge-large-en-v1.5", "label": "BGE large · best quality", "kind": "embedding", "provider": "local"},
    {"value": "BAAI/bge-base-en-v1.5", "label": "BGE base · faster", "kind": "embedding", "provider": "local"},
    {"value": "all-MiniLM-L6-v2", "label": "MiniLM · fastest", "kind": "embedding", "provider": "local"},
]
BUILTIN_VALUES = {entry["value"] for entry in BUILTIN_MODELS}


def _custom_path(intermediary_dir: Path) -> Path:
    return intermediary_dir / "model_catalog.json"


def load_custom_models(intermediary_dir: Path) -> list[dict]:
    path = _custom_path(intermediary_dir)
    if not path.is_file():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def save_custom_models(intermediary_dir: Path, models: list[dict]) -> None:
    path = _custom_path(intermediary_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(models, indent=2), encoding="utf-8")


def is_downloaded(repo_id: str) -> bool:
    """Whether a Hugging Face repo is already in the local cache.

    Uses the same cache huggingface_hub/transformers/sentence-transformers read
    from at load time, so this reflects whether a model would need a network
    fetch on next use rather than tracking downloads ourselves.
    """
    try:
        cache_info = scan_cache_dir()
    except Exception:
        return False
    return any(repo.repo_id == repo_id for repo in cache_info.repos)


def full_catalog(intermediary_dir: Path) -> list[dict]:
    """Builtin entries plus custom additions, each annotated with cache status."""
    entries = BUILTIN_MODELS + load_custom_models(intermediary_dir)
    result = []
    for entry in entries:
        downloaded = True if entry["provider"] == "claude" else is_downloaded(entry["value"])
        result.append({
            **entry,
            "builtin": entry["value"] in BUILTIN_VALUES,
            "downloaded": downloaded,
        })
    return result
