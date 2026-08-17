# Sift

Sift is a local-first corpus analysis and manuscript-generation workspace for directory trees of Markdown and text notes. It combines semantic retrieval, hierarchical topic modeling, keyword extraction, concept graphs, and GPU-backed long-form writing behind a FastAPI service and React interface.

The supplied snake mark is used as the application icon and favicon.

## Capabilities

- Recursively index `.md`, `.txt`, `.markdown`, `.text`, and extensionless text files.
- Retrieve relevant note excerpts from a persistent ChromaDB vector index.
- Generate reusable, note-grounded writing plans and human-readable outlines.
- Generate and resume manuscripts for Universal Metaphysics, Tree of Life, and Invocation.
- Extract distinct keywords with KeyBERT.
- Model topics with BERTopic and `KeyBERTInspired` representations.
- Compare topic frequencies across source directories.
- Build document-topic-keyword relationship graphs with NetworkX.
- Monitor long jobs through Server-Sent Events and cancel running workers.
- Keep generated artifacts isolated in collision-safe timestamped run directories.

All language-model inference remains local. Sift does not fine-tune the model or send the note corpus to a cloud API.

## Architecture

```text
React + TypeScript
        |
        | REST + Server-Sent Events
        v
FastAPI application
        |
        | serialized background subprocess queue
        v
Python analysis and generation scripts
        |
        +-- ChromaDB / sentence-transformers
        +-- PyTorch / Transformers / bitsandbytes / Qwen
        +-- KeyBERT / BERTopic / NetworkX
```

### Why Python owns AI workloads

The existing CUDA, quantization, embedding, retrieval, and modeling stack is implemented in Python. FastAPI remains alive between browser requests and delegates long operations to one serialized job queue. Serial execution prevents multiple model processes from competing for GPU memory.

The React application contains no model runtime. It manages controls, server state, live progress, artifacts, charts, and graph interaction.

## Repository Layout

```text
api/
    main.py              FastAPI routes, run discovery, SSE streams
    jobs.py              serialized subprocess queue and cancellation
    schemas.py           Pydantic API contracts
code/
    index_notes.py       recursive text indexing into ChromaDB
    write_book.py        writing-plan, outline, and manuscript generation
    analyze_corpus.py    KeyBERT, BERTopic, and graph analysis
    generate_concepts.py concept glossary generation
    chat.py              terminal RAG chat
frontend/
    src/                 React UI, API client, charts, graph, SSE hook
    public/favicon.svg   snake application mark
    package.json         frontend dependencies and scripts
data/
    input/               source notes and chapter_structure.csv
    intermediary/        vector index, writing plans, progress, caches
    output/              human outlines, manuscripts, analyses, exports
tests/
    test_api.py          API behavior and validation checks
app.py                   legacy interactive terminal workflow
requirements.txt         Python runtime and test dependencies
```

## Prerequisites

- Windows with PowerShell, or an equivalent shell with command adjustments.
- Python 3.11 or newer. The current workspace uses Python 3.13.
- Node.js 20 or newer. The current workspace uses Node.js 22.
- NVIDIA CUDA-capable GPU for Qwen manuscript generation.
- Enough disk space for Hugging Face model caches and the local vector index.

Indexing and BERTopic can use substantial CPU and memory. Qwen generation requires CUDA by default; CPU fallback must be explicitly enabled in the underlying scripts.

## Installation

Create and activate a virtual environment, then install Python dependencies:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Install frontend dependencies:

```powershell
cd frontend
npm install
cd ..
```

The first model-backed operation may download sentence-transformer or Qwen weights from Hugging Face. Setting `HF_TOKEN` is optional but raises download rate limits.

## Running the Web Application

Start the API from the repository root:

```powershell
.\.venv\Scripts\python.exe -m uvicorn api.main:app --reload --port 8000
```

Start the frontend in a second terminal:

```powershell
cd frontend
npm run dev
```

Open:

- Sift: http://127.0.0.1:5173
- API documentation: http://127.0.0.1:8000/docs
- OpenAPI schema: http://127.0.0.1:8000/openapi.json

Set `VITE_API_URL` before starting Vite when the API is not on `http://localhost:8000`.

## Web Workspaces

### Manuscript Operations

The main workspace displays index health, available texts, generated runs, compatible writing-plan caches, and recent background activity.

A new manuscript run performs these stages:

1. Read `data/input/chapter_structure.csv`.
2. Select rows whose `Generate Text` value is `Yes`.
3. Retrieve relevant indexed excerpts for every selected section.
4. Generate or reuse the complete machine writing plan.
5. Render a separate human-readable content outline.
6. Generate prose from the plan, CSV hierarchy, and retrieved evidence.
7. Persist progress after every section so interrupted runs can resume.

CSV headings and descriptions are provisional because the chapter structure was derived from only part of the corpus. The planning prompt instructs Qwen to resolve bracketed headings and questionable descriptions against the complete writing-desktop and Notion index.

### Corpus Intelligence

The Analysis workspace processes every eligible document under the selected source tree. Individual document reads are bounded by `--max-chars` to prevent one unusually large export from dominating memory, but documents are not omitted by count.

The worker:

1. Traverses the complete selected source directory and reads bounded text samples.
2. Embeds documents with `all-MiniLM-L6-v2`.
3. Extracts diverse phrases with KeyBERT and maximal marginal relevance.
4. Fits BERTopic using precomputed embeddings and `KeyBERTInspired` labels.
5. Maps topic frequencies to relative source directories with `topics_per_class`.
6. Builds a NetworkX graph linking documents, topics, and mentioned keywords.
7. Writes one JSON-safe analysis payload using pandas `orient="records"` conversion.

