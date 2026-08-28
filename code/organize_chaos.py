"""
Semantically route raw notes from data/input/writing-desktop/chaos into the
organized chapter/topic structure under data/input/writing-desktop/notes.

For every existing file under notes/, a match profile is built from that
file's own content plus, where its path corresponds to a System/Chapter/
Sub-Chapter row in chapter_structure.csv (matched by folder name against the
row's Name / Alternative Names), the Name/Description text of that row and
its descendants. Every chaos file is split into outline sections, each
section is embedded (EMBEDDING_MODEL below) and matched against the nearest
notes chunk by cosine similarity.

Chaos is never modified or deleted. Matches are appended to a sibling
"<name> (chaos import).md" file next to the best-matching notes file, each
entry tagged with its chaos source path so it stays traceable. Sections with
no confident match are grouped by chaos top-level range folder under
notes/_unsorted/ for manual review, tagged with their closest guess.

Usage:
    python code/organize_chaos.py --dry-run
    python code/organize_chaos.py
"""

import argparse
import csv
import os
import re
import time
from collections import defaultdict

import numpy as np
import torch
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from tqdm import tqdm

CHUNK_SIZE = 1400
CHUNK_OVERLAP = 250
MIN_SECTION_CHARS = 120
# Matching happens entirely in-memory each run (chaos and notes/ are both
# embedded fresh here), so this doesn't need to match index_notes.py's model
# the way retrieval does — but it's kept the same for consistent match quality.
EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"
TEXT_EXTENSIONS = {".md", ".txt", ".markdown", ".text", ""}
_BINARY_SIGNALS = (b"\x00", b"\xff\xfe", b"\xfe\xff", b"\x89PNG", b"PK\x03")
UNSORTED_DIRNAME = "_unsorted"
IMPORT_SUFFIX = " (chaos import).md"
EMBED_BATCH = 1024

SYSTEM_FOLDER_MAP = {
    "universal metaphysics": "Universal Metaphysics",
    "the tree of life": "Tree of Life",
    "invocation": "Invocation",
    "evocation": "Evocation",
}


def _is_text_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            header = f.read(8)
        return not any(header.startswith(sig) for sig in _BINARY_SIGNALS)
    except OSError:
        return False


def iter_text_files(root: str):
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in TEXT_EXTENSIONS:
                continue
            fpath = os.path.join(dirpath, fname)
            if _is_text_file(fpath):
                yield fpath


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    chunks, start = [], 0
    while start < len(text):
        end = start + chunk_size
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        start += chunk_size - overlap
    return chunks


def split_sections(text: str) -> list[str]:
    """Break outline-style text at lines with no leading whitespace, which
    this corpus consistently uses as section headings. This corpus is a
    stream-of-consciousness outline: most headings introduce only one or two
    short indented lines, sometimes none. Embedding those alone gives the
    matcher almost no signal, so it latches onto coincidental wording in an
    unrelated chapter instead of the actual topic. Adjacent raw sections are
    therefore merged forward until they carry enough context to embed
    meaningfully. Oversized sections fall back to fixed-size chunking."""
    lines = text.splitlines()
    raw_sections, current = [], []
    for line in lines:
        is_heading = bool(line) and not line[0].isspace()
        if is_heading and current:
            block = "\n".join(current).strip()
            if block:
                raw_sections.append(block)
            current = [line]
        else:
            current.append(line)
    if current:
        block = "\n".join(current).strip()
        if block:
            raw_sections.append(block)

    merged, buffer = [], ""
    for block in raw_sections:
        buffer = f"{buffer}\n\n{block}" if buffer else block
        if len(buffer) >= MIN_SECTION_CHARS:
            merged.append(buffer)
            buffer = ""
    if buffer:
        if merged:
            merged[-1] = f"{merged[-1]}\n\n{buffer}"
        else:
            merged.append(buffer)

    final = []
    for s in merged:
        if len(s) <= CHUNK_SIZE * 1.5:
            final.append(s)
        else:
            final.extend(chunk_text(s, CHUNK_SIZE, CHUNK_OVERLAP))
    return final


