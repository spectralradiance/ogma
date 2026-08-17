import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "analyze_corpus.py"
SPEC = importlib.util.spec_from_file_location("sift_analyze_corpus", MODULE_PATH)
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
