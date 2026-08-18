"""
RAG-driven manuscript generator.

Loads the metaphysics CSV, queries a local ChromaDB vector store for
relevant notes, and prompts Qwen 2.5 7B Instruct to write authoritative
philosophical prose for each section.

Usage:
    python write_book.py [--db-dir PATH] [--notes-top-k N]

Requires index_notes.py to have been run first.
"""

import argparse
import csv
import json
import os
import re
import shutil

import chromadb
import torch
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)
DATA_DIR = os.path.join(PROJECT_DIR, "data")
CSV_FILE = os.path.join(DATA_DIR, "input", "chapter_structure.csv")
GUIDANCE_FILE = os.path.join(DATA_DIR, "input", "guidance.json")
INTERMEDIARY_DIR = os.path.join(DATA_DIR, "intermediary")
OUTPUT_DIR = os.path.join(DATA_DIR, "output")
PROGRESS_FILE = os.path.join(INTERMEDIARY_DIR, "write_book_progress.json")
DEFAULT_DB_DIR = os.path.join(INTERMEDIARY_DIR, "chroma_db")
COLLECTION_NAME = "notes"
PIPELINE_VERSION = "outline-v3"

MAX_SEQ_LENGTH = 4096
MAX_NEW_TOKENS = 900
PARAGRAPHS_PER_SECTION = 3
TOP_K = 5
DEFAULT_SYSTEM = "Universal Metaphysics"
MAX_LANGUAGE_RETRIES = 3
CJK_PATTERN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def load_guidance(path: str = GUIDANCE_FILE) -> dict:
    """Load editable domain and style instructions used by model prompts."""
    with open(path, encoding="utf-8") as guidance_file:
        return json.load(guidance_file)


GUIDANCE = load_guidance()


