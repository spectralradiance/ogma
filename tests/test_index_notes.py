import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path(__file__).resolve().parent.parent / "code" / "index_notes.py"
SPEC = importlib.util.spec_from_file_location("ogma_index_notes", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
index_notes = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = index_notes
SPEC.loader.exec_module(index_notes)


def test_source_key_distinguishes_note_roots(tmp_path: Path) -> None:
    input_dir = tmp_path / "input"
    desktop = input_dir / "writing-desktop"
    notion = input_dir / "notion" / "Writing"

    assert index_notes.source_key(str(desktop), str(input_dir)) == "writing-desktop"
    assert index_notes.source_key(str(notion), str(input_dir)) == "notion/Writing"