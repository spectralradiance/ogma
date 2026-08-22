import importlib.util
from pathlib import Path
import sys
import types


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "write_book.py"
SPEC = importlib.util.spec_from_file_location("ogma_write_book", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
write_book = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = write_book
SPEC.loader.exec_module(write_book)


def test_split_model_defaults() -> None:
    assert write_book.DEFAULT_EXTRACT_MODEL == "Qwen/Qwen2.5-3B-Instruct"
    assert write_book.DEFAULT_WRITE_MODEL == "Qwen/Qwen2.5-3B-Instruct"
    assert write_book.DEFAULT_CLAUDE_MODEL == "claude-opus-5"


def test_claude_provider_replaces_local_defaults() -> None:
    provider, extract, write = write_book.resolve_generation_models(
        "claude",
        "Qwen/Qwen2.5-3B-Instruct",
        "Qwen/Qwen2.5-3B-Instruct",
        None,
    )
    assert provider == "claude"
    assert extract == write_book.DEFAULT_CLAUDE_MODEL
    assert write == write_book.DEFAULT_CLAUDE_MODEL


def test_claude_model_name_selects_claude_backend() -> None:
    provider, extract, write = write_book.resolve_generation_models(
        "local", "claude-sonnet-4-5", "Qwen/Qwen2.5-3B-Instruct", None
    )
    assert provider == "claude"
    assert extract == "claude-sonnet-4-5"
    assert write == write_book.DEFAULT_CLAUDE_MODEL


def test_claude_messages_merge_consecutive_user_turns() -> None:
    system, converted = write_book.claude_messages([
        {"role": "system", "content": "Be precise."},
        {"role": "user", "content": "Plan this."},
        {"role": "user", "content": "Retry."},
    ])
    assert system == "Be precise."
    assert converted == [{"role": "user", "content": "Plan this.\n\nRetry."}]


def test_generate_claude_text_omits_temperature(monkeypatch) -> None:
    captured = {}

    class FakeMessages:
        def create(self, **kwargs):
            captured.update(kwargs)

            class Block:
                text = "ok"

            class Response:
                content = [Block()]

            return Response()

    class FakeClient:
        def __init__(self, api_key=None):
            self.messages = FakeMessages()

    fake_anthropic = types.ModuleType("anthropic")
    fake_anthropic.Anthropic = FakeClient
    monkeypatch.setattr(write_book, "claude_api_key", lambda: "test-key")
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic)
    text = write_book.generate_claude_text(
        "claude-opus-5",
        [{"role": "system", "content": "Be precise."}, {"role": "user", "content": "Write."}],
        40,
        True,
    )
    assert text == "ok"
    assert "temperature" not in captured
    assert captured["model"] == "claude-opus-5"
    assert captured["max_tokens"] == write_book.CLAUDE_MAX_OUTPUT_TOKENS
    assert captured["thinking"] == {"type": "disabled"}
    assert captured["output_config"] == {"effort": "high"}
    assert captured["system"] == "Be precise."
    assert captured["messages"] == [{"role": "user", "content": "Write."}]


def test_generate_claude_text_continues_after_max_tokens(monkeypatch) -> None:
    calls = []

    class Block:
        def __init__(self, text):
            self.type = "text"
            self.text = text

    class FakeMessages:
        def create(self, **kwargs):
            calls.append(kwargs)

            class Response:
                def __init__(self, text, stop):
                    self.content = [Block(text)]
                    self.stop_reason = stop

            if len(calls) == 1:
                return Response("Start of the argument", "max_tokens")
            return Response(" continues here.", "end_turn")

    class FakeClient:
        def __init__(self, api_key=None):
            self.messages = FakeMessages()

    fake_anthropic = types.ModuleType("anthropic")
    fake_anthropic.Anthropic = FakeClient
    monkeypatch.setattr(write_book, "claude_api_key", lambda: "test-key")
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic)
    text = write_book.generate_claude_text(
        "claude-opus-5",
        [{"role": "user", "content": "Write."}],
        40,
        True,
    )
    assert text == "Start of the argument continues here."
    assert len(calls) == 2


