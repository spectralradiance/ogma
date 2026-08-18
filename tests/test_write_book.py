import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "write_book.py"
SPEC = importlib.util.spec_from_file_location("sylph_write_book", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
write_book = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = write_book
SPEC.loader.exec_module(write_book)


def test_generate_english_text_retries_cjk_output(monkeypatch) -> None:
    responses = iter(["存在是自我维持的。", "Existence is self-sustaining."])
    attempts = []

    def fake_generate_text(*args, **kwargs) -> str:
        attempts.append((args, kwargs))
        return next(responses)

    monkeypatch.setattr(write_book, "generate_text", fake_generate_text)

    prose = write_book.generate_english_text(object(), object(), [], 100)

    assert prose == "Existence is self-sustaining."
    assert len(attempts) == 2


def test_manuscript_validation_rejects_outline_and_truncation() -> None:
    assert write_book.manuscript_validation_error("## Central Claim\n\nProse.")
    assert write_book.manuscript_validation_error("1. First item\n2. Second item")
    assert write_book.manuscript_validation_error("A sentence cut off in the middle")
    assert write_book.manuscript_validation_error(
        "First complete paragraph.\n\nSecond complete paragraph.\n\nThird complete paragraph."
    ) is None


def test_plan_validation_rejects_duplicate_fenced_or_truncated_plans() -> None:
    valid = """- Note-grounded title: Digital Transformation.
- Scope and chronological position: After agriculture.
- Transition from previous section: Technology scales civilization.
- Central claim: Industrial and digital systems transform society.
- Ordered principles to cover: Energy, machinery, computation.
- Essential concepts and evidence: Factories and networks.
- Important terms and phrases from the notes: Industrialization, digitalization.
- Material reserved for other sections: Personal development."""
    assert write_book.plan_validation_error(valid) is None
    assert write_book.plan_validation_error(f"```markdown\n{valid}\n```")
    assert write_book.plan_validation_error(f"{valid}\n- Central claim: Duplicate.")
    assert write_book.plan_validation_error(valid.rstrip('.'))


def test_guidance_is_loaded_from_input_file() -> None:
    guidance = write_book.load_guidance()

    assert guidance["manuscript"]["style_tiers"] == write_book.GUIDANCE["manuscript"]["style_tiers"]
    assert "{n_paragraphs}" in guidance["manuscript"]["instructions"]
    assert "Write exclusively in English" in guidance["manuscript"]["system"]


def test_guidance_templates_accept_runtime_fields() -> None:
    guidance = write_book.GUIDANCE

    manuscript = guidance["manuscript"]["instructions"].format(
        n_paragraphs=3,
        style_instruction=guidance["manuscript"]["style_tiers"][0],
    )
    concepts = guidance["concepts"]["instructions"].format(
        candidate_count=10,
        source_material="Section evidence",
    )
    training = guidance["training"]["dataset_instruction"].format(
        name="Tautology",
        chapter="1",
        chapter_name="Existence",
        system="Tree of Life",
    )

    assert "3 paragraphs" in manuscript
    assert "10 distinct" in concepts
    assert '"Tautology"' in training


def sample_rows() -> tuple[dict, dict, dict]:
    chapter = {
        "System": "Tree of Life", "Chapter": "1", "Sub-Chapter": "1",
        "Sub-Sub-Chapter": "", "Name": "Substance", "Generate Text": "No",
        "Description": "POISON CHAPTER DESCRIPTION", "Alternative Names": "POISON ALIAS",
    }
    subchapter = {
        "System": "Tree of Life", "Chapter": "1", "Sub-Chapter": "1.2",
        "Sub-Sub-Chapter": "", "Name": "Nature", "Generate Text": "No",
        "Description": "POISON SUBCHAPTER DESCRIPTION", "Alternative Names": "POISON ALIAS",
    }
    section = {
        "System": "Tree of Life", "Chapter": "1", "Sub-Chapter": "1.2",
        "Sub-Sub-Chapter": "1.2.1", "Name": "[Limit of Logic]", "Generate Text": "Yes",
        "Description": "POISON SECTION DESCRIPTION", "Alternative Names": "POISON ALIAS",
    }
    return chapter, subchapter, section


def test_csv_descriptions_and_aliases_do_not_enter_retrieval_or_planning() -> None:
    chapter, subchapter, section = sample_rows()
    rows = [chapter, subchapter, section]
    rows_by_key = {write_book.row_key(row): row for row in rows}

    query = write_book.build_query(section, rows_by_key)
    messages = write_book.build_outline_messages(section, [section], "NOTE EVIDENCE")
    prompt = "\n".join(message["content"] for message in messages)

    assert query == "Tree of Life Substance Nature [Limit of Logic]"
    assert "POISON" not in query + prompt
    assert "Optional AI-generated name suggestion: Limit of Logic" in prompt
    assert "NOTE EVIDENCE" in prompt


def test_grounded_titles_replace_provisional_hierarchy_names(tmp_path: Path) -> None:
    chapter, subchapter, section = sample_rows()
    rows = [chapter, subchapter, section]
    rows_by_key = {write_book.row_key(row): row for row in rows}
    structures = {
        write_book.section_key(chapter): "- Note-grounded title: Evolutionary Cognition\n- Detailed description: Broad scope.",
        write_book.section_key(subchapter): "- Note-grounded title: Inherent Bias\n- Detailed description: Specific scope.",
    }
    plans = {
        write_book.section_key(section): "- Note-grounded title: Teleological Fallacy\n- Central claim: Benefit shapes belief."
    }
    output = tmp_path / "outline.md"

    write_book.write_human_outline(
        str(output), "Tree of Life", [section], plans, rows_by_key, structures
    )
    content = output.read_text(encoding="utf-8")

    assert "## 1 Evolutionary Cognition" in content
    assert "### 1.2 Inherent Bias" in content
    assert "#### 1.2.1 Teleological Fallacy" in content


def test_retrieval_downranks_skeletal_outlines() -> None:
    outline = "\n".join(f"## {index} Heading" for index in range(10))
    prose = "Evolution shapes practical belief. We project useful expectations onto reality."

    assert write_book._retrieval_score(outline, 0.2, True) > write_book._retrieval_score(
        prose, 0.2, True
    )


def test_query_expansion_uses_recurring_note_context() -> None:
    documents = [
        "The pathetic fallacy projects subjective preferences onto objective reality.",
        "Pathetic fallacy means projection of the subjective upon reality.",
        "Evolutionary perception encourages the pathetic fallacy.",
    ]

    terms = write_book.query_expansion_terms(documents, "Fallacy", "Tree of Life Fallacy")

    assert "pathetic" in terms
    assert "subjective" in terms
    assert "reality" in terms