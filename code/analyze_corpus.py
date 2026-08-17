"""Run directory-aware keyword, topic, and concept-graph analysis."""

import argparse
from datetime import datetime
import json
from pathlib import Path
import re

from bertopic import BERTopic
from bertopic.representation import KeyBERTInspired
from keybert import KeyBERT
import networkx as nx
import pandas as pd
from sentence_transformers import SentenceTransformer


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = ROOT / "data" / "input"
DEFAULT_OUTPUT_ROOT = ROOT / "data" / "output"
TEXT_SUFFIXES = {".md", ".txt", ".markdown", ".text", ""}


def text_files(root: Path):
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in TEXT_SUFFIXES:
            yield path


def read_text(path: Path, max_chars: int) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:max_chars].strip()
    except OSError:
        return ""


def safe_records(frame: pd.DataFrame) -> list[dict]:
    return json.loads(frame.to_json(orient="records"))


def build_graph(records: list[dict], keywords: list[tuple[str, float]]) -> dict:
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--run-id")
    parser.add_argument("--max-documents", type=int, default=1000)
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--min-topic-size", type=int, default=5)
    args = parser.parse_args()

    source = args.source.resolve()
    if not source.is_dir():
        raise SystemExit(f"Source directory not found: {source}")
    run_id = args.run_id or f"generated{datetime.now():%Y%m%d%H%M}"
    output_dir = DEFAULT_OUTPUT_ROOT / run_id / "analysis"
    output_dir.mkdir(parents=True, exist_ok=True)

    records = []
    for path in text_files(source):
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
        if len(records) >= args.max_documents:
            break
    if len(records) < 5:
        raise SystemExit("At least five non-empty documents are required for topic modeling.")

    print(f"Loaded {len(records)} documents from {source}", flush=True)
    model = SentenceTransformer("all-MiniLM-L6-v2")
    documents = [record["text"] for record in records]
    embeddings = model.encode(documents, show_progress_bar=True, normalize_embeddings=True)

    keyword_model = KeyBERT(model=model)
    sample = "\n\n".join(documents)[:200000]
    keywords = keyword_model.extract_keywords(
        sample,
        keyphrase_ngram_range=(1, 3),
        stop_words="english",
        use_mmr=True,
        diversity=0.65,
        top_n=40,
    )
    print(f"Extracted {len(keywords)} distinct keywords", flush=True)

    topic_model = BERTopic(
        embedding_model=model,
        representation_model=KeyBERTInspired(),
        min_topic_size=args.min_topic_size,
        calculate_probabilities=False,
        verbose=True,
    )
    topics, _ = topic_model.fit_transform(documents, embeddings)
    for record, topic in zip(records, topics):
        record["topic"] = int(topic)
        words = topic_model.get_topic(topic) or []
        record["topic_name"] = ", ".join(word for word, _ in words[:4]) if topic >= 0 else "Outlier"

    topic_info = safe_records(topic_model.get_topic_info())
    hierarchy = safe_records(topic_model.topics_per_class(documents, classes=[record["directory"] for record in records]))
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
    print(f"Analysis written to {output}", flush=True)


if __name__ == "__main__":
    main()