def test_claude_visible_text_skips_thinking_blocks() -> None:
    class Block:
        def __init__(self, type_name, text=None):
            self.type = type_name
            self.text = text

    class Response:
        content = [Block("thinking", ""), Block("text", "Labeled plan.")]

    assert write_book.claude_visible_text(Response()) == "Labeled plan."


def test_generate_plan_text_retries_with_assistant_turn(monkeypatch) -> None:
    valid = """- Note-grounded title: Digital Transformation.
- Scope and chronological position: After agriculture.
- Transition from previous section: Technology scales civilization.
- Central claim: Industrial and digital systems transform society.
- Ordered principles to cover: Energy, machinery, computation.
- Essential concepts and evidence: Factories and networks.
- Important terms and phrases from the notes: Industrialization, digitalization.
- Material reserved for other sections: Personal development."""
    seen = []

    def fake_generate_text(model, tokenizer, messages, max_new_tokens, do_sample):
        seen.append([message["role"] for message in messages])
        if len(seen) == 1:
            return "not a plan"
        return valid

    monkeypatch.setattr(write_book, "generate_text", fake_generate_text)
    plan = write_book.generate_plan_text(object(), object(), [{"role": "user", "content": "Plan."}])
    assert plan == valid
    assert seen[1][:3] == ["user", "assistant", "user"]


def test_write_outline_block_replaces_empty_structure(tmp_path) -> None:
    path = tmp_path / "writing_plan.md"
    row = {
        "System": "Invocation",
        "Chapter": "1",
        "Sub-Chapter": "1",
        "Sub-Sub-Chapter": "",
        "Name": "Protasis",
        "Generate Text": "No",
    }
    write_book.append_structure(path, row, "")
    write_book.append_structure(path, row, "- Note-grounded title: Protasis.")
    content = path.read_text(encoding="utf-8")
    assert content.count("<!-- structure:") == 1
    assert "- Note-grounded title: Protasis." in content
    loaded = write_book.load_structure(path)
    assert write_book.has_grounded_plan(next(iter(loaded.values())))
    assert not write_book.has_grounded_plan("## Structure 1")


def test_generate_text_uses_claude_when_tokenizer_is_missing(monkeypatch) -> None:
    captured = {}

    def fake_claude(model_name, messages, max_new_tokens, do_sample):
        captured["model"] = model_name
        captured["do_sample"] = do_sample
        return "Verse line."

    monkeypatch.setattr(write_book, "generate_claude_text", fake_claude)
    text = write_book.generate_text(
        "claude-opus-5", None, [{"role": "user", "content": "hi"}], 40, True
    )
    assert text == "Verse line."
    assert captured["model"] == "claude-opus-5"
    assert captured["do_sample"] is True


def test_strip_thinking_removes_qwen3_blocks() -> None:
    raw = "<think>internal plan</think>\n\nExistence is self-sustaining."
    assert write_book.strip_thinking(raw) == "Existence is self-sustaining."


def test_format_chat_disables_thinking_when_template_supports_it() -> None:
    class Tokenizer:
        chat_template = "{% if enable_thinking %}think{% endif %}"
        kwargs = None

        def apply_chat_template(self, messages, **kwargs):
            self.kwargs = kwargs
            return "prompt"

    tokenizer = Tokenizer()
    prompt = write_book.format_chat(tokenizer, [{"role": "user", "content": "hi"}])

    assert prompt == "prompt"
    assert tokenizer.kwargs["enable_thinking"] is False


