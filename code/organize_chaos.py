"""
Semantically route raw notes from data/input/random/writing-desktop/chaos
into the destinations profiled in data/input/guidance/chapter-profiles.md.

Each profiled destination (its Description, Belongs-here text, and Keywords)
is embedded once as a fixed target — a human-authored ground truth that does
not drift as matches accumulate, unlike matching against existing notes-file
content would. Every chaos file is split into outline sections, each section
is embedded (EMBEDDING_MODEL below) and matched against the nearest
destination by cosine similarity.

Chaos is never modified or deleted. Matches are appended to a sibling
"<name> (chaos import).md" file next to the destination, each entry tagged
with its chaos source path so it stays traceable. Sections with no confident
match are grouped by chaos top-level range folder under notes/_unsorted/ for
manual review, tagged with their closest guess.

Usage:
    python code/organize_chaos.py --dry-run
    python code/organize_chaos.py
"""

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime

import numpy as np
import torch
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from tqdm import tqdm

# Tests may load this file via importlib rather than running it directly,
# which doesn't add code/ to sys.path automatically.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paths

CHUNK_SIZE = 1400
CHUNK_OVERLAP = 250
MIN_SECTION_CHARS = 120
# Matching happens entirely in-memory each run (chaos and profiles are both
# embedded fresh here), so this doesn't need to match index_notes.py's model
# the way retrieval does — but it's kept the same for consistent match quality.
EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"
TEXT_EXTENSIONS = {".md", ".txt", ".markdown", ".text", ""}
_BINARY_SIGNALS = (b"\x00", b"\xff\xfe", b"\xfe\xff", b"\x89PNG", b"PK\x03")
UNSORTED_DIRNAME = "_unsorted"
IMPORT_SUFFIX = " (chaos import).md"
EMBED_BATCH = 1024


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
# Heading-based direct extraction
#
# Some chaos files already carry the destination in a markdown heading, e.g.
#   ## 1 protasis
#   notes about protasis blah blah
#   ## 2 epitasis
#   notes about epitasis blah blah
# When a heading names a known destination, that block is routed directly —
# no embedding needed, the title already says where it goes. Only the text
# NOT covered by a matching heading (the preamble, and any non-matching
# headings' bodies) falls through to embedding-based matching.
# ---------------------------------------------------------------------------

MARKDOWN_HEADING_RE = re.compile(r"^#{1,3}[ \t]+(.+?)[ \t]*$", re.MULTILINE)
HEADING_LEADING_NUMBER_RE = re.compile(r"^[\d.\s]+")
HEADING_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]*\)\s*$")


def match_heading_to_profile(heading_text: str, short_names: dict[str, str]) -> str | None:
    """Map a heading like '1 protasis' or 'Protasis (verse)' to a profile title."""
    normalized = HEADING_LEADING_NUMBER_RE.sub("", heading_text).strip().lower()
    normalized = HEADING_TRAILING_PAREN_RE.sub("", normalized).strip()
    for short_name, profile_title in short_names.items():
        if re.search(rf"\b{re.escape(short_name)}\b", normalized):
            return profile_title
    return None


