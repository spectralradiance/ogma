# Metaphysics Manuscript Generator

This project writes a full-length philosophical manuscript from a structured outline, using a local large language model grounded entirely in the author's own research notes. No cloud APIs or training are involved. The notes are indexed as retrieval input, and every generated paragraph is anchored to material the author has already written.

## Purpose

The author has accumulated thousands of raw notes on metaphysics, mysticism, and related philosophy. Separately, `data/input/chapter_structure.csv` defines the exact structure of Universal Metaphysics, Tree of Life, and Invocation. Its `Generate Text` column explicitly determines which rows receive an outline and generated prose; rows marked `No` still provide structural headings and context.

The pipeline bridges these two artefacts. It embeds the notes into a searchable vector store, then for each section of the book it retrieves the most relevant note excerpts and feeds them — alongside the section's metadata — to a local language model, instructing it to synthesize the material into authoritative philosophical prose. The model acts as a compositor, not an inventor: it forms the author's ideas into coherent paragraphs without introducing outside content.

## How It Works

### Stage 1 — Indexing (`index_notes.py`)

1. Walk each source directory recursively and collect every `.md`, `.txt`, and extension-less text file. Binary files (images, ZIPs, etc.) are detected by header bytes and skipped automatically.
2. Chunk each file into overlapping text segments (1 400-character chunks, 250-character overlap) so that no idea is split across a retrieval boundary.
3. Embed each chunk using `all-MiniLM-L6-v2` (a fast, local sentence-embedding model that runs entirely on CPU).
4. Upsert the embeddings, raw text, and file metadata (filename, relative path, chunk index) into a persistent ChromaDB collection stored in `data/intermediary/chroma_db`. Chunk IDs are deterministic, so re-running the script only adds new or changed content.

### Stage 2 — Generation (`write_book.py`)

1. Load one selected book from the chapter breakdown CSV and select every row whose `Generate Text` value is `Yes`.
2. Search ChromaDB for notes relevant to every section and create a book-level Markdown writing outline under `intermediary`. Each plan records scope, transitions, concepts, note terminology, and material reserved for neighboring sections.
3. Reuse the Markdown outline when it already contains every section. Prose generation does not begin until the full outline is complete.
4. Load `write_book_progress.json` to skip sections already written for that book and pipeline version.
5. For each pending section, retrieve its supporting notes again and generate prose from both those excerpts and its saved plan.

## Technologies

| Technology | Role |
|---|---|
| `Qwen/Qwen2.5-7B-Instruct` | Generation model; 7 B parameter instruction-tuned LLM |
| `transformers` | Model and tokenizer loading, chat-template application, `generate()` |
| `bitsandbytes` | 4-bit NF4 quantization, reducing VRAM from ~14 GB to ~6 GB |
| `accelerate` | Automatic device mapping across GPU layers |
| `chromadb` | Local persistent vector store for note chunks |
| `sentence-transformers` | `all-MiniLM-L6-v2` embedding model (CPU-side, no GPU required) |
| `torch` | Tensor operations and CUDA inference |
| `tqdm` | Progress bars during the indexing pass |

## Usage

### Web application

Start the persistent Python API:

```
python -m uvicorn api.main:app --reload --port 8000
```

In a second terminal, start the React interface:

```
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The web console exposes index status and reindexing, book and outline-cache selection, timestamped manuscript runs, live SSE job logs, cancellation, run history, and generated outline/manuscript viewing. GPU jobs are serialized by the backend so model processes do not compete for VRAM.

Backend checks run with `python -m pytest`; frontend checks run with `npm run lint` and `npm run build` from `frontend`.

### Interactive CLI

```
python app.py
```

The CLI is the primary entry point. It provides these actions:

- **Index notes** shows the last completed index date, then optionally runs `index_notes.py`.
- **Generate or reuse an outline** selects a book and either reuses a compatible dated cache or regenerates the outline from the indexed notes.
- **Generate manuscript text** selects Universal Metaphysics, Tree of Life, or Invocation and starts or resumes a dated run.
- **Open chat** starts a run-scoped RAG chat session.

Each new run uses a collision-safe name such as `generated202608161531`. Its artifacts are isolated by book:

```
data/output/generated202608161531/tree_of_life/
	outline.md
	manuscript.md
data/intermediary/generated202608161531/tree_of_life/
	writing_plan.md
	progress.json