def load_csv(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def row_key(row: dict) -> tuple[str, str, str, str]:
    return (
        row["System"],
        row["Chapter"],
        row["Sub-Chapter"],
        row["Sub-Sub-Chapter"],
    )


def section_key(row: dict) -> str:
    return f"{PIPELINE_VERSION}|{row['System']}|{section_number(row)}"


def section_number(row: dict) -> str:
    if row["Sub-Sub-Chapter"].strip():
        return row["Sub-Sub-Chapter"]
    if is_chapter_introduction(row):
        return f"{row['Chapter']}.0"
    return row["Sub-Chapter"]


def safe_name(system: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", system.lower()).strip("_")


def outline_path(system: str, intermediary_dir: str = INTERMEDIARY_DIR) -> str:
    version = PIPELINE_VERSION.removeprefix("outline-")
    return os.path.join(intermediary_dir, f"{safe_name(system)}_outline_{version}.md")


def manuscript_path(system: str, output_dir: str = OUTPUT_DIR) -> str:
    return os.path.join(output_dir, f"{safe_name(system)}.md")


def run_paths(system: str, run_id: str | None) -> dict[str, str]:
    if not run_id:
        return {
            "intermediary_dir": INTERMEDIARY_DIR,
            "output_dir": OUTPUT_DIR,
            "outline": outline_path(system),
            "human_outline": os.path.join(OUTPUT_DIR, f"{safe_name(system)}_outline.md"),
            "manuscript": manuscript_path(system),
            "progress": PROGRESS_FILE,
        }
    book_name = safe_name(system)
    intermediary_dir = os.path.join(INTERMEDIARY_DIR, run_id, book_name)
    output_dir = os.path.join(OUTPUT_DIR, run_id, book_name)
    return {
        "intermediary_dir": intermediary_dir,
        "output_dir": output_dir,
        "outline": os.path.join(intermediary_dir, "writing_plan.md"),
        "human_outline": os.path.join(output_dir, "outline.md"),
        "manuscript": os.path.join(output_dir, "manuscript.md"),
        "progress": os.path.join(intermediary_dir, "progress.json"),
    }


def is_chapter_introduction(row: dict) -> bool:
    name = row["Name"].strip().lower()
    return not row["Sub-Sub-Chapter"].strip() and (
        name == "introduction" or name.endswith(" - introduction")
    )


def should_generate_text(row: dict) -> bool:
    value = row.get("Generate Text", "").strip().lower()
    if value not in {"yes", "no"}:
        raise ValueError(
            f"Invalid Generate Text value {row.get('Generate Text')!r} for "
            f"{row.get('System')} {section_number(row)} {row.get('Name')}"
        )
    return value == "yes"


def chapter_title(row: dict) -> str:
    suffix = " - Introduction"
    return row["Name"][:-len(suffix)] if row["Name"].endswith(suffix) else row["Name"]


def find_chapter_row(row: dict, rows_by_key: dict) -> dict | None:
    system = row["System"]
    chapter = row["Chapter"]
    title_row = rows_by_key.get((system, chapter, "", ""))
    if title_row and not is_chapter_introduction(title_row):
        return title_row
    return next(
        (
            candidate for candidate in rows_by_key.values()
            if candidate["System"] == system
            and candidate["Chapter"] == chapter
            and is_chapter_introduction(candidate)
        ),
        title_row,
    )


def build_query(row: dict, rows_by_key: dict) -> str:
    system = row["System"]
    chapter_row = find_chapter_row(row, rows_by_key)
    sub_row = rows_by_key.get((system, row["Chapter"], row["Sub-Chapter"], ""))
    parts = [
        system,
        chapter_title(chapter_row) if chapter_row else "",
        sub_row["Name"] if sub_row else "",
        row["Name"],
        row.get("Description", ""),
        row.get("Alternative Names", ""),
    ]
    return " ".join(p for p in parts if p).strip()


def retrieve_context(collection, query: str, k: int) -> str:
    results = collection.query(query_texts=[query], n_results=k, include=["documents", "metadatas"])
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    if not docs:
        return ""
    excerpts = []
    for doc, meta in zip(docs, metas):
        source = meta.get("filename", "note")
        excerpts.append(f"[{source}]\n{doc.strip()}")
    return "\n\n---\n\n".join(excerpts)


def chapter_structure(row: dict, section_rows: list[dict]) -> str:
    chapter_rows = [candidate for candidate in section_rows if candidate["Chapter"] == row["Chapter"]]
    current_index = chapter_rows.index(row)
    lines = []
    for index, candidate in enumerate(chapter_rows):
        position = "CURRENT"
        if index < current_index:
            position = "ALREADY COVERED"
        elif index > current_index:
            position = "RESERVED FOR LATER"
        lines.append(
            f"- {position}: {section_number(candidate)} {candidate['Name']}: "
            f"{candidate.get('Description', '')}"
        )
    return "\n".join(lines)


def build_outline_messages(row: dict, section_rows: list[dict], context: str) -> list[dict]:
    return [
        {
            "role": "system",
            "content": GUIDANCE["outline"]["system"],
        },
        {
            "role": "user",
            "content": (
                f"Create a concise writing plan for {section_number(row)} {row['Name']}.\n"
                f"Section description: {row.get('Description', '')}\n\n"
                f"Chapter sequence and boundaries:\n{chapter_structure(row, section_rows)}\n\n"
                f"Relevant excerpts from the author's notes:\n{context}\n\n"
                f"{GUIDANCE['outline']['instructions']}"
            ),
        },
    ]


def load_outline(path: str) -> dict[str, str]:
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as outline_file:
        content = outline_file.read()
    pattern = re.compile(
        r"<!-- section: (?P<key>[^\n]+) -->\n(?P<plan>.*?)\n<!-- /section -->",
        re.DOTALL,
    )
    return {match["key"]: match["plan"].strip() for match in pattern.finditer(content)}


def append_outline(path: str, row: dict, plan: str) -> None:
    new_file = not os.path.exists(path)
    with open(path, "a", encoding="utf-8") as outline_file:
        if new_file:
            outline_file.write(f"# {row['System']} Writing Outline\n\n")
        outline_file.write(
            f"<!-- section: {section_key(row)} -->\n"
            f"## {section_number(row)} {row['Name']}\n\n"
            f"{plan.strip()}\n"
            "<!-- /section -->\n\n"
        )


def write_human_outline(
    path: str,
    system: str,
    section_rows: list[dict],
    plans: dict[str, str],
    rows_by_key: dict | None = None,
) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as outline_file:
        outline_file.write(f"# {system} Content Outline\n\n")
        current_chapter = None
        for row in section_rows:
            if row["Chapter"] != current_chapter:
                chapter_row = find_chapter_row(row, rows_by_key or {})
                chapter_name = chapter_title(chapter_row) if chapter_row else row["Name"]
                outline_file.write(f"## {row['Chapter']} {chapter_name}\n\n")
                current_chapter = row["Chapter"]
            outline_file.write(f"### {section_number(row)} {row['Name']}\n\n")
            plan = plans.get(section_key(row))
            if plan:
                outline_file.write(plan.strip() + "\n\n")
            else:
                outline_file.write("*Writing plan pending.*\n\n")


def style_instruction(row: dict, rows_by_key: dict) -> str:
    section_rows = [
        candidate for candidate in rows_by_key.values()
        if candidate["System"] == row["System"]
        and should_generate_text(candidate)
    ]
    # The book moves through three user-editable style phases from start to finish.
    position = section_rows.index(row) / max(len(section_rows) - 1, 1)
    style_tiers = GUIDANCE["manuscript"]["style_tiers"]

    if position < 1 / 3:
        return style_tiers[0]
    if position < 2 / 3:
        return style_tiers[1]
    return style_tiers[2]


def build_messages(
    row: dict,
    rows_by_key: dict,
    context: str,
    plan: str,
    n_paragraphs: int,
) -> list[dict]:
    system = row["System"]
    chapter_row = find_chapter_row(row, rows_by_key)
    sub_row = rows_by_key.get((system, row["Chapter"], row["Sub-Chapter"], ""))
    chapter_name = chapter_title(chapter_row) if chapter_row else system
    sub_name = sub_row["Name"] if sub_row else "Introduction"
    alt_names = f" Also known as: {row['Alternative Names']}." if row.get("Alternative Names") else ""

    context_block = (
        f"\n\nRelevant source excerpts from the author's notes:\n\n{context}"
    ) if context else ""

    # Runtime evidence frames the section; guidance.json supplies authorial policy and voice.
    number = section_number(row)
    instruction = (
        f"Book: \"{system}\".\n"
        f"Topic: \"{number}: {row['Name']}\". {row['Description']}{alt_names}\n"
        f"Context: section of \"{row['Sub-Chapter'] or number}: {sub_name}\" "
        f"in chapter \"{row['Chapter']}: {chapter_name}\". "
        "The book, chapter, and section labels above are authoritative; do not substitute "
        "similarly numbered material from another book."
        f"{context_block}\n\n"
        f"Required section plan:\n\n{plan}\n\n"
        + GUIDANCE["manuscript"]["instructions"].format(
            n_paragraphs=n_paragraphs,
            style_instruction=style_instruction(row, rows_by_key),
        )
    )

    return [
        {
            "role": "system",
            "content": GUIDANCE["manuscript"]["system"],
        },
        {"role": "user", "content": instruction},
    ]


def generate_text(
    model,
    tokenizer,
    messages: list[dict],
    max_new_tokens: int,
    do_sample: bool,
) -> str:
    text = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )
    device = next(model.parameters()).device
    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=MAX_SEQ_LENGTH - max_new_tokens,
    ).to(device)

    generation_options = {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
        "repetition_penalty": 1.15,
        "pad_token_id": tokenizer.eos_token_id,
    }
    if do_sample:
        generation_options.update(temperature=0.75, top_p=0.9)

    with torch.no_grad():
        output = model.generate(**inputs, **generation_options)

    input_len = inputs["input_ids"].shape[1]
    return tokenizer.decode(output[0][input_len:], skip_special_tokens=True).strip()