def split_by_heading(text: str, short_names: dict[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Split text at markdown headings into (profile_title, block) direct
    matches and a list of leftover segments (preamble plus any section under
    a heading that didn't name a known destination) to embed as normal."""
    headings = list(MARKDOWN_HEADING_RE.finditer(text))
    if not headings:
        return [], [text]

    direct: list[tuple[str, str]] = []
    leftover: list[str] = []
    preamble = text[:headings[0].start()].strip()
    if preamble:
        leftover.append(preamble)

    for i, match in enumerate(headings):
        end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
        block = text[match.end():end].strip()
        if not block:
            continue
        profile_title = match_heading_to_profile(match.group(1), short_names)
        if profile_title:
            direct.append((profile_title, block))
        else:
            leftover.append(block)

    return direct, leftover


# ---------------------------------------------------------------------------
# chapter-profiles.md matching
# ---------------------------------------------------------------------------

# Only eight destinations are profiled (plus an explicit "doesn't fit any of
# these" note); each maps to a concrete, verified notes/ file. Evocation's
# four don't exist on disk yet, so this is also where they get their names —
# numbered the same way as Invocation's three, in the order the profile doc
# itself lists them (Substance, Sentience, Sapience, Sacrifice).
PROFILE_DESTINATIONS = {
    "Invocation · Protasis": "poetry/invocation/1 protasis",
    "Invocation · Epitasis": "poetry/invocation/2 epitasis",
    "Invocation · Catastrophe": "poetry/invocation/3 catastrophe",
    "Evocation · Substance": "poetry/evocation/1 substance",
    "Evocation · Sentience": "poetry/evocation/2 sentience",
    "Evocation · Sapience": "poetry/evocation/3 sapience",
    "Evocation · Sacrifice": "poetry/evocation/4 sacrifice",
    "Eudaimonia · Introduction (Universal Metaphysics)": "mysticism/universal metaphysics/0 introduction",
}
# Derived once: "Invocation · Protasis" -> {"protasis": "Invocation · Protasis"}.
# Used to recognize a destination named directly in a chaos file's heading.
PROFILE_SHORT_NAMES = {
    re.sub(r"\s*\([^)]*\)\s*$", "", title.rsplit("·", 1)[-1]).strip().lower(): title
    for title in PROFILE_DESTINATIONS
}
PROFILE_SECTION_RE = re.compile(r"^## (.+)$", re.MULTILINE)


def _profile_subsection(body: str, name: str) -> str:
    match = re.search(rf"### {re.escape(name)}\n(.*?)(?=\n### |\n---|\Z)", body, re.DOTALL)
    return match.group(1).strip() if match else ""


def load_chapter_profiles(path: str) -> list[dict]:
    """Parse chapter-profiles.md into routing targets.

    Only headers matching a known destination in PROFILE_DESTINATIONS become
    targets — "Notes that route nowhere" and any other commentary sections
    are informational and intentionally skipped.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()
    headers = list(PROFILE_SECTION_RE.finditer(text))
    profiles = []
    for i, match in enumerate(headers):
        title = match.group(1).strip()
        if title not in PROFILE_DESTINATIONS:
            continue
        end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        body = text[match.end():end]
        pieces = [
            _profile_subsection(body, "Description"),
            _profile_subsection(body, "Belongs here"),
            _profile_subsection(body, "Keywords"),
        ]
        profile_text = "\n\n".join(p for p in pieces if p)
        if profile_text:
            profiles.append({"title": title, "relpath": PROFILE_DESTINATIONS[title], "text": profile_text})
    return profiles


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


def build_targets(notes_dir: str, profiles: list[dict]) -> list[Target]:
    targets = []
    for profile in profiles:
        relpath = profile["relpath"].replace("/", os.sep)
        t = Target(relpath, notes_dir)
        t.chunks = chunk_text(profile["text"], CHUNK_SIZE, CHUNK_OVERLAP)
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
    default_chaos = os.path.join(paths.NOTES_ROOT, "chaos")
    default_notes = os.path.join(paths.NOTES_ROOT, "notes")
    default_profiles = paths.CHAPTER_PROFILES_FILE

    parser = argparse.ArgumentParser()
    parser.add_argument("--chaos-dir", default=default_chaos)
    parser.add_argument("--notes-dir", default=default_notes)
    parser.add_argument("--profiles", default=default_profiles,
                         help="chapter-profiles.md describing each routing destination")
    # BAAI/bge-large-en-v1.5 produces a much higher, more compressed cosine
    # similarity range than MiniLM did (empirically ~0.55-0.80 rather than
    # ~0.25-0.65), so this threshold was recalibrated against that
    # distribution rather than reused from the MiniLM-era default.
    parser.add_argument("--threshold", type=float, default=0.65)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit-files", type=int, default=None,
                         help="only process the first N chaos files (for prototyping)")
    parser.add_argument("--run-id", default=None,
                         help="pipeline run this invocation belongs to, for the output manifest")
    parser.add_argument("--manifest-out", default=None,
                         help="path to write a JSON manifest of touched notes files")
    parser.add_argument("--embedding-model", default=EMBEDDING_MODEL,
                         help="matching happens entirely in-memory each run, so this is a free per-run choice")
    args = parser.parse_args()

    profiles = load_chapter_profiles(args.profiles)
    print(f"Loaded {len(profiles)} routing destinations from {args.profiles}")
    targets = build_targets(args.notes_dir, profiles)
    print(f"  {len(targets)} destination targets")
    title_for_relpath = {relpath: title for title, relpath in PROFILE_DESTINATIONS.items()}

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Embedding device: {device}")
    ef = SentenceTransformerEmbeddingFunction(model_name=args.embedding_model, device=device)

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

    target_index_by_title = {}
    for ti, t in enumerate(targets):
        title = title_for_relpath.get(t.relpath.replace(os.sep, "/"))
        if title:
            target_index_by_title[title] = ti

    print("Scanning chaos/ for sections ...")
    sections = []  # (range_bucket, relpath, section_idx, text, source_key)
    heading_matches = []  # (range_bucket, relpath, profile_title, text, source_key)
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

        direct, leftover_segments = split_by_heading(text, PROFILE_SHORT_NAMES)
        for h_i, (profile_title, block) in enumerate(direct):
            source_key = f"chaos/{relpath}#h{h_i}"
            if source_key in already:
                continue
            heading_matches.append((bucket, relpath, profile_title, block, source_key))

        leftover_sections = [sec for seg in leftover_segments for sec in split_sections(seg)]
        for i, sec in enumerate(leftover_sections):
            source_key = f"chaos/{relpath}#{i}"
            if source_key in already:
                continue
            sections.append((bucket, relpath, i, sec, source_key))

    print(f"  {len(heading_matches)} sections matched directly by heading, {len(sections)} new sections to classify by embedding")

    matched_by_target = defaultdict(list)   # target_idx -> [(source_key, text)]
    unsorted_by_bucket = defaultdict(list)  # bucket -> [(source_key, text, guess, score)]
    matched_scores = []
    borderline = []  # (score, target_relpath, text) near the threshold, for dry-run inspection

    n_heading = len(heading_matches)
    for _bucket, _relpath, profile_title, block, source_key in heading_matches:
        matched_by_target[target_index_by_title[profile_title]].append((source_key, block))

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
    print(f"\nMatched {n_heading} by heading, {n_matched} by embedding, {n_unsorted} unsorted, in {elapsed:.1f}s")

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
    touched_files = []
    for ti, entries in matched_by_target.items():
        t = targets[ti]
        os.makedirs(t.dirpath, exist_ok=True)
        with open(t.import_path, "a", encoding="utf-8") as f:
            for source_key, sec in entries:
                f.write(f"## Source: {source_key}\n\n{sec}\n\n---\n\n")
        touched_files.append(t.import_path)

    unsorted_dir = os.path.join(args.notes_dir, UNSORTED_DIRNAME)
    for bucket, entries in unsorted_by_bucket.items():
        os.makedirs(unsorted_dir, exist_ok=True)
        fpath = os.path.join(unsorted_dir, f"{bucket}.md")
        with open(fpath, "a", encoding="utf-8") as f:
            for source_key, sec, guess, score in entries:
                f.write(f"## Source: {source_key} (closest: {guess} @ {score:.2f})\n\n{sec}\n\n---\n\n")
        touched_files.append(fpath)

    if args.manifest_out:
        os.makedirs(os.path.dirname(args.manifest_out), exist_ok=True)
        with open(args.manifest_out, "w", encoding="utf-8") as f:
            json.dump({
                "run_id": args.run_id,
                "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                "matched_by_heading": n_heading,
                "matched": n_matched,
                "unsorted": n_unsorted,
                "files": sorted(set(touched_files)),
            }, f, indent=2)

    print("Done.")


if __name__ == "__main__":
    main()
