"""FastAPI boundary for Sift's local corpus and manuscript workflows.

Read-only endpoints inspect artifacts directly. Mutating or compute-heavy
operations are delegated to the serialized ``JobManager`` and existing Python
scripts, preserving one implementation of indexing and generation behavior.
"""

import asyncio
import csv
from contextlib import asynccontextmanager
from datetime import datetime
import json
from pathlib import Path
import re
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from api.jobs import JobManager
from api.schemas import (
    AnalysisRequest,
    AnalysisSummary,
    ArtifactResponse,
    IndexRequest,
    IndexStatus,
    JobResponse,
    ManuscriptRequest,
    OutlineCache,
    OutlineRequest,
    RunSummary,
    SystemSummary,
)


# Resolve all storage from the repository root instead of the process working
# directory. This keeps CLI, API, tests, and VS Code launch configurations from
# accidentally writing to different intermediary/output trees.
ROOT = Path(__file__).resolve().parent.parent
CODE_DIR = ROOT / "code"
DATA_DIR = ROOT / "data"
INPUT_DIR = DATA_DIR / "input"
INTERMEDIARY_DIR = DATA_DIR / "intermediary"
OUTPUT_DIR = DATA_DIR / "output"
CSV_FILE = INPUT_DIR / "chapter_structure.csv"
INDEX_METADATA = INTERMEDIARY_DIR / "index_metadata.json"
DB_FILE = INTERMEDIARY_DIR / "chroma_db" / "chroma.sqlite3"
PIPELINE_VERSION = "outline-v3"
SYSTEM_SLUGS = {
    "Universal Metaphysics": "universal_metaphysics",
    "Tree of Life": "tree_of_life",
    "Invocation": "invocation",
}