# ---------------------------------------------------------------------------
# chapter_structure.csv matching
# ---------------------------------------------------------------------------

def load_chapter_rows(csv_path: str) -> list[dict]:
    with open(csv_path, encoding="utf-8") as f:
        return [row for row in csv.DictReader(f) if row.get("System")]


def row_path(row: dict) -> str:
    return row["Sub-Sub-Chapter"] or row["Sub-Chapter"] or row["Chapter"]


def row_depth(path: str) -> int:
    return path.count(".")


def strip_numeric_prefix(name: str) -> str:
    m = re.match(r"^\d+\s+(.*)$", name)
    return m.group(1) if m else name


def _normalize_name(name: str) -> str:
    return re.sub(r"\[.*?\]", "", name).strip().lower()


def find_child_row_path(system: str, rows: list[dict], parent_path, name: str):
    name_norm = _normalize_name(name)
    if not name_norm:
        return None
    parent_depth = row_depth(parent_path) if parent_path is not None else -1
    for r in rows:
        if r["System"] != system:
            continue
        p = row_path(r)
        if not p:
            continue
        if parent_path is None:
            if row_depth(p) != 0:
                continue
        else:
            if not (p == parent_path or p.startswith(parent_path + ".")):
                continue
            if row_depth(p) != parent_depth + 1:
                continue
        candidates = [r["Name"]] + [a for a in r.get("Alternative Names", "").split(";")]
        if any(_normalize_name(c) == name_norm for c in candidates if c.strip()):
            return p
    return None


def map_path_to_csv(system: str, rows: list[dict], path_parts: list[str]):
    parent_path = None
    for part in path_parts:
        name = strip_numeric_prefix(part)
        child = find_child_row_path(system, rows, parent_path, name)
        if child is None:
            break
        parent_path = child
    return parent_path


def csv_enrichment_text(system: str, rows: list[dict], matched_path: str) -> str:
    pieces = []
    for r in rows:
        if r["System"] != system:
            continue
        p = row_path(r)
        if not p:
            continue
        if p == matched_path or p.startswith(matched_path + "."):
            alt = r.get("Alternative Names", "").strip()
            desc = r.get("Description", "").strip()
            piece = r["Name"]
            if alt:
                piece += f" ({alt})"
            if desc:
                piece += f": {desc}"
            pieces.append(piece)
    return "\n".join(pieces)


# ---------------------------------------------------------------------------
# Target profile construction
# ---------------------------------------------------------------------------

class Target:
    __slots__ = ("relpath", "dirpath", "basename", "import_path", "chunks")

    def __init__(self, relpath: str, notes_dir: str):
        self.relpath = relpath
        self.dirpath = os.path.dirname(os.path.join(notes_dir, relpath))
        base = os.path.basename(relpath)
        stem, _ext = os.path.splitext(base)
        self.basename = base
        self.import_path = os.path.join(self.dirpath, stem + IMPORT_SUFFIX)
        self.chunks: list[str] = []


def build_targets(notes_dir: str, rows: list[dict]) -> list[Target]:
    targets = []
    for fpath in iter_text_files(notes_dir):
        relpath = os.path.relpath(fpath, notes_dir)
        parts = relpath.replace(os.sep, "/").split("/")
        if UNSORTED_DIRNAME in parts:
            continue
        if os.path.basename(fpath).endswith("(chaos import).md"):
            continue

        try:
            with open(fpath, encoding="utf-8", errors="ignore") as f:
                content = f.read().strip()
        except OSError:
            content = ""

        system = None
        system_idx = None
        for i, part in enumerate(parts[:-1]):
            mapped = SYSTEM_FOLDER_MAP.get(part.lower())
            if mapped:
                system, system_idx = mapped, i
                break

        enrichment = ""
        if system is not None:
            remaining = parts[system_idx + 1:]
            matched = map_path_to_csv(system, rows, remaining)
            if matched:
                enrichment = csv_enrichment_text(system, rows, matched)

        combined = content
        if enrichment:
            combined = f"{content}\n\n{enrichment}" if content else enrichment
        if not combined.strip():
            continue

        t = Target(relpath, notes_dir)
        t.chunks = chunk_text(combined, CHUNK_SIZE, CHUNK_OVERLAP)
        if t.chunks:
            targets.append(t)
    return targets


