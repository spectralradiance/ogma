"""Generate a note-grounded Markdown glossary from the manuscript source data."""

import argparse
import hashlib
import json
import os
import re

import numpy as np
import torch
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from transformers import AutoTokenizer

import write_book


CACHE_VERSION = "concepts-v1"
DEFAULT_TARGET = 200
DEFAULT_SECTIONS_PER_BATCH = 5
DEFAULT_CANDIDATES_PER_BATCH = 10
DEFAULT_CONTEXT_CHARS = 800
MAX_CANDIDATE_TOKENS = 900
DEFAULT_SIMILARITY_THRESHOLD = 0.86
CACHE_FILE = os.path.join(
    write_book.INTERMEDIARY_DIR,
    f"concept_candidates_{CACHE_VERSION.removeprefix('concepts-')}.jsonl",
)
DEFAULT_OUTPUT = os.path.join(write_book.OUTPUT_DIR, "concepts.md")
FAILED_RESPONSE_DIR = os.path.join(write_book.INTERMEDIARY_DIR, "concept_failures")


def batches(items: list[dict], size: int):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def interleave_systems(rows: list[dict], systems: set[str]) -> list[dict]:
    grouped = {
        system: [row for row in rows if row["System"] == system]
        for system in sorted(systems)
    }
    interleaved = []
    max_length = max((len(group) for group in grouped.values()), default=0)
    for index in range(max_length):
        for system in sorted(grouped):
            if index < len(grouped[system]):
                interleaved.append(grouped[system][index])
    return interleaved


def batch_key(rows: list[dict]) -> str:
    source = [
        {
            "system": row["System"],
            "number": write_book.section_number(row),
            "name": row["Name"],
        }
        for row in rows
    ]
    digest = hashlib.sha256(
        json.dumps(source, sort_keys=True, ensure_ascii=True).encode("utf-8")
    ).hexdigest()[:16]
    return f"{CACHE_VERSION}|{digest}"