def test_format_chat_omits_thinking_flag_for_plain_templates() -> None:
    class Tokenizer:
        chat_template = "{{ messages }}"
        kwargs = None

        def apply_chat_template(self, messages, **kwargs):
            self.kwargs = kwargs
            return "prompt"

    tokenizer = Tokenizer()
    write_book.format_chat(tokenizer, [{"role": "user", "content": "hi"}])

    assert "enable_thinking" not in tokenizer.kwargs


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


def test_generate_english_text_keeps_complete_sentences_when_cut_off(monkeypatch) -> None:
    clipped = (
        "First complete paragraph of philosophical prose that ends properly.\n\n"
        "Second complete paragraph that also finishes with a period.\n\n"
        "Third complete paragraph that is long enough to keep in the salvage. The next clause is cut"
    )
    monkeypatch.setattr(write_book, "generate_text", lambda *args, **kwargs: clipped)
    prose = write_book.generate_english_text(object(), object(), [], 100)
    assert prose.endswith("salvage.")
    assert "is cut" not in prose


def test_manuscript_validation_rejects_outline_and_truncation() -> None:
    assert write_book.manuscript_validation_error("## Central Claim\n\nProse.")
    assert write_book.manuscript_validation_error("1. First item\n2. Second item")
    assert write_book.manuscript_validation_error(
        "First complete paragraph.\n\nSecond complete paragraph.\n\nThird complete paragraph."
    ) is None
    clipped = (
        "First complete paragraph of philosophical prose that ends properly.\n\n"
        "Second complete paragraph that also finishes with a period.\n\n"
        "Third complete paragraph that is long enough to keep in the salvage. The next clause is cut"
    )
    closed = write_book.close_truncated_prose(clipped)
    assert closed.endswith("salvage.")
    assert "is cut" not in closed
    assert write_book.manuscript_validation_error(closed) is None
    assert write_book.manuscript_validation_error("A sentence cut off in the middle")
    verse = (
        "The first fire remembers its name in the well.\n\n"
        "A second mouth answers from the dark water."
    )
    assert write_book.manuscript_validation_error(verse, form="poetry") is None
    assert write_book.manuscript_validation_error("Too short", form="poetry")
    long_line_poem = "\n".join(
        [
            "The first fire remembers its name in the well.",
            "A second mouth answers from the dark water.",
            "And then a much longer line that keeps adding clauses until the breath runs out of room entirely.",
            "Another stretched sentence follows it with still more extra furniture and no line break at all.",
            "So the meter check has several lines clearly outside the intended syllable range.",
        ]
    )
    assert "8-16 syllables" in write_book.manuscript_validation_error(long_line_poem, form="poetry")


def test_strip_leading_markdown_headings_salvages_titled_verse() -> None:
    raw = (
        "# Youth\n\n"
        "The first fire remembers its name in the well.\n\n"
        "A second mouth answers from the dark water."
    )
    cleaned = write_book.strip_leading_markdown_headings(raw)
    assert cleaned.startswith("The first fire")
    assert write_book.manuscript_validation_error(cleaned, form="poetry") is None


def test_trim_trailing_manuscript_headings_removes_orphan_titles(tmp_path) -> None:
    path = tmp_path / "manuscript.md"
    path.write_text("# Invocation\n\nVerse remains.\n\n## 1 Protasis\n\n### 1.1 Youth\n\n", encoding="utf-8")
    write_book.trim_trailing_manuscript_headings(path)
    assert "Protasis" not in path.read_text(encoding="utf-8")
    assert path.read_text(encoding="utf-8").replace("\r\n", "\n").endswith("Verse remains.\n")