Completed results provide keyword rankings, topic-frequency charts, and an interactive force graph with pan, zoom, and node inspection. The worker emits scan, embedding, keyword, topic, hierarchy, and graph phase updates. During silent third-party operations it emits a heartbeat every 15 seconds; these messages stream to the live job drawer over SSE.

### Run Library

Each manuscript row reports outline and prose completion independently. Existing human outlines and manuscripts can be opened in a side drawer. Continuing a run reuses its run-scoped `progress.json` and writing plan.

### Job Console

Indexing, outline generation, manuscript generation, and corpus analysis are background jobs. The API launches one worker subprocess at a time. The UI receives complete job snapshots through SSE, including accumulated logs and final status.

Cancelling a Windows worker sends `CTRL_BREAK_EVENT`, allowing Python code to flush resumable files before exit.

## Data and Artifact Ownership

Source files remain under `data/input`:

```text
data/input/chapter_structure.csv
data/input/writing-desktop/
data/input/notion/Writing/
```

The shared vector store is:

```text
data/intermediary/chroma_db/
```

A manuscript run uses matching intermediary and output paths:

```text
data/intermediary/generated202608161531/tree_of_life/
    writing_plan.md
    progress.json

data/output/generated202608161531/tree_of_life/
    outline.md
    manuscript.md
```

An analysis run writes:

```text
data/output/generated202608161531/analysis/analysis.json
```

Minute collisions receive `-2`, `-3`, and subsequent suffixes. New runs therefore never overwrite earlier output.

## Direct Script Usage

The web interface is recommended, but each worker remains independently usable.

### Index notes

```powershell
python code/index_notes.py
```

Important options:

- `--notes-dirs PATH [PATH ...]`
- `--db-dir PATH`
- `--metadata-file PATH`

Chunk IDs are deterministic. Existing IDs are skipped during subsequent indexing runs.

### Inspect generation status

```powershell
python code/write_book.py --system "Universal Metaphysics" --status-only
```

### Generate only an outline

```powershell
python code/write_book.py --system "Universal Metaphysics" --outline-only
```

### Generate or resume a manuscript

```powershell
python code/write_book.py --system "Tree of Life" --run-id generated202608161531
```

Generation is CUDA-only unless `--allow-cpu` is deliberately supplied.

### Analyze a corpus

```powershell
python code/analyze_corpus.py --source data/input
```

Useful controls:

- `--max-chars` bounds each document sample.
- `--min-topic-size` controls BERTopic cluster granularity.
- `--run-id` selects the output directory name.

### Generate a concept glossary

```powershell
python code/generate_concepts.py --target-count 200
```

Candidate batches are cached and resumable. Exact and semantic duplicates are removed before writing `data/output/concepts.md`.

### Terminal chat

```powershell
python code/chat.py
```

Commands: `/history`, `/clear`, `/save [file]`, and `/quit`.

## API Overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Process health |
| `GET` | `/api/index/status` | Vector-index status and metadata |
| `POST` | `/api/index` | Queue indexing |
| `GET` | `/api/systems` | Available manuscript systems and section counts |
| `GET` | `/api/outlines/{system}/caches` | Compatible writing-plan caches |
| `POST` | `/api/outlines` | Queue outline generation or cache reuse |
| `POST` | `/api/manuscripts` | Queue new/resumed manuscript generation |
| `GET` | `/api/runs` | Lightweight generated-run summaries |
| `GET` | `/api/runs/{run}/{system}/artifacts/{kind}` | Read outline, manuscript, or writing plan |
| `POST` | `/api/analyses` | Queue KeyBERT/BERTopic/NetworkX analysis |
| `GET` | `/api/analyses` | Completed analysis summaries |
| `GET` | `/api/analyses/{run}` | Full analysis payload |
| `GET` | `/api/jobs` | Current API-session job history |
| `GET` | `/api/jobs/{id}/events` | Live SSE job snapshots |
| `DELETE` | `/api/jobs/{id}` | Cancel queued/running work |

Every request and response body has an explicit Pydantic schema where applicable. The frontend mirrors those contracts in `frontend/src/types.ts`.

## Validation

Run backend tests:

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Run frontend lint and production build:

```powershell
cd frontend
npm run lint
npm run build
```

The production build lazy-loads the analysis bundle so Recharts and `react-force-graph-2d` do not delay the manuscript workspace.

## Troubleshooting

### Index appears unavailable

Confirm `data/intermediary/chroma_db/chroma.sqlite3` exists, then rerun `python code/index_notes.py`. The UI may briefly show its loading fallback before TanStack Query receives index status.

### CUDA model loading fails

Verify `torch.cuda.is_available()` and the selected GPU environment. Sift stops rather than silently offloading model parameters to CPU. This avoids locking the computer with a full 7B CPU model.

### GPU out-of-memory

Only one API job runs at a time, but other applications can still consume VRAM. Stop other model processes and retry. Concept generation uses bounded prompt/output budgets and clears temporary CUDA allocations between batches.

### A generated run is missing

The Run Library discovers manuscript runs under `data/intermediary/generated*/<book>` and matching output folders. Analysis runs appear separately under Corpus Intelligence.

### Frontend cannot reach the API

Confirm FastAPI is listening on port 8000 and that `VITE_API_URL` matches it. Development CORS permits `localhost:5173` and `127.0.0.1:5173`.

### Hugging Face warning about unauthenticated requests

Local inference still works. Set an `HF_TOKEN` environment variable to improve model download rate limits.