def load_cache(path: str) -> dict[str, list[dict[str, str]]]:
    cached = {}
    if not os.path.exists(path):
        return cached
    with open(path, encoding="utf-8") as cache_file:
        for line_number, line in enumerate(cache_file, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                cached[record["batch_key"]] = record["candidates"]
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                raise ValueError(f"Invalid concept cache entry on line {line_number}") from exc
    return cached


def append_cache(path: str, key: str, candidates: list[dict[str, str]]) -> None:
    with open(path, "a", encoding="utf-8") as cache_file:
        cache_file.write(
            json.dumps(
                {"batch_key": key, "candidates": candidates},
                ensure_ascii=False,
            ) + "\n"
        )


def save_failed_response(batch_index: int, response: str) -> str:
    os.makedirs(FAILED_RESPONSE_DIR, exist_ok=True)
    path = os.path.join(FAILED_RESPONSE_DIR, f"batch_{batch_index:03d}.txt")
    with open(path, "w", encoding="utf-8") as response_file:
        response_file.write(response)
    return path


def build_concept_messages(
    rows: list[dict],
    contexts: list[str],
    candidate_count: int,
) -> list[dict]:
    # Metadata and retrieved evidence remain dynamic; editorial policy lives in guidance.json.
    source_blocks = []
    for row, context in zip(rows, contexts):
        source_blocks.append(
            f"Section: {row['System']} {write_book.section_number(row)}\n"
            f"{write_book.display_name_hint(row)}\n"
            f"Notes:\n{context}"
        )

    return [
        {
            "role": "system",
            "content": write_book.GUIDANCE["concepts"]["system"],
        },
        {
            "role": "user",
            "content": write_book.GUIDANCE["concepts"]["instructions"].format(
                candidate_count=candidate_count,
                source_material="\n\n---\n\n".join(source_blocks),
            ),
        },
    ]


def complete_sentence(text: str) -> str:
    sentence = re.sub(r"\s+", " ", text).strip()
    if sentence and sentence[-1] not in ".!?":
        sentence += "."
    return sentence


def parse_candidates(text: str) -> list[dict[str, str]]:
    start = text.find("[")
    end = text.rfind("]")
    if start < 0 or end < start:
        raise ValueError("Model response did not contain a JSON array")
    data = json.loads(text[start:end + 1])
    if not isinstance(data, list):
        raise ValueError("Model response was not a JSON array")

    candidates = []
    for item in data:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name", ""))).strip(" #*:-")
        definition = complete_sentence(str(item.get("definition", "")))
        significance = complete_sentence(str(item.get("significance", "")))
        if definition and significance:
            description = f"{definition} {significance}"
        else:
            description = complete_sentence(str(item.get("description", "")))
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", description) if part.strip()]
        if not name or len(sentences) < 2:
            continue
        candidates.append({"name": name, "description": " ".join(sentences[:3])})
    return candidates


def normalize_name(name: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    return normalized.removeprefix("the ")


def deduplicate_candidates(
    candidates: list[dict[str, str]],
    embedding_function,
    target_count: int,
    similarity_threshold: float,
) -> list[dict[str, str]]:
    exact_unique = []
    seen_names = set()
    for candidate in candidates:
        normalized = normalize_name(candidate["name"])
        if not normalized or normalized in seen_names:
            continue
        seen_names.add(normalized)
        exact_unique.append(candidate)

    if not exact_unique:
        return []

    texts = [
        f"{candidate['name']}. {candidate['description']}"
        for candidate in exact_unique
    ]
    embeddings = np.asarray(embedding_function(texts), dtype=np.float32)
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    embeddings = embeddings / np.maximum(norms, 1e-12)

    selected = []
    selected_vectors = []
    for candidate, vector in zip(exact_unique, embeddings):
        if selected_vectors:
            similarities = np.asarray(selected_vectors) @ vector
            if float(np.max(similarities)) >= similarity_threshold:
                continue
        selected.append(candidate)
        selected_vectors.append(vector)
        if len(selected) >= target_count:
            break
    return selected


def write_markdown(path: str, concepts: list[dict[str, str]]) -> None:
    concepts = sorted(concepts, key=lambda concept: concept["name"].casefold())
    with open(path, "w", encoding="utf-8") as output_file:
        output_file.write(f"# Concepts\n\n{len(concepts)} concepts grounded in the indexed notes.\n\n")
        for concept in concepts:
            output_file.write(f"## {concept['name']}\n\n{concept['description']}\n\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-count", type=int, default=DEFAULT_TARGET)
    parser.add_argument("--sections-per-batch", type=int, default=DEFAULT_SECTIONS_PER_BATCH)
    parser.add_argument("--candidates-per-batch", type=int, default=DEFAULT_CANDIDATES_PER_BATCH)
    parser.add_argument("--notes-top-k", type=int, default=write_book.TOP_K)
    parser.add_argument("--similarity-threshold", type=float, default=DEFAULT_SIMILARITY_THRESHOLD)
    parser.add_argument("--system", action="append", help="Limit inputs to one or more book systems")
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--allow-cpu", action="store_true")
    args = parser.parse_args()

    if args.target_count < 1 or args.sections_per_batch < 1 or args.candidates_per_batch < 1:
        raise SystemExit("Counts and batch size must be positive integers.")
    if not 0 < args.similarity_threshold <= 1:
        raise SystemExit("--similarity-threshold must be greater than 0 and at most 1.")

    os.makedirs(write_book.INTERMEDIARY_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)

    all_rows = write_book.load_csv(write_book.CSV_FILE)
    available_systems = sorted({row["System"] for row in all_rows})
    requested_systems = set(args.system or available_systems)
    unknown_systems = requested_systems.difference(available_systems)
    if unknown_systems:
        raise SystemExit(
            f"Unknown systems: {', '.join(sorted(unknown_systems))}. "
            f"Available systems: {', '.join(available_systems)}"
        )

    selected_rows = [
        row for row in all_rows
        if row["System"] in requested_systems and write_book.should_generate_text(row)
    ]
    source_rows = interleave_systems(selected_rows, requested_systems)
    rows_by_system = {
        system: {
            write_book.row_key(row): row
            for row in all_rows
            if row["System"] == system
        }
        for system in requested_systems
    }
    row_batches = list(batches(source_rows, args.sections_per_batch))
    cached = load_cache(CACHE_FILE)
    missing_batches = [rows for rows in row_batches if batch_key(rows) not in cached]

    embedding_function = SentenceTransformerEmbeddingFunction(
        model_name="all-MiniLM-L6-v2",
        device="cpu",
    )
    client = write_book.chromadb.PersistentClient(path=write_book.DEFAULT_DB_DIR)
    collection = client.get_collection(
        name=write_book.COLLECTION_NAME,
        embedding_function=embedding_function,
    )
    print(
        f"Using {len(source_rows)} chapter sections and {collection.count()} indexed note chunks."
    )

    model = tokenizer = None
    if missing_batches:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        tokenizer = AutoTokenizer.from_pretrained(
            "Qwen/Qwen2.5-7B-Instruct",
            trust_remote_code=True,
        )
        model = write_book._load_model(
            "Qwen/Qwen2.5-7B-Instruct",
            device,
            allow_cpu=args.allow_cpu,
        )
        write_book.ensure_generation_device(model, args.allow_cpu)
        model.eval()

    all_candidates = []
    for batch_index, rows in enumerate(row_batches, start=1):
        key = batch_key(rows)
        if key not in cached:
            contexts = []
            for row in rows:
                query = write_book.build_query(row, rows_by_system[row["System"]])
                context = write_book.retrieve_context(collection, query, args.notes_top_k, write_book.lexical_hint(row))
                contexts.append(context[:DEFAULT_CONTEXT_CHARS])
            messages = build_concept_messages(rows, contexts, args.candidates_per_batch)
            response = write_book.generate_text(
                model,
                tokenizer,
                messages,
                max_new_tokens=MAX_CANDIDATE_TOKENS,
                do_sample=False,
            )
            try:
                candidates = parse_candidates(response)
            except (ValueError, json.JSONDecodeError) as exc:
                failure_path = save_failed_response(batch_index, response)
                raise RuntimeError(
                    f"Invalid concept response for batch {batch_index}; raw response saved to "
                    f"{failure_path}"
                ) from exc
            if not candidates:
                failure_path = save_failed_response(batch_index, response)
                raise RuntimeError(
                    f"No valid concepts returned for batch {batch_index}; raw response saved to "
                    f"{failure_path}"
                )
            append_cache(CACHE_FILE, key, candidates)
            cached[key] = candidates
            print(f"Generated batch {batch_index}/{len(row_batches)}: {len(candidates)} candidates")
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        all_candidates.extend(cached[key])

    concepts = deduplicate_candidates(
        all_candidates,
        embedding_function,
        args.target_count,
        args.similarity_threshold,
    )
    write_markdown(args.output, concepts)
    print(
        f"Wrote {len(concepts)} concepts from {len(all_candidates)} candidates to {args.output}"
    )
    if len(concepts) < args.target_count:
        print(
            "Fewer concepts survived deduplication than requested. Lower "
            "--similarity-threshold or increase --candidates-per-batch to retain more."
        )


if __name__ == "__main__":
    main()