# ---------------------------------------------------------------------------
# Existing import de-duplication
# ---------------------------------------------------------------------------

SOURCE_RE = re.compile(r"^## Source: (.+?)(?: \(closest.*\))?$", re.MULTILINE)


def load_already_imported(notes_dir: str) -> set[str]:
    seen = set()
    for fpath in iter_text_files(notes_dir):
        if os.path.basename(fpath).endswith("(chaos import).md"):
            seen.update(_read_sources(fpath))
    unsorted_dir = os.path.join(notes_dir, UNSORTED_DIRNAME)
    if os.path.isdir(unsorted_dir):
        for fpath in iter_text_files(unsorted_dir):
            seen.update(_read_sources(fpath))
    return seen


def _read_sources(fpath: str) -> set[str]:
    try:
        with open(fpath, encoding="utf-8", errors="ignore") as f:
            text = f.read()
    except OSError:
        return set()
    return set(SOURCE_RE.findall(text))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(os.path.dirname(script_dir), "data")
    default_chaos = os.path.join(data_dir, "input", "writing-desktop", "chaos")
    default_notes = os.path.join(data_dir, "input", "writing-desktop", "notes")
    default_csv = os.path.join(data_dir, "input", "chapter_structure.csv")

    parser = argparse.ArgumentParser()
    parser.add_argument("--chaos-dir", default=default_chaos)
    parser.add_argument("--notes-dir", default=default_notes)
    parser.add_argument("--csv", default=default_csv)
    # BAAI/bge-large-en-v1.5 produces a much higher, more compressed cosine
    # similarity range than MiniLM did (empirically ~0.55-0.80 rather than
    # ~0.25-0.65), so this threshold was recalibrated against that
    # distribution rather than reused from the MiniLM-era default.
    parser.add_argument("--threshold", type=float, default=0.65)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit-files", type=int, default=None,
                         help="only process the first N chaos files (for prototyping)")
    args = parser.parse_args()

    rows = load_chapter_rows(args.csv)
    print("Building target profiles from notes/ ...")
    targets = build_targets(args.notes_dir, rows)
    print(f"  {len(targets)} target files with content/enrichment")

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Embedding device: {device}")
    ef = SentenceTransformerEmbeddingFunction(model_name=EMBEDDING_MODEL, device=device)

    target_vecs = []
    target_id_for_chunk = []
    for ti, t in enumerate(tqdm(targets, desc="Embedding targets", unit="file")):
        vecs = np.array(ef(t.chunks), dtype=np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-8
        target_vecs.append(vecs)
        target_id_for_chunk.extend([ti] * len(t.chunks))
    T = np.concatenate(target_vecs, axis=0)
    target_id_for_chunk = np.array(target_id_for_chunk)
    print(f"  {T.shape[0]} target chunks total")

    already = load_already_imported(args.notes_dir)
    print(f"Already-imported sources to skip: {len(already)}")

    print("Scanning chaos/ for sections ...")
    sections = []  # (range_bucket, relpath, section_idx, text)
    chaos_files = list(iter_text_files(args.chaos_dir))
    if args.limit_files:
        chaos_files = chaos_files[: args.limit_files]
    print(f"  {len(chaos_files)} chaos files found")

    for fpath in tqdm(chaos_files, desc="Splitting chaos files", unit="file"):
        relpath = os.path.relpath(fpath, args.chaos_dir).replace(os.sep, "/")
        try:
            with open(fpath, encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except OSError:
            continue
        if not text.strip():
            continue
        bucket = relpath.split("/", 1)[0]
        for i, sec in enumerate(split_sections(text)):
            source_key = f"chaos/{relpath}#{i}"
            if source_key in already:
                continue
            sections.append((bucket, relpath, i, sec, source_key))

    print(f"  {len(sections)} new sections to classify")

    matched_by_target = defaultdict(list)   # target_idx -> [(source_key, text)]
    unsorted_by_bucket = defaultdict(list)  # bucket -> [(source_key, text, guess, score)]
    matched_scores = []
    borderline = []  # (score, target_relpath, text) near the threshold, for dry-run inspection

    n_matched = n_unsorted = 0
    t0 = time.time()
    for start in tqdm(range(0, len(sections), EMBED_BATCH), desc="Matching sections", unit="batch"):
        batch = sections[start:start + EMBED_BATCH]
        texts = [b[3] for b in batch]
        vecs = np.array(ef(texts), dtype=np.float32)
        vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-8
        sims = vecs @ T.T  # (batch, num_target_chunks)
        best_chunk = np.argmax(sims, axis=1)
        best_score = sims[np.arange(len(batch)), best_chunk]
        best_target = target_id_for_chunk[best_chunk]

        for (bucket, relpath, idx, sec, source_key), ti, score in zip(batch, best_target, best_score):
            score = float(score)
            if score >= args.threshold:
                matched_by_target[ti].append((source_key, sec))
                n_matched += 1
                matched_scores.append(score)
            else:
                guess = targets[ti].relpath
                unsorted_by_bucket[bucket].append((source_key, sec, guess, score))
                n_unsorted += 1
            if abs(score - args.threshold) < 0.02:
                borderline.append((score, targets[ti].relpath, sec))

    elapsed = time.time() - t0
    print(f"\nMatched {n_matched}, unsorted {n_unsorted} in {elapsed:.1f}s")

    if args.dry_run:
        unsorted_scores = np.array(
            [s for entries in unsorted_by_bucket.values() for *_x, s in entries]
        )
        if len(unsorted_scores):
            pct = np.percentile(unsorted_scores, [10, 25, 50, 75, 90, 99])
            print(f"Unsorted score percentiles (10/25/50/75/90/99): {pct.round(3)}")
        if matched_scores:
            pct = np.percentile(matched_scores, [1, 10, 25, 50, 75, 90, 99])
            print(f"Matched score percentiles (1/10/25/50/75/90/99): {np.array(pct).round(3)}")
        print(f"\n{len(borderline)} borderline sections near threshold {args.threshold}; sample:")
        import random as _random
        _random.shuffle(borderline)
        for score, target, sec in borderline[:8]:
            print(f"\n  --- score={score:.3f} target={target} ---")
            print("  " + sec[:220].replace("\n", " | "))

    print("\nTop target matches:")
    for ti, entries in sorted(matched_by_target.items(), key=lambda kv: -len(kv[1]))[:20]:
        print(f"  {len(entries):5d}  {targets[ti].relpath}")

    if args.dry_run:
        print("\n--dry-run: no files written.")
        return

    print("\nWriting import files ...")
    for ti, entries in matched_by_target.items():
        t = targets[ti]
        os.makedirs(t.dirpath, exist_ok=True)
        with open(t.import_path, "a", encoding="utf-8") as f:
            for source_key, sec in entries:
                f.write(f"## Source: {source_key}\n\n{sec}\n\n---\n\n")

    unsorted_dir = os.path.join(args.notes_dir, UNSORTED_DIRNAME)
    for bucket, entries in unsorted_by_bucket.items():
        os.makedirs(unsorted_dir, exist_ok=True)
        fpath = os.path.join(unsorted_dir, f"{bucket}.md")
        with open(fpath, "a", encoding="utf-8") as f:
            for source_key, sec, guess, score in entries:
                f.write(f"## Source: {source_key} (closest: {guess} @ {score:.2f})\n\n{sec}\n\n---\n\n")

    print("Done.")


if __name__ == "__main__":
    main()
