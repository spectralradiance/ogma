"""Data-root resolution shared by every script in code/.

The notes/outline tree and the guidance documents get reorganized from time
to time as the user's process evolves; that should be a one-line .env edit,
not a hunt through every script that hardcodes a path into it. Each root
here can be overridden via an environment variable, read from .env if
present; unset, they fall back to the current on-disk layout.
"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
INPUT_DIR = os.path.join(DATA_DIR, "input")
INTERMEDIARY_DIR = os.path.join(DATA_DIR, "intermediary")
OUTPUT_DIR = os.path.join(DATA_DIR, "output")


def _load_dotenv() -> None:
    env_path = os.path.join(ROOT, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = value


def _root(env_var: str, default_relative: str) -> str:
    override = os.environ.get(env_var)
    if override:
        return override if os.path.isabs(override) else os.path.join(ROOT, override)
    return os.path.join(ROOT, *default_relative.split("/"))


_load_dotenv()

NOTES_ROOT = _root("OGMA_NOTES_ROOT", "data/input/random/writing-desktop")
NOTION_ROOT = _root("OGMA_NOTION_ROOT", "data/input/random/notion/Writing")
GUIDANCE_ROOT = _root("OGMA_GUIDANCE_ROOT", "data/input/guidance")

CSV_FILE = os.path.join(GUIDANCE_ROOT, "chapter_structure.csv")
GUIDANCE_FILE = os.path.join(GUIDANCE_ROOT, "guidance.json")
CHAPTER_PROFILES_FILE = os.path.join(GUIDANCE_ROOT, "chapter-profiles.md")
