"""Run directory-aware keyword, topic, and concept-graph analysis."""

import argparse
import atexit
from datetime import datetime
import json
import os
from pathlib import Path
from threading import Event, Lock, Thread
import re
import sys

from bertopic import BERTopic
from bertopic.representation import KeyBERTInspired
from keybert import KeyBERT
import networkx as nx
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer

# Tests may load this file via importlib rather than running it directly,
# which doesn't add code/ to sys.path automatically.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path(paths.NOTES_ROOT)
DEFAULT_OUTPUT_ROOT = ROOT / "data" / "output"
TEXT_SUFFIXES = {".md", ".txt", ".markdown", ".text", ""}
ANALYSIS_VERSION = 3
ZIM_METADATA = re.compile(
    r"^(?:Content-Type:\s*text/x-zim-wiki|Wiki-Format:\s*zim\s+[\d.]+|"
    r"Creation-Date:\s*\d{4}-\d{2}-\d{2}T\S+)\s*$",
    re.IGNORECASE,
)
GENERIC_TOPIC_TERMS = {"thing", "things", "world", "write", "writing", "self"}
# Analysis embeds its own working set fresh every run and never touches the
# ChromaDB store, so unlike index_notes.py's model this one is safe to pick
# per run without invalidating anything else.
DEFAULT_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"


class ProgressReporter:
    """Print phase changes plus heartbeats while third-party modeling is silent."""

    def __init__(self, interval: int = 15) -> None:
        self.interval = interval
        self.phase = "Starting"
        self.lock = Lock()
        self.stopped = Event()
        self.thread = Thread(target=self._heartbeat, daemon=True)
        self.thread.start()

    def update(self, message: str) -> None:
        with self.lock:
            self.phase = message
        print(message, flush=True)

    def _heartbeat(self) -> None:
        while not self.stopped.wait(self.interval):
            with self.lock:
                phase = self.phase
            print(f"Still running: {phase}", flush=True)

    def close(self) -> None:
        self.stopped.set()


def text_files(root: Path):
    """Yield supported text files recursively without following directory entries."""
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def read_text(path: Path, max_chars: int) -> str:
    """Read a bounded UTF-8 sample, excluding known export boilerplate."""
    try:
        raw = path.read_text(encoding="utf-8", errors="ignore")
        # Zim writes these headers into every exported page. Removing only the
        # exact metadata forms keeps legitimate prose discussing Zim software.
        cleaned = "\n".join(line for line in raw.splitlines() if not ZIM_METADATA.match(line))
        return cleaned[:max_chars].strip()
    except OSError:
        return ""


def term_key(term: str) -> str:
    """Normalize simple plural variants for display-label deduplication."""
    normalized = re.sub(r"[^a-z0-9]+", " ", term.lower()).strip()
    words = []
    for word in normalized.split():
        if len(word) > 4 and word.endswith("ies"):
            word = word[:-3] + "y"
        elif len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        words.append(word)
    return " ".join(words)


def readable_topic_label(words: list[str]) -> str:
    """Turn BERTopic representation terms into a concise human label."""
    selected = []
    seen = set()
    for word in words:
        key = term_key(word)
        if not key or key in seen or key in GENERIC_TOPIC_TERMS:
            continue
        seen.add(key)
        selected.append(word.replace("_", " ").title())
        if len(selected) == 3:
            break
    return " / ".join(selected) or "Miscellaneous"


def chaos_level(relative: Path) -> tuple[str | None, int | None]:
    """Extract ``(range, level)`` from ``chaos/001-020/001/...`` paths.

    Some numbered folders have descriptive suffixes. Reading the leading
    integer and validating it against the parent range keeps those levels while
    avoiding false positives from numeric filenames elsewhere in the corpus.
    """
    if len(relative.parts) < 4 or relative.parts[0].lower() != "chaos":
        return None, None
    range_match = re.fullmatch(r"(\d{3})-(\d{3})", relative.parts[1])
    level_match = re.match(r"^(\d{1,3})(?:\D|$)", relative.parts[2])
    if not range_match or not level_match:
        return None, None
    lower, upper = (int(value) for value in range_match.groups())
    level = int(level_match.group(1))
    if not lower <= level <= upper:
        return None, None
    return relative.parts[1], level


