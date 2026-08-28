"""
Build a persistent ChromaDB vector store from one or more directories of
notes files. Indexes .md, .txt, and extension-less text files.

Usage:
    python index_notes.py [--notes-dirs PATH [PATH ...]] [--db-dir PATH]

Defaults (two source dirs):
    ../data/input/writing-desktop
    ../data/input/notion/Writing
"""

import argparse
from datetime import datetime
import json
import os

import chromadb
from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction
from tqdm import tqdm


CHUNK_SIZE = 1400        # characters
CHUNK_OVERLAP = 250      # characters
BATCH_SIZE = 32          # chunks per ChromaDB upsert; keep this small to limit RAM spikes
MAX_FILE_BYTES = 1_048_576  # skip files over 1 MB; they freeze low-RAM machines
TEXT_EXTENSIONS = {".md", ".txt", ".markdown", ".text", ""}
# Byte-order marks / null bytes indicate a binary file; skip them
_BINARY_SIGNALS = (b"\x00", b"\xff\xfe", b"\xfe\xff", b"\x89PNG", b"PK\x03")
COLLECTION_NAME = "notes"
# write_book.py, generate_concepts.py, and chat.py all query this same store and
# must embed with this exact model, so it cannot be picked per-run like the
# analysis/generation models can. Changing it requires bumping INDEX_VERSION
# below so the mismatched-dimension collection is rebuilt instead of erroring.
EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5"
INDEX_VERSION = 3


def _prefer_below_normal_priority() -> None:
    """Keep the desktop responsive while embedding thousands of notes."""
    if os.name != "nt":
        return
    import ctypes
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    ctypes.windll.kernel32.SetPriorityClass(handle, 0x00004000)


def _embedding_device() -> str:
    try:
        import torch
        torch.set_num_threads(2)
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


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
            try:
                if os.path.getsize(fpath) > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            if _is_text_file(fpath):
                yield fpath


def chunk_text(text: str, chunk_size: int, overlap: int) -> list[str]:
    chunks, start = [], 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


def source_key(source_dir: str, input_dir: str) -> str:
    """Keep identical relative paths from separate note roots distinct."""
    return os.path.relpath(source_dir, input_dir).replace(os.sep, "/")


def main():
    parser = argparse.ArgumentParser()
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(os.path.dirname(script_dir), "data")
    input_dir = os.path.join(data_dir, "input")
    default_dirs = [
        os.path.join(data_dir, "input", "writing-desktop"),
        os.path.join(data_dir, "input", "notion", "Writing"),
    ]
    default_db = os.path.join(data_dir, "intermediary", "chroma_db")
    default_metadata = os.path.join(data_dir, "intermediary", "index_metadata.json")

    parser.add_argument("--notes-dirs", nargs="+", default=default_dirs)
    parser.add_argument("--db-dir", default=default_db)
    parser.add_argument("--metadata-file", default=default_metadata)
    args = parser.parse_args()

    notes_dirs = [os.path.normpath(d) for d in args.notes_dirs]
    db_dir = os.path.normpath(args.db_dir)
    os.makedirs(db_dir, exist_ok=True)

    for d in notes_dirs:
        if not os.path.isdir(d):
            raise SystemExit(f"Notes directory not found: {d}")

    _prefer_below_normal_priority()
    device = _embedding_device()
    print(f"Source dirs ({len(notes_dirs)}):")
    for d in notes_dirs:
        print(f"  {d}")
    print(f"ChromaDB  : {db_dir}")
    print(f"Embeddings: {EMBEDDING_MODEL} on {device}, {BATCH_SIZE} chunks/batch, skip files > {MAX_FILE_BYTES} bytes")

    ef = SentenceTransformerEmbeddingFunction(
        model_name=EMBEDDING_MODEL,
        device=device,
    )
    client = chromadb.PersistentClient(path=db_dir)
    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=ef,
        metadata={"hnsw:space": "cosine"},
    )

    metadata_version = None
    if os.path.isfile(args.metadata_file):
        try:
            with open(args.metadata_file, encoding="utf-8") as metadata_file:
                metadata_version = json.load(metadata_file).get("index_version")
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    if collection.count() and metadata_version != INDEX_VERSION:
        print("Index format changed; rebuilding with source-qualified chunk IDs.")
        client.delete_collection(COLLECTION_NAME)
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            embedding_function=ef,
            metadata={"hnsw:space": "cosine"},
        )

    existing_ids: set[str] = set()
    if collection.count():
        existing_ids = set(collection.get(include=[])["ids"])
    print(f"Existing chunks in store: {len(existing_ids)}")

    all_files = []
    for d in notes_dirs:
        all_files.extend(iter_text_files(d))
    print(f"Files found: {len(all_files)}")

    batch_docs, batch_ids, batch_meta = [], [], []
    added = updated = 0
    current_ids: set[str] = set()

    for fpath in tqdm(all_files, desc="Indexing files", unit="file"):
        # Include the source root so matching relative paths cannot overwrite one another.
        source_dir = next((d for d in notes_dirs if fpath.startswith(d)), notes_dirs[0])
        rel_path = os.path.relpath(fpath, source_dir)
        source = source_key(source_dir, input_dir)
        try:
            with open(fpath, encoding="utf-8", errors="ignore") as f:
                text = f.read().strip()
        except OSError as exc:
            tqdm.write(f"  skip (read error): {rel_path} — {exc}")
            continue

        if not text:
            continue

        chunks = chunk_text(text, CHUNK_SIZE, CHUNK_OVERLAP)
        for i, chunk in enumerate(chunks):
            chunk_id = f"{source}/{rel_path.replace(os.sep, '/')}::{i}"
            current_ids.add(chunk_id)
            if chunk_id in existing_ids:
                updated += 1
            else:
                added += 1

            batch_docs.append(chunk)
            batch_ids.append(chunk_id)
            batch_meta.append({
                "filename": os.path.basename(fpath),
                "source": source,
                "rel_path": rel_path,
                "chunk_index": i,
            })

            if len(batch_docs) >= BATCH_SIZE:
                collection.upsert(documents=batch_docs, ids=batch_ids, metadatas=batch_meta)
                batch_docs, batch_ids, batch_meta = [], [], []

    if batch_docs:
        collection.upsert(documents=batch_docs, ids=batch_ids, metadatas=batch_meta)

    stale_ids = existing_ids - current_ids
    for start in range(0, len(stale_ids), BATCH_SIZE):
        collection.delete(ids=list(stale_ids)[start:start + BATCH_SIZE])

    print(f"\nDone. Added {added}, refreshed {updated}, removed {len(stale_ids)} stale chunks.")
    print(f"Total chunks in store: {collection.count()}")
    metadata = {
        "index_version": INDEX_VERSION,
        "embedding_model": EMBEDDING_MODEL,
        "completed_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source_dirs": notes_dirs,
        "files_found": len(all_files),
        "chunks_added": added,
        "chunks_updated": updated,
        "chunks_removed": len(stale_ids),
        "total_chunks": collection.count(),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.metadata_file)), exist_ok=True)
    with open(args.metadata_file, "w", encoding="utf-8") as metadata_file:
        json.dump(metadata, metadata_file, indent=2)


if __name__ == "__main__":
    main()
