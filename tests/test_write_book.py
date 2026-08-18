import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "write_book.py"
SPEC = importlib.util.spec_from_file_location("sift_write_book", MODULE_PATH)
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
        description="A self-confirming relation.",
        chapter="1",
        chapter_name="Existence",
        system="Tree of Life",
    )

    assert "3 paragraphs" in manuscript
    assert "10 distinct" in concepts
    assert '"Tautology"' in training