```

`writing_plan.md` contains detailed instructions consumed by the prose generator. `outline.md` is a clean, human-readable content outline with each section's central claim, major points, evidence, transitions, terminology, and boundaries.

The chapter CSV was developed from only a subset of the notes. Outline generation therefore treats its headings and descriptions as provisional. Bracketed headings are explicitly resolved against retrieved material from the complete `input/writing-desktop` and `input/notion/Writing` collections, and note evidence may refine an inaccurate CSV description.

### 1. Install dependencies

```
pip install -r requirements.txt
```

### 2. Index the notes

```
python code/index_notes.py
```

| Flag | Default | Description |
|---|---|---|
| `--notes-dirs PATH [PATH ...]` | `data/input/writing-desktop` `data/input/notion/Writing` | One or more root directories to index |
| `--db-dir PATH` | `data/intermediary/chroma_db` | Where to write the ChromaDB store |

Safe to re-run — already-indexed chunks are skipped.

### 3. Generate the manuscript

```
python code/write_book.py --system "Universal Metaphysics"
```

| Flag | Default | Description |
|---|---|---|
| `--db-dir PATH` | `data/intermediary/chroma_db` | ChromaDB store to query |
| `--notes-top-k N` | `5` | Note chunks to retrieve per section |
| `--system NAME` | required | Book to generate from the CSV, such as `Universal Metaphysics` or `Tree of Life` |
| `--outline-only` | off | Create or complete the Markdown outline, then stop before prose generation |
| `--status-only` | off | Show the selected book's current outline and manuscript progress without loading Qwen |
| `--allow-cpu` | off | Explicitly permit slow, memory-intensive CPU generation |

Generation requires CUDA by default and stops if CUDA loading fails or any model parameters are offloaded to the CPU. The CLI writes run-scoped outlines under `data/intermediary/generated*/<book>/` and prose under `data/output/generated*/<book>/`. Chapter introduction rows are generated as numbered sections such as `3.0 Introduction`. Both stages can be interrupted and resumed.

### 4. Generate the concept glossary

```
python code/generate_concepts.py
```

This searches the same indexed notes using all CSV rows marked `Generate Text = Yes`, generates resumable candidate batches on the GPU, semantically removes near-duplicates, and writes approximately 200 concepts with 2-3 sentence descriptions to `data/output/concepts.md`.

| Flag | Default | Description |
|---|---|---|
| `--target-count N` | `200` | Maximum number of concepts to write |
| `--system NAME` | all systems | Limit source coverage; repeat the flag for multiple books |
| `--notes-top-k N` | `5` | Note chunks retrieved for each chapter section |
| `--similarity-threshold N` | `0.86` | Semantic similarity at which a candidate is treated as a duplicate |
| `--output PATH` | `data/output/concepts.md` | Markdown output path |
| `--allow-cpu` | off | Explicitly permit slow CPU generation |

### 5. Interactive chat

Open a conversation with the model, optionally grounded in the indexed notes:

```
python code/chat.py
```

| Flag | Default | Description |
|---|---|---|
| `--db-dir PATH` | `data/intermediary/chroma_db` | ChromaDB store to query |
| `--top-k N` | `4` | Note chunks to retrieve per message |
| `--no-rag` | off | Disable retrieval entirely |

Conversation history is saved automatically to `chat_history.json` and reloaded on the next run. In-session commands:

| Command | Action |
|---|---|
| `/clear` | Erase history and start fresh |
| `/history` | Print the conversation so far |
| `/save [file]` | Export conversation to a markdown file |
| `/quit` | Exit |

## Files

| File | Description |
|---|---|
| `app.py` | Interactive workflow CLI |
| `code/index_notes.py` | Chunks, embeds, and indexes notes into ChromaDB |
| `code/write_book.py` | Retrieves context and generates prose for each CSV section |
| `code/chat.py` | Interactive RAG-augmented chat with persistent history |
| `requirements.txt` | Python dependencies |
| `data/input/` | Chapter structure and source notes |
| `data/intermediary/chroma_db/` | Persistent vector store created from the source notes |
| `data/intermediary/generated*/` | Run-scoped writing plans, progress, and chat history |
| `data/output/generated*/` | Run-scoped outlines, manuscripts, and chat exports |
| `code/train_ai/` | Archived fine-tuning code; not used by the active workflow |