def level_frequencies(
    records: list[dict],
    keywords: list[tuple[str, float]],
) -> tuple[list[dict], list[dict], list[dict]]:
    """Aggregate document, topic, and keyword prevalence by numbered level."""
    documents_per_level: dict[int, dict] = {}
    topic_counts: dict[tuple[int, int, str], int] = {}
    keyword_counts: dict[tuple[int, str], int] = {}
    keyword_names = {term_key(term): term for term, _ in keywords}

    for record in records:
        level = record.get("level")
        if level is None:
            continue
        level_range = record["level_range"]
        summary = documents_per_level.setdefault(
            level,
            {"level": level, "level_range": level_range, "document_count": 0},
        )
        summary["document_count"] += 1

        topic = int(record.get("topic", -1))
        if topic >= 0:
            topic_key = (level, topic, record["topic_name"])
            topic_counts[topic_key] = topic_counts.get(topic_key, 0) + 1

        document_keyword_keys = {
            term_key(term) for term in record.get("keyword_terms", [])
        }
        for keyword_key in document_keyword_keys.intersection(keyword_names):
            key = (level, keyword_key)
            keyword_counts[key] = keyword_counts.get(key, 0) + 1

    documents_by_level = sorted(documents_per_level.values(), key=lambda row: row["level"])
    topics_by_level = []
    for (level, topic, topic_name), count in topic_counts.items():
        total = documents_per_level[level]["document_count"]
        topics_by_level.append({
            "level": level,
            "level_range": documents_per_level[level]["level_range"],
            "topic": topic,
            "topic_name": topic_name,
            "document_count": count,
            "prevalence": count / total,
        })
    keywords_by_level = []
    for (level, keyword_key), count in keyword_counts.items():
        total = documents_per_level[level]["document_count"]
        keywords_by_level.append({
            "level": level,
            "level_range": documents_per_level[level]["level_range"],
            "term": keyword_names[keyword_key],
            "document_count": count,
            "prevalence": count / total,
        })
    topics_by_level.sort(key=lambda row: (row["topic"], row["level"]))
    keywords_by_level.sort(key=lambda row: (row["term"], row["level"]))
    return documents_by_level, topics_by_level, keywords_by_level


def safe_records(frame: pd.DataFrame) -> list[dict]:
    """Convert pandas/numpy scalar values into ordinary JSON-compatible records."""
    return json.loads(frame.to_json(orient="records"))


def build_graph(records: list[dict], keywords: list[tuple[str, float]]) -> dict:
    """Build a document-topic-keyword graph from modeled and lexical links.

    Topic-to-document edges come from BERTopic assignments. Keyword mentions
    are grounded by case-insensitive occurrence in the bounded source sample;
    topic-to-keyword edges summarize concepts shared by documents in a topic.
    """
    graph = nx.Graph()
    for keyword, score in keywords:
        graph.add_node(f"keyword:{keyword}", label=keyword, kind="keyword", score=float(score))
    for record in records:
        topic = int(record["topic"])
        if topic < 0:
            continue
        topic_id = f"topic:{topic}"
        graph.add_node(topic_id, label=record["topic_name"], kind="topic")
        graph.add_node(record["path"], label=Path(record["path"]).name, kind="document")
        graph.add_edge(topic_id, record["path"], kind="contains")
        lowered = record["text"].lower()
        for keyword, _ in keywords:
            keyword_id = f"keyword:{keyword}"
            if keyword.lower() in lowered:
                graph.add_edge(record["path"], keyword_id, kind="mentions")
                graph.add_edge(topic_id, keyword_id, kind="concept")
    return nx.node_link_data(graph, edges="edges")