def test_generate_english_text_retries_with_assistant_turn(monkeypatch) -> None:
    verse = (
        "The first fire remembers its name in the well.\n\n"
        "A second mouth answers from the dark water."
    )
    seen = []

    def fake_generate_text(model, tokenizer, messages, max_new_tokens, do_sample):
        seen.append([message["role"] for message in messages])
        if len(seen) == 1:
            return f"{verse}\n\n## Later\n\nAnother stanza still headed."
        return verse

    monkeypatch.setattr(write_book, "generate_text", fake_generate_text)
    prose = write_book.generate_english_text(
        object(), object(), [{"role": "user", "content": "Write."}], 100, form="poetry"
    )
    assert prose == verse
    assert seen[1][:3] == ["user", "assistant", "user"]


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
    assert "{style_instruction}" in guidance["manuscript"]["instructions"]
    assert "{n_paragraphs}" not in guidance["manuscript"]["instructions"]
    assert "Write exclusively in English" in guidance["manuscript"]["system"]


def test_guidance_templates_accept_runtime_fields() -> None:
    guidance = write_book.GUIDANCE

    manuscript = guidance["manuscript"]["instructions"].format(
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

    assert "fixed paragraph count" in manuscript
    assert "first person only in the book introduction" in manuscript
    assert "10 distinct" in concepts
    assert '"Tautology"' in training


def test_invocation_uses_poetry_manuscript_guidance() -> None:
    invocation = write_book.guidance_for("manuscript", "Invocation")
    evocation = write_book.guidance_for("manuscript", "Evocation")
    outline = write_book.guidance_for("outline", "Invocation")

    assert invocation["form"] == "poetry"
    assert "finished poetry" in invocation["system"]
    assert "as poetry, not philosophical prose" in invocation["instructions"]
    assert "first person only in the book introduction" in invocation["instructions"]
    assert "8 to 16 syllables" in invocation["system"]
    assert "8 to 16 syllables" in invocation["instructions"]
    assert "8 to 16 syllables" in outline["instructions"]
    assert evocation.get("form", "prose") == "prose"
    assert "flowing paragraphs" in evocation["system"]
    assert "sequence of poems" in outline["system"]
    assert "Do not write finished verse." in outline["instructions"]

    section = {
        "System": "Invocation", "Chapter": "1", "Sub-Chapter": "1.1",
        "Sub-Sub-Chapter": "", "Name": "Youth", "Generate Text": "Yes",
        "Description": "", "Alternative Names": "",
    }
    rows_by_key = {write_book.row_key(section): section}
    messages = write_book.build_messages(section, rows_by_key, "NOTE EVIDENCE", "- Note-grounded title: Youth.")
    prompt = "\n".join(message["content"] for message in messages)

    assert "composing Invocation as verse" in prompt
    assert "flowing paragraphs" not in prompt
    assert "NOTE EVIDENCE" in prompt
    assert "This is not the book introduction" in prompt
    assert 'Do not refer to the writer as "I"' in prompt

    intro = {
        "System": "Evocation", "Chapter": "0", "Sub-Chapter": "",
        "Sub-Sub-Chapter": "", "Name": "Introduction", "Generate Text": "Yes",
        "Description": "", "Alternative Names": "",
    }
    intro_prompt = "\n".join(
        message["content"]
        for message in write_book.build_messages(
            intro,
            {write_book.row_key(intro): intro},
            "NOTE EVIDENCE",
            "- Note-grounded title: Opening.",
        )
    )
    assert "This is the book introduction" in intro_prompt
    assert "Write in the first person as the writer" in intro_prompt


def test_manuscript_voice_rejects_author_and_non_intro_first_person() -> None:
    impersonal = (
        "Existence is self-sustaining under these conditions.\n\n"
        "The argument follows from the notes without a personal frame."
    )
    assert write_book.manuscript_validation_error(impersonal) is None
    assert write_book.manuscript_validation_error(
        "The word the author has held for this phase carries its meaning in its etymology."
    )
    assert write_book.manuscript_validation_error(
        "I will now explain why substance precedes sentience in this order."
    )
    assert write_book.manuscript_validation_error(
        "I begin from doubt, and I keep the first person only here.",
        book_introduction=True,
    ) is None
    assert write_book.manuscript_validation_error(
        "The author begins from doubt in this introduction.",
        book_introduction=True,
    )


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