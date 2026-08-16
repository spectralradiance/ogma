"""Interactive CLI for indexing, outlining, manuscript generation, and chat."""

import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent
CODE_DIR = BASE_DIR / "code"
DATA_DIR = BASE_DIR / "data"
WRITE_BOOK_PATH = CODE_DIR / "write_book.py"
WRITE_BOOK_SPEC = importlib.util.spec_from_file_location(WRITE_BOOK_PATH.stem, WRITE_BOOK_PATH)
if WRITE_BOOK_SPEC is None or WRITE_BOOK_SPEC.loader is None:
    raise ImportError(f"Unable to load {WRITE_BOOK_PATH}")
write_book = importlib.util.module_from_spec(WRITE_BOOK_SPEC)
sys.modules[WRITE_BOOK_SPEC.name] = write_book
WRITE_BOOK_SPEC.loader.exec_module(write_book)


INTERMEDIARY_DIR = DATA_DIR / "intermediary"
OUTPUT_DIR = DATA_DIR / "output"
INDEX_METADATA = INTERMEDIARY_DIR / "index_metadata.json"


def run_command(arguments: list[str]) -> int:
    script = CODE_DIR / arguments[0]
    command = [sys.executable, str(script), *arguments[1:]]
    print("\nRunning:", subprocess.list2cmdline(command), "\n")
    try:
        return subprocess.run(command, cwd=BASE_DIR, check=False).returncode
    except KeyboardInterrupt:
        print("\nChild process stopped. Returning to the main menu.")
        return 130


def new_run_id() -> str:
    base = f"generated{datetime.now():%Y%m%d%H%M}"
    candidate = base
    suffix = 2
    while (OUTPUT_DIR / candidate).exists() or (INTERMEDIARY_DIR / candidate).exists():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def systems() -> list[str]:
    return sorted({row["System"] for row in write_book.load_csv(write_book.CSV_FILE)})


def choose(label: str, options: list[str]) -> int:
    print(f"\n{label}")
    for index, option in enumerate(options, start=1):
        print(f"  {index}. {option}")
    while True:
        value = input("Select: ").strip()
        if value.isdigit() and 1 <= int(value) <= len(options):
            return int(value) - 1
        print("Enter one of the listed numbers.")


def choose_system() -> str:
    available = systems()
    return available[choose("Choose text", available)]


def modified_label(path: Path) -> str:
    modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
    return f"{modified:%Y-%m-%d %H:%M} | {path}"


def outline_caches(system: str) -> list[Path]:
    book = write_book.safe_name(system)
    candidates = set(INTERMEDIARY_DIR.glob(f"{book}_outline*.md"))
    candidates.update(INTERMEDIARY_DIR.glob(f"generated*/{book}/writing_plan.md"))
    prefix = f"{write_book.PIPELINE_VERSION}|{system}|"
    compatible = [
        path for path in candidates
        if any(key.startswith(prefix) for key in write_book.load_outline(str(path)))
    ]
    return sorted(compatible, key=lambda path: path.stat().st_mtime, reverse=True)


def generated_runs(system: str) -> list[str]:
    book = write_book.safe_name(system)
    runs = []
    for plan in INTERMEDIARY_DIR.glob(f"generated*/{book}/writing_plan.md"):
        runs.append(plan.parent.parent.name)
    return sorted(set(runs), reverse=True)


def cache_arguments(system: str) -> list[str]:
    caches = outline_caches(system)
    labels = ["Regenerate from the indexed notes"]
    labels.extend(f"Use cache: {modified_label(path)}" for path in caches)
    selected = choose("Outline source", labels)
    if selected == 0:
        return ["--regenerate-outline"]
    return ["--outline-cache", str(caches[selected - 1])]


def show_index_status() -> None:
    if not INDEX_METADATA.exists():
        database = INTERMEDIARY_DIR / "chroma_db" / "chroma.sqlite3"
        if database.exists():
            modified = datetime.fromtimestamp(database.stat().st_mtime).astimezone()
            print(f"Last index activity: {modified:%Y-%m-%d %H:%M} (database modified time)")
        else:
            print("Last index run: never")
        return
    try:
        metadata = json.loads(INDEX_METADATA.read_text(encoding="utf-8"))
        print(f"Last index run: {metadata.get('completed_at', 'unknown')}")
        print(
            f"Indexed files: {metadata.get('files_found', '?')}; "
            f"note chunks: {metadata.get('total_chunks', '?')}"
        )
    except (json.JSONDecodeError, OSError):
        print("Last index run: metadata could not be read")


def index_notes() -> None:
    show_index_status()
    answer = input("Run indexing now? [y/N]: ").strip().lower()
    if answer == "y":
        run_command(["index_notes.py"])


def generate_outline() -> None:
    system = choose_system()
    run_id = new_run_id()
    arguments = [
        "write_book.py",
        "--system", system,
        "--run-id", run_id,
        "--outline-only",
        *cache_arguments(system),
    ]
    print(f"Run: {run_id}")
    run_command(arguments)


def generate_text() -> None:
    system = choose_system()
    runs = generated_runs(system)
    labels = ["Start a new dated run"]
    labels.extend(f"Continue {run_id}" for run_id in runs)
    selected = choose("Generation run", labels)
    arguments = ["write_book.py", "--system", system]
    if selected == 0:
        run_id = new_run_id()
        arguments.extend(["--run-id", run_id, *cache_arguments(system)])
    else:
        run_id = runs[selected - 1]
        arguments.extend(["--run-id", run_id])
    print(f"Run: {run_id}")
    run_command(arguments)


def open_chat() -> None:
    run_id = new_run_id()
    intermediary = INTERMEDIARY_DIR / run_id / "chat"
    output = OUTPUT_DIR / run_id / "chat"
    run_command([
        "chat.py",
        "--history-file", str(intermediary / "history.json"),
        "--output-dir", str(output),
    ])


def main() -> None:
    INTERMEDIARY_DIR.mkdir(exist_ok=True)
    OUTPUT_DIR.mkdir(exist_ok=True)
    actions = [
        ("Index notes", index_notes),
        ("Generate or reuse an outline", generate_outline),
        ("Generate manuscript text", generate_text),
        ("Open chat", open_chat),
        ("Exit", None),
    ]
    while True:
        selected = choose("Metaphysics Writing CLI", [label for label, _ in actions])
        action = actions[selected][1]
        if action is None:
            return
        action()


if __name__ == "__main__":
    main()