def generate_english_text(
    model,
    tokenizer,
    messages: list[dict],
    max_new_tokens: int,
) -> str:
    for attempt in range(1, MAX_LANGUAGE_RETRIES + 1):
        prose = generate_text(
            model,
            tokenizer,
            messages,
            max_new_tokens=max_new_tokens,
            do_sample=True,
        )
        if not CJK_PATTERN.search(prose):
            return prose
        print(
            f"  Rejected non-English generation; retrying "
            f"({attempt}/{MAX_LANGUAGE_RETRIES})"
        )
    raise RuntimeError(
        f"Generation contained CJK text after {MAX_LANGUAGE_RETRIES} attempts."
    )


def ensure_generation_device(model, allow_cpu: bool) -> None:
    if allow_cpu:
        return
    parameter_devices = {parameter.device.type for parameter in model.parameters()}
    if parameter_devices != {"cuda"}:
        raise SystemExit(
            f"Model parameters were loaded on {sorted(parameter_devices)}, not exclusively on CUDA. "
            "Generation was stopped to prevent CPU offloading."
        )
    print("Model placement verified: all parameters are on CUDA.")


def _load_model(model_name: str, device: str, allow_cpu: bool = False):
    """Load on CUDA when available; require explicit permission for CPU fallback."""
    if device == "cuda":
        for label, kwargs in [
            ("4-bit NF4", dict(
                quantization_config=BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                    bnb_4bit_compute_dtype=torch.bfloat16,
                ),
                device_map="auto",
            )),
            ("float16", dict(
                torch_dtype=torch.float16,
                device_map="auto",
            )),
        ]:
            try:
                print(f"  Trying {label}...")
                model = AutoModelForCausalLM.from_pretrained(
                    model_name, trust_remote_code=True, **kwargs
                )
                print(f"  Loaded with {label}")
                return model
            except Exception as exc:
                print(f"  {label} failed: {exc}")
        if not allow_cpu:
            raise SystemExit(
                "CUDA model loading failed. CPU fallback is disabled to prevent the computer "
                "from becoming unresponsive. Resolve the CUDA error above or pass --allow-cpu "
                "to opt in to slow CPU generation."
            )

    if not allow_cpu:
        raise SystemExit(
            "CUDA is not available. Generation requires a CUDA GPU by default to prevent the "
            "computer from becoming unresponsive. Pass --allow-cpu only if CPU generation is "
            "intentional."
        )

    print("WARNING: CPU generation explicitly enabled; this will be slow and memory intensive.")
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    return model.to("cpu")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-dir", default=DEFAULT_DB_DIR)
    parser.add_argument("--notes-top-k", type=int, default=TOP_K)
    parser.add_argument(
        "--system",
        required=True,
        help="Book to process, such as 'Universal Metaphysics' or 'Tree of Life'",
    )
    parser.add_argument(
        "--allow-cpu",
        action="store_true",
        help="Explicitly allow slow CPU generation when CUDA is unavailable or fails",
    )
    parser.add_argument(
        "--outline-only",
        action="store_true",
        help="Create or complete the note-grounded Markdown outline without writing prose",
    )
    parser.add_argument(
        "--status-only",
        action="store_true",
        help="Show outline and manuscript progress without loading Qwen or generating text",
    )
    parser.add_argument(
        "--run-id",
        help="Isolate artifacts under output/<run-id>/<book> and intermediary/<run-id>/<book>",
    )
    parser.add_argument(
        "--outline-cache",
        help="Copy an existing machine writing plan into this run before generation",
    )
    parser.add_argument(
        "--regenerate-outline",
        action="store_true",
        help="Discard this run's existing writing plan and generate it again",
    )
    args = parser.parse_args()

    paths = run_paths(args.system, args.run_id)
    os.makedirs(paths["intermediary_dir"], exist_ok=True)
    os.makedirs(paths["output_dir"], exist_ok=True)

    if args.outline_cache and args.regenerate_outline:
        raise SystemExit("Choose either --outline-cache or --regenerate-outline, not both.")
    if args.outline_cache:
        cache_path = os.path.abspath(args.outline_cache)
        if not os.path.isfile(cache_path):
            raise SystemExit(f"Outline cache not found: {cache_path}")
        if not os.path.exists(paths["outline"]):
            shutil.copyfile(cache_path, paths["outline"])
            print(f"Copied outline cache into run: {cache_path}")
    if args.regenerate_outline and os.path.exists(paths["outline"]):
        os.remove(paths["outline"])

    db_dir = os.path.normpath(args.db_dir)
    if not os.path.isdir(db_dir):
        raise SystemExit(
            f"ChromaDB directory not found: {db_dir}\n"
            "Run index_notes.py first."
        )

    # --- Connect to vector store ---
    ef = SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
    client = chromadb.PersistentClient(path=db_dir)
    collection = client.get_collection(name=COLLECTION_NAME, embedding_function=ef)
    print(f"Vector store loaded: {collection.count()} chunks")

    # --- Load CSV ---
    all_rows = load_csv(CSV_FILE)
    systems = sorted({row["System"] for row in all_rows})
    if args.system not in systems:
        raise SystemExit(
            f"Unknown system: {args.system}\nAvailable systems: {', '.join(systems)}"
        )
    rows = [row for row in all_rows if row["System"] == args.system]
    rows_by_key: dict[tuple[str, str, str, str], dict] = {
        row_key(row): row for row in rows
    }
    section_rows = [
        row for row in rows
        if should_generate_text(row)
    ]

    # --- Load progress ---
    all_done_keys: set[str] = set()
    done_keys: set[str] = set()
    if os.path.exists(paths["progress"]):
        with open(paths["progress"]) as f:
            all_done_keys = set(json.load(f))
        progress_prefix = f"{PIPELINE_VERSION}|{args.system}|"
        done_keys = {key for key in all_done_keys if key.startswith(progress_prefix)}
        print(f"Resuming — {len(done_keys)} sections already written")

    pending = [row for row in section_rows if section_key(row) not in done_keys]
    book_outline_path = paths["outline"]
    plans = load_outline(book_outline_path)
    missing_plans = [row for row in section_rows if section_key(row) not in plans]

    print("\nCurrent process")
    print(f"  Book: {args.system}")
    print(
        f"  Outline: {len(plans)} / {len(section_rows)} sections available at "
        f"{book_outline_path}"
    )
    legacy_outline_path = os.path.join(
        INTERMEDIARY_DIR,
        f"{safe_name(args.system)}_outline.md",
    )
    if os.path.exists(legacy_outline_path):
        print(
            f"  Older outline not reused: {legacy_outline_path} "
            "(created from a previous CSV/pipeline version)"
        )
    if missing_plans:
        print(f"  Step 1: generate {len(missing_plans)} missing outline sections")
    else:
        print("  Step 1: reuse the complete outline")
    if args.outline_only:
        print("  Step 2: stop after the outline; do not generate manuscript text")
    else:
        print(
            f"  Step 2: generate {len(pending)} / {len(section_rows)} manuscript sections at "
            f"{paths['manuscript']}"
        )

    print(f"  Human outline: {paths['human_outline']}")

    if args.status_only:
        return

    if not pending and not missing_plans:
        write_human_outline(paths["human_outline"], args.system, section_rows, plans, rows_by_key)
        print(f"All sections complete: {paths['manuscript']}")
        return

    if args.outline_only and not missing_plans:
        print(f"Reusing complete outline: {book_outline_path}")
        return

    # --- Load model ---
    base_name = "Qwen/Qwen2.5-7B-Instruct"
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading {base_name} on {device}...")

    tokenizer = AutoTokenizer.from_pretrained(base_name, trust_remote_code=True)
    model = _load_model(base_name, device, allow_cpu=args.allow_cpu)
    ensure_generation_device(model, args.allow_cpu)

    model.eval()
    print("Model ready.")

    # --- Create or reuse the complete note-grounded outline ---
    if missing_plans:
        print(f"Planning {len(missing_plans)} sections in {book_outline_path}")
        for row in missing_plans:
            query = build_query(row, rows_by_key)
            context = retrieve_context(collection, query, args.notes_top_k)
            messages = build_outline_messages(row, section_rows, context)
            plan = generate_text(model, tokenizer, messages, max_new_tokens=500, do_sample=False)
            append_outline(book_outline_path, row, plan)
            plans[section_key(row)] = plan
            write_human_outline(paths["human_outline"], args.system, section_rows, plans, rows_by_key)
            print(f"  Planned {section_number(row)}: {row['Name']}")
    else:
        print(f"Reusing complete outline: {book_outline_path}")

    write_human_outline(paths["human_outline"], args.system, section_rows, plans, rows_by_key)

    if args.outline_only:
        print(f"Outline ready: {book_outline_path}")
        return

    # --- Generate ---
    output_file = paths["manuscript"]
    write_mode = "a" if done_keys else "w"
    with open(output_file, write_mode, encoding="utf-8") as out:
        if write_mode == "w":
            out.write(f"# {args.system}\n\n")

        current_chapter = None
        current_sub = None

        for row in pending:
            if row["Chapter"] != current_chapter:
                chapter_row = find_chapter_row(row, rows_by_key)
                if row["Chapter"] == "0":
                    heading = "Introduction"
                else:
                    heading = chapter_title(chapter_row) if chapter_row else args.system
                out.write(f"\n## {row['Chapter']} {heading}\n\n")
                current_chapter = row["Chapter"]
                current_sub = None

            if is_chapter_introduction(row):
                if row["Chapter"] != "0":
                    out.write(f"### {row['Chapter']}.0 Introduction\n\n")
            elif row["Sub-Sub-Chapter"] and row["Sub-Chapter"] != current_sub:
                sub_row = rows_by_key.get(
                    (args.system, row["Chapter"], row["Sub-Chapter"], "")
                )
                heading = sub_row["Name"] if sub_row else row["Sub-Chapter"]
                out.write(f"### {row['Sub-Chapter']} {heading}\n\n")
                current_sub = row["Sub-Chapter"]
            elif not row["Sub-Sub-Chapter"]:
                out.write(f"### {row['Sub-Chapter']} {row['Name']}\n\n")
                current_sub = row["Sub-Chapter"]

            if row["Sub-Sub-Chapter"]:
                out.write(f"#### {row['Sub-Sub-Chapter']} {row['Name']}\n\n")

            query = build_query(row, rows_by_key)
            context = retrieve_context(collection, query, args.notes_top_k)
            messages = build_messages(
                row,
                rows_by_key,
                context,
                plans[section_key(row)],
                PARAGRAPHS_PER_SECTION,
            )
            prose = generate_english_text(
                model,
                tokenizer,
                messages,
                max_new_tokens=MAX_NEW_TOKENS,
            )

            out.write(prose + "\n\n")
            out.flush()

            done_keys.add(section_key(row))
            all_done_keys.add(section_key(row))
            with open(paths["progress"], "w") as pf:
                json.dump(sorted(all_done_keys), pf)

            number = section_number(row)
            print(f"  [{len(done_keys)}/{len(section_rows)}] {number}: {row['Name']}")

    print(f"\nDone. Manuscript written to {output_file}")


if __name__ == "__main__":
    main()
