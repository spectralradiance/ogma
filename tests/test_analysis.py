import importlib.util
import os
from pathlib import Path
import sys

import numpy as np


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "analyze_corpus.py"
SPEC = importlib.util.spec_from_file_location("ogma_analyze_corpus", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
analysis = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = analysis
SPEC.loader.exec_module(analysis)
read_text = analysis.read_text
readable_topic_label = analysis.readable_topic_label
term_key = analysis.term_key
chaos_level = analysis.chaos_level
level_frequencies = analysis.level_frequencies


def test_read_text_removes_zim_export_headers(tmp_path: Path) -> None:
    source = tmp_path / "page.txt"
    source.write_text(
        "Content-Type: text/x-zim-wiki\n"
        "Wiki-Format: zim 0.4\n"
        "Creation-Date: 2016-01-14T02:08:02-08:00\n\n"
        "A philosophical note that genuinely mentions Zim Desktop Wiki.",
        encoding="utf-8",
    )

    cleaned = read_text(source, max_chars=1000)

    assert "Content-Type" not in cleaned
    assert "Wiki-Format" not in cleaned
    assert "Creation-Date" not in cleaned
    assert "genuinely mentions Zim Desktop Wiki" in cleaned


def test_readable_topic_label_deduplicates_and_removes_generic_terms() -> None:
    assert term_key("souls") == term_key("soul")
    assert readable_topic_label(["souls", "soul", "self", "chaos", "ritual"]) == "Souls / Chaos / Ritual"


def test_chaos_level_parses_numbered_and_suffixed_directories() -> None:
    assert chaos_level(Path("chaos/001-020/001/note.txt")) == ("001-020", 1)
    assert chaos_level(Path("chaos/281-300/299 and three quarters/note")) == ("281-300", 299)
    assert chaos_level(Path("notes/001-020/001/note.txt")) == (None, None)
    assert chaos_level(Path("chaos/001-020/099/note.txt")) == (None, None)


def test_level_frequencies_normalize_by_documents_at_each_level() -> None:
    records = [
        {"level": 1, "level_range": "001-020", "topic": 0, "topic_name": "Ecology", "keyword_terms": ["forest"]},
        {"level": 1, "level_range": "001-020", "topic": 1, "topic_name": "Myth", "keyword_terms": []},
        {"level": 2, "level_range": "001-020", "topic": 0, "topic_name": "Ecology", "keyword_terms": ["forest"]},
    ]

    documents, topics, keywords = level_frequencies(records, [("forest", 1.0)])

    assert documents == [
        {"level": 1, "level_range": "001-020", "document_count": 2},
        {"level": 2, "level_range": "001-020", "document_count": 1},
    ]
    ecology = [row for row in topics if row["topic"] == 0]
    assert [row["prevalence"] for row in ecology] == [0.5, 1.0]
    assert [row["prevalence"] for row in keywords] == [0.5, 1.0]


def test_indexed_chunk_key_maps_files_under_indexed_roots_only(tmp_path: Path) -> None:
    notes_root = tmp_path / "input" / "writing-desktop"
    other_root = tmp_path / "elsewhere"
    notes_root.mkdir(parents=True)
    other_root.mkdir(parents=True)
    original_roots, original_input_dir = analysis.INDEXED_ROOTS, analysis.paths.INPUT_DIR
    try:
        analysis.INDEXED_ROOTS = [notes_root]
        analysis.paths.INPUT_DIR = str(tmp_path / "input")

        # index_notes.py stores rel_path via a raw os.path.relpath() call, which
        # uses OS-native separators (backslashes on Windows) — this must match
        # that exactly, not a posix-normalized path, or every lookup misses.
        assert analysis.indexed_chunk_key(notes_root / "sub" / "note.md") == ("writing-desktop", os.path.join("sub", "note.md"))
        assert analysis.indexed_chunk_key(other_root / "note.md") is None
    finally:
        analysis.INDEXED_ROOTS, analysis.paths.INPUT_DIR = original_roots, original_input_dir


def test_fetch_pooled_embeddings_normalizes_before_and_after_pooling(tmp_path: Path) -> None:
    db_dir = tmp_path / "chroma_db"
    client = analysis.chromadb.PersistentClient(path=str(db_dir))
    collection = client.get_or_create_collection(name=analysis.index_notes.COLLECTION_NAME)
    collection.add(
        ids=["writing-desktop/note.md::0", "writing-desktop/note.md::1", "writing-desktop/other.md::0"],
        embeddings=[[3.0, 4.0], [0.0, 5.0], [1.0, 0.0]],
        metadatas=[
            {"source": "writing-desktop", "rel_path": "note.md"},
            {"source": "writing-desktop", "rel_path": "note.md"},
            {"source": "writing-desktop", "rel_path": "other.md"},
        ],
        documents=["chunk one", "chunk two", "unrelated chunk"],
    )

    pooled = analysis.fetch_pooled_embeddings(db_dir, {("writing-desktop", "note.md")})

    assert set(pooled) == {("writing-desktop", "note.md")}
    vector = pooled[("writing-desktop", "note.md")]
    assert abs(float(np.linalg.norm(vector)) - 1.0) < 1e-6
    # [3, 4] and [0, 5] each normalize to unit length first ([0.6, 0.8] and
    # [0, 1]), average to [0.3, 0.9], then that mean is renormalized.
    expected = np.array([0.3, 0.9])
    expected = expected / np.linalg.norm(expected)
    assert np.allclose(vector, expected, atol=1e-5)


def test_fetch_pooled_embeddings_pages_through_large_stores(tmp_path: Path) -> None:
    # Regression test: a single unfiltered collection.get() over the whole
    # store crashed with "too many SQL variables" once the index held more
    # than a few thousand chunks. A tiny page size here exercises the same
    # multi-page code path without needing thousands of rows in a test.
    original_page_size = analysis.INDEX_FETCH_PAGE_SIZE
    try:
        analysis.INDEX_FETCH_PAGE_SIZE = 2
        db_dir = tmp_path / "chroma_db"
        client = analysis.chromadb.PersistentClient(path=str(db_dir))
        collection = client.get_or_create_collection(name=analysis.index_notes.COLLECTION_NAME)
        # Five chunks across two files, spread over three pages of two rows each.
        collection.add(
            ids=[f"writing-desktop/note.md::{i}" for i in range(4)] + ["writing-desktop/other.md::0"],
            embeddings=[[1.0, 0.0]] * 4 + [[0.0, 1.0]],
            metadatas=[{"source": "writing-desktop", "rel_path": "note.md"}] * 4
            + [{"source": "writing-desktop", "rel_path": "other.md"}],
            documents=[f"chunk {i}" for i in range(5)],
        )

        pooled = analysis.fetch_pooled_embeddings(
            db_dir, {("writing-desktop", "note.md"), ("writing-desktop", "other.md")}
        )

        assert set(pooled) == {("writing-desktop", "note.md"), ("writing-desktop", "other.md")}
        assert np.allclose(pooled[("writing-desktop", "note.md")], [1.0, 0.0], atol=1e-5)
        assert np.allclose(pooled[("writing-desktop", "other.md")], [0.0, 1.0], atol=1e-5)
    finally:
        analysis.INDEX_FETCH_PAGE_SIZE = original_page_size