def main() -> None:
    """Analyze a directory tree and persist one self-contained JSON payload."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--run-id")
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--min-topic-size", type=int)
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"Source directory not found: {source}")
    run_id = args.run_id or f"generated{datetime.now():%Y%m%d%H%M}"
    output_dir = DEFAULT_OUTPUT_ROOT / run_id / "analysis"
    output_dir.mkdir(parents=True, exist_ok=True)

    progress = ProgressReporter()
    atexit.register(progress.close)

    # Every eligible document participates. Per-document text remains bounded so
    # a single unusually large export cannot dominate embedding memory.
    progress.update("Phase 1/6: Scanning the complete source tree")
    records = []
    for scanned, path in enumerate(text_files(source), start=1):
        text = read_text(path, args.max_chars)
        if len(text) < 80:
            continue
        relative = path.relative_to(source)
        # Artifact paths remain relative to the requested source. Numbered-level
        # coordinates, however, are anchored to writing-desktop so analyzing a
        # subdirectory such as chaos/001-020 does not erase its range context.
        try:
            hierarchy_relative = path.relative_to(DEFAULT_SOURCE)
        except ValueError:
            hierarchy_relative = relative
        level_range, level = chaos_level(hierarchy_relative)
        records.append({
            "path": relative.as_posix(),
            "directory": relative.parent.as_posix(),
            "depth": len(relative.parts) - 1,
            "level_range": level_range,
            "level": level,
            "text": text,
        })
        if scanned % 100 == 0:
            progress.update(
                f"Phase 1/6: Scanned {scanned} files; accepted {len(records)} documents"
            )
    if len(records) < 5:
        raise SystemExit("At least five non-empty documents are required for topic modeling.")

    progress.update(f"Phase 1/6 complete: Loaded {len(records)} documents from {source}")
    progress.update(f"Embedding model: {args.embedding_model}")
    model = SentenceTransformer(args.embedding_model)
    documents = [record["text"] for record in records]
    embedding_batches = []
    for start in range(0, len(documents), 64):
        end = min(start + 64, len(documents))
        embedding_batches.append(
            model.encode(documents[start:end], show_progress_bar=False, normalize_embeddings=True)
        )
        progress.update(f"Phase 2/6: Embedded {end}/{len(documents)} documents")
    embeddings = np.vstack(embedding_batches)

    keyword_model = KeyBERT(model=model)
    # Average a term's relevance over documents in which it appears instead of
    # summing it. Summation makes repeated templates/boilerplate dominate simply
    # because they occur in many files.
    keyword_scores: dict[str, list[float]] = {}
    for start in range(0, len(documents), 32):
        end = min(start + 32, len(documents))
        extracted = keyword_model.extract_keywords(
            documents[start:end],
            keyphrase_ngram_range=(1, 3),
            stop_words="english",
            use_mmr=True,
            diversity=0.65,
            top_n=5,
        )
        for offset, document_keywords in enumerate(extracted):
            records[start + offset]["keyword_terms"] = [term for term, _ in document_keywords]
            for term, score in document_keywords:
                keyword_scores.setdefault(term, []).append(float(score))
        progress.update(f"Phase 3/6: Extracted keywords from {end}/{len(documents)} documents")
    ranked_keywords = [
        (term, (sum(scores) / len(scores)) * np.log1p(len(scores)))
        for term, scores in keyword_scores.items()
        if len(scores) >= 2
    ]
    keywords = sorted(ranked_keywords, key=lambda item: item[1], reverse=True)[:40]
    progress.update(f"Phase 3/6 complete: Selected {len(keywords)} distinct keywords")

    # KeyBERTInspired creates cleaner human-readable topic labels than raw c-TF-IDF
    # terms while the precomputed embeddings avoid encoding every document twice.
    progress.update("Phase 4/6: Fitting BERTopic clusters and representations")
    min_topic_size = args.min_topic_size or max(10, min(50, len(documents) // 100))
    progress.update(f"Phase 4/6: Using minimum topic size {min_topic_size}")
    topic_model = BERTopic(
        embedding_model=model,
        representation_model=KeyBERTInspired(),
        min_topic_size=min_topic_size,
        calculate_probabilities=False,
        verbose=True,
    )
    topics, _ = topic_model.fit_transform(documents, embeddings)
    progress.update("Phase 4/6 complete: Assigning topic labels to documents")
    for record, topic in zip(records, topics):
        record["topic"] = int(topic)
        words = topic_model.get_topic(topic) or []
        record["topic_name"] = readable_topic_label([word for word, _ in words]) if topic >= 0 else "Outlier"

    progress.update("Phase 5/6: Calculating topic frequencies by source directory")
    topic_info = safe_records(topic_model.get_topic_info())
    for topic in topic_info:
        representation = topic.get("Representation") or []
        topic["DisplayName"] = (
            readable_topic_label(representation)
            if int(topic.get("Topic", -1)) >= 0 else "Outlier"
        )
    # Directory paths act as classes, preserving the source hierarchy in a form
    # suitable for frequency-over-directory charts in the React client.
    hierarchy = safe_records(topic_model.topics_per_class(documents, classes=[record["directory"] for record in records]))
    progress.update("Phase 6/6: Building the document-topic-keyword graph")
    graph = build_graph(records, keywords)
    documents_by_level, topics_by_level, keywords_by_level = level_frequencies(
        records, keywords
    )
    payload = {
        "analysis_version": ANALYSIS_VERSION,
        "run_id": run_id,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": str(source),
        "embedding_model": args.embedding_model,
        "document_count": len(records),
        "keywords": [{"term": term, "score": float(score)} for term, score in keywords],
        "topics": topic_info,
        "topics_by_directory": hierarchy,
        "documents_by_level": documents_by_level,
        "topics_by_level": topics_by_level,
        "keywords_by_level": keywords_by_level,
        "documents": [
            {
                **{
                    key: value
                    for key, value in record.items()
                    if key not in {"text", "keyword_terms"}
                },
                "keywords": record.get("keyword_terms", []),
                "character_count": len(record["text"]),
                "excerpt": record["text"][:600],
            }
            for record in records
        ],
        "graph": graph,
    }
    output = output_dir / "analysis.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    progress.update(f"Complete: Analysis written to {output}")
    progress.close()


if __name__ == "__main__":
    main()