manager = JobManager(ROOT)


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Create storage roots and bind the job queue to the server event loop."""
    INTERMEDIARY_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    await manager.start()
    yield
    await manager.stop()


app = FastAPI(title="Sift API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_rows() -> list[dict[str, str]]:
    """Read chapter metadata on demand so CSV edits appear without API restart."""
    with CSV_FILE.open(newline="", encoding="utf-8") as csv_file:
        return list(csv.DictReader(csv_file))


def selected_rows(system: str) -> list[dict[str, str]]:
    """Return only rows explicitly marked for generated prose."""
    return [
        row for row in load_rows()
        if row["System"] == system and row.get("Generate Text", "").strip().lower() == "yes"
    ]


def ensure_system(system: str) -> str:
    """Validate a public book name and return its filesystem-safe slug."""
    if system not in SYSTEM_SLUGS:
        raise HTTPException(status_code=422, detail=f"Unknown system: {system}")
    return SYSTEM_SLUGS[system]


def new_run_id() -> str:
    """Create a minute-based ID and add a suffix when runs share a minute."""
    base = f"generated{datetime.now():%Y%m%d%H%M}"
    candidate = base
    suffix = 2
    while (OUTPUT_DIR / candidate).exists() or (INTERMEDIARY_DIR / candidate).exists():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def parse_plan_count(path: Path) -> int:
    """Count machine-plan sections compatible with the current pipeline version."""
    if not path.is_file():
        return 0
    content = path.read_text(encoding="utf-8", errors="ignore")
    return len(re.findall(rf"<!-- section: {re.escape(PIPELINE_VERSION)}\|", content))


def validate_cache(path_text: str) -> Path:
    """Allow reuse only from the managed intermediary tree.

    Besides preventing arbitrary file reads, this guarantees selected caches
    use the same artifact ownership model as generated runs.
    """
    path = Path(path_text).resolve()
    try:
        path.relative_to(INTERMEDIARY_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Outline cache must be inside data/intermediary") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Outline cache not found")
    return path


def outline_caches(system: str) -> list[OutlineCache]:
    """Discover legacy and run-scoped plans that contain current-version keys."""
    slug = ensure_system(system)
    candidates = set(INTERMEDIARY_DIR.glob(f"{slug}_outline*.md"))
    candidates.update(INTERMEDIARY_DIR.glob(f"generated*/{slug}/writing_plan.md"))
    result = []
    for path in candidates:
        sections = parse_plan_count(path)
        if sections:
            result.append(
                OutlineCache(
                    path=str(path),
                    modified_at=datetime.fromtimestamp(path.stat().st_mtime).astimezone(),
                    sections=sections,
                )
            )
    return sorted(result, key=lambda item: item.modified_at, reverse=True)


def run_summary(run_dir: Path, system: str) -> RunSummary:
    """Aggregate lightweight run status without loading manuscript contents."""
    slug = ensure_system(system)
    intermediary_book = INTERMEDIARY_DIR / run_dir.name / slug
    output_book = OUTPUT_DIR / run_dir.name / slug
    plan = intermediary_book / "writing_plan.md"
    progress = intermediary_book / "progress.json"
    completed = 0
    if progress.is_file():
        try:
            completed = len(json.loads(progress.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, TypeError):
            completed = 0
    paths = [path for path in (intermediary_book, output_book) if path.exists()]
    modified = max((path.stat().st_mtime for path in paths), default=run_dir.stat().st_mtime)
    return RunSummary(
        run_id=run_dir.name,
        system=system,
        outline_sections=parse_plan_count(plan),
        completed_sections=completed,
        total_sections=len(selected_rows(system)),
        has_human_outline=(output_book / "outline.md").is_file(),
        has_manuscript=(output_book / "manuscript.md").is_file(),
        modified_at=datetime.fromtimestamp(modified).astimezone(),
    )


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/index/status", response_model=IndexStatus)
async def index_status() -> IndexStatus:
    if INDEX_METADATA.is_file():
        try:
            metadata = json.loads(INDEX_METADATA.read_text(encoding="utf-8"))
            return IndexStatus(
                available=DB_FILE.is_file(),
                completed_at=metadata.get("completed_at"),
                files_found=metadata.get("files_found"),
                total_chunks=metadata.get("total_chunks"),
                database_modified_at=(
                    datetime.fromtimestamp(DB_FILE.stat().st_mtime).astimezone().isoformat()
                    if DB_FILE.is_file() else None
                ),
            )
        except (json.JSONDecodeError, OSError):
            pass
    return IndexStatus(
        available=DB_FILE.is_file(),
        database_modified_at=(
            datetime.fromtimestamp(DB_FILE.stat().st_mtime).astimezone().isoformat()
            if DB_FILE.is_file() else None
        ),
    )


@app.post("/api/index", response_model=JobResponse, status_code=202)
async def start_index(request: IndexRequest) -> JobResponse:
    arguments = [str(CODE_DIR / "index_notes.py")]
    if request.notes_dirs:
        arguments.extend(["--notes-dirs", *request.notes_dirs])
    return await manager.submit("index", arguments)


@app.get("/api/systems", response_model=list[SystemSummary])
async def systems() -> list[SystemSummary]:
    return [SystemSummary(name=system, sections=len(selected_rows(system))) for system in SYSTEM_SLUGS]


@app.get("/api/outlines/{system}/caches", response_model=list[OutlineCache])
async def caches(system: str) -> list[OutlineCache]:
    return outline_caches(system)


@app.post("/api/outlines", response_model=JobResponse, status_code=202)
async def start_outline(request: OutlineRequest) -> JobResponse:
    ensure_system(request.system)
    if request.cache_path and request.regenerate:
        raise HTTPException(status_code=422, detail="Choose cache reuse or regeneration")
    run_id = new_run_id()
    arguments = [
        str(CODE_DIR / "write_book.py"),
        "--system", request.system,
        "--run-id", run_id,
        "--outline-only",
    ]
    if request.cache_path:
        arguments.extend(["--outline-cache", str(validate_cache(request.cache_path))])
    else:
        arguments.append("--regenerate-outline")
    return await manager.submit("outline", arguments, run_id=run_id, system=request.system)


@app.post("/api/manuscripts", response_model=JobResponse, status_code=202)
async def start_manuscript(request: ManuscriptRequest) -> JobResponse:
    slug = ensure_system(request.system)
    run_id = request.run_id or new_run_id()
    if request.run_id and not (INTERMEDIARY_DIR / run_id / slug).exists():
        raise HTTPException(status_code=404, detail="Run not found for this system")
    arguments = [
        str(CODE_DIR / "write_book.py"),
        "--system", request.system,
        "--run-id", run_id,
    ]
    if request.cache_path:
        arguments.extend(["--outline-cache", str(validate_cache(request.cache_path))])
    elif request.regenerate_outline:
        arguments.append("--regenerate-outline")
    return await manager.submit("manuscript", arguments, run_id=run_id, system=request.system)


@app.post("/api/analyses", response_model=JobResponse, status_code=202)
async def start_analysis(request: AnalysisRequest) -> JobResponse:
    run_id = new_run_id()
    arguments = [
        str(CODE_DIR / "analyze_corpus.py"),
        "--run-id", run_id,
        "--max-documents", str(request.max_documents),
        "--max-chars", str(request.max_chars),
        "--min-topic-size", str(request.min_topic_size),
    ]
    if request.source:
        source = Path(request.source).resolve()
        if not source.is_dir():
            raise HTTPException(status_code=422, detail="Analysis source directory not found")
        arguments.extend(["--source", str(source)])
    return await manager.submit("analysis", arguments, run_id=run_id)


def analysis_payloads():
    """Yield readable analysis payloads while ignoring partial/corrupt files."""
    for path in OUTPUT_DIR.glob("generated*/analysis/analysis.json"):
        try:
            yield path, json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue


@app.get("/api/analyses", response_model=list[AnalysisSummary])
async def analyses() -> list[AnalysisSummary]:
    result = []
    for _, payload in analysis_payloads():
        result.append(AnalysisSummary(
            run_id=payload["run_id"],
            created_at=payload["created_at"],
            source=payload["source"],
            document_count=payload["document_count"],
            keyword_count=len(payload.get("keywords", [])),
            topic_count=len([topic for topic in payload.get("topics", []) if topic.get("Topic", -1) >= 0]),
        ))
    return sorted(result, key=lambda item: item.created_at, reverse=True)


@app.get("/api/analyses/{run_id}")
async def analysis(run_id: str) -> dict:
    path = OUTPUT_DIR / run_id / "analysis" / "analysis.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Analysis not found")
    return json.loads(path.read_text(encoding="utf-8"))


@app.get("/api/runs", response_model=list[RunSummary])
async def runs(system: str | None = None) -> list[RunSummary]:
    requested = [system] if system else list(SYSTEM_SLUGS)
    for item in requested:
        ensure_system(item)
    run_dirs = sorted(INTERMEDIARY_DIR.glob("generated*"), reverse=True)
    summaries = []
    for run_dir in run_dirs:
        if not run_dir.is_dir():
            continue
        for item in requested:
            slug = SYSTEM_SLUGS[item]
            if (run_dir / slug).exists() or (OUTPUT_DIR / run_dir.name / slug).exists():
                summaries.append(run_summary(run_dir, item))
    return sorted(summaries, key=lambda item: item.modified_at, reverse=True)


@app.get("/api/runs/{run_id}/{system}/artifacts/{kind}", response_model=ArtifactResponse)
async def artifact(
    run_id: str,
    system: str,
    kind: Literal["outline", "manuscript", "writing_plan"],
) -> ArtifactResponse:
    slug = ensure_system(system)
    files = {
        "outline": OUTPUT_DIR / run_id / slug / "outline.md",
        "manuscript": OUTPUT_DIR / run_id / slug / "manuscript.md",
        "writing_plan": INTERMEDIARY_DIR / run_id / slug / "writing_plan.md",
    }
    path = files[kind]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Artifact not found")
    return ArtifactResponse(run_id=run_id, system=system, kind=kind, content=path.read_text(encoding="utf-8"))


@app.get("/api/jobs", response_model=list[JobResponse])
async def jobs() -> list[JobResponse]:
    return manager.list()


@app.get("/api/jobs/{job_id}", response_model=JobResponse)
async def job(job_id: str) -> JobResponse:
    result = manager.get(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return result.response()


@app.delete("/api/jobs/{job_id}", response_model=JobResponse)
async def cancel_job(job_id: str) -> JobResponse:
    result = await manager.cancel(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return result


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    selected = manager.get(job_id)
    if selected is None:
        raise HTTPException(status_code=404, detail="Job not found")

    async def stream():
        last_payload = ""
        while True:
            payload = selected.response().model_dump_json()
            if payload != last_payload:
                yield f"data: {payload}\n\n"
                last_payload = payload
            if selected.status in {"completed", "failed", "cancelled"}:
                break
            try:
                await asyncio.wait_for(selected.changed.wait(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
            selected.changed.clear()

    return StreamingResponse(stream(), media_type="text/event-stream")
