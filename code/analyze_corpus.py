"""Run directory-aware keyword, topic, and concept-graph analysis."""

import argparse
import atexit
from datetime import datetime
import json
from pathlib import Path
from threading import Event, Lock, Thread

from bertopic import BERTopic
from bertopic.representation import KeyBERTInspired
from keybert import KeyBERT
import networkx as nx
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "data" / "input"
DEFAULT_OUTPUT_ROOT = ROOT / "data" / "output"
TEXT_SUFFIXES = {".md", ".txt", ".markdown", ".text", ""}


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
    """Read a bounded UTF-8 sample and tolerate malformed exported text."""
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:max_chars].strip()
    except OSError:
        return ""


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
    parser.add_argument("--min-topic-size", type=int, default=5)
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
        records.append({
            "path": relative.as_posix(),
            "directory": relative.parent.as_posix(),
            "depth": len(relative.parts) - 1,
            "text": text,
        })
        if scanned % 100 == 0:
            progress.update(
                f"Phase 1/6: Scanned {scanned} files; accepted {len(records)} documents"
            )
    if len(records) < 5:
        raise SystemExit("At least five non-empty documents are required for topic modeling.")

    progress.update(f"Phase 1/6 complete: Loaded {len(records)} documents from {source}")
    model = SentenceTransformer("all-MiniLM-L6-v2")
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
    keyword_scores: dict[str, float] = {}
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
        for document_keywords in extracted:
            for term, score in document_keywords:
                keyword_scores[term] = keyword_scores.get(term, 0.0) + float(score)
        progress.update(f"Phase 3/6: Extracted keywords from {end}/{len(documents)} documents")
    keywords = sorted(keyword_scores.items(), key=lambda item: item[1], reverse=True)[:40]
    progress.update(f"Phase 3/6 complete: Selected {len(keywords)} distinct keywords")

    # KeyBERTInspired creates cleaner human-readable topic labels than raw c-TF-IDF
    # terms while the precomputed embeddings avoid encoding every document twice.
    progress.update("Phase 4/6: Fitting BERTopic clusters and representations")
    topic_model = BERTopic(
        embedding_model=model,
        representation_model=KeyBERTInspired(),
        min_topic_size=args.min_topic_size,
        calculate_probabilities=False,
        verbose=True,
    )
    topics, _ = topic_model.fit_transform(documents, embeddings)
    progress.update("Phase 4/6 complete: Assigning topic labels to documents")
    for record, topic in zip(records, topics):
        record["topic"] = int(topic)
        words = topic_model.get_topic(topic) or []
        record["topic_name"] = ", ".join(word for word, _ in words[:4]) if topic >= 0 else "Outlier"

    progress.update("Phase 5/6: Calculating topic frequencies by source directory")
    topic_info = safe_records(topic_model.get_topic_info())
    # Directory paths act as classes, preserving the source hierarchy in a form
    # suitable for frequency-over-directory charts in the React client.
    hierarchy = safe_records(topic_model.topics_per_class(documents, classes=[record["directory"] for record in records]))
    progress.update("Phase 6/6: Building the document-topic-keyword graph")
    graph = build_graph(records, keywords)
    payload = {
        "run_id": run_id,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": str(source),
        "document_count": len(records),
        "keywords": [{"term": term, "score": float(score)} for term, score in keywords],
        "topics": topic_info,
        "topics_by_directory": hierarchy,
        "documents": [{key: value for key, value in record.items() if key != "text"} for record in records],
        "graph": graph,
    }
    output = output_dir / "analysis.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    progress.update(f"Complete: Analysis written to {output}")
    progress.close()


if __name__ == "__main__":
    main()
