"""Pydantic contracts shared by Sift's REST and SSE endpoints.

These models are mirrored by strict interfaces in ``frontend/src/types.ts``.
Keep both sides synchronized when fields or allowed state values change.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


# Literal state values keep the generated OpenAPI schema and TypeScript client
# honest about the finite set of operations the job queue understands.
JobKind = Literal["index", "outline", "manuscript", "analysis"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class IndexStatus(BaseModel):
    available: bool
    completed_at: str | None = None
    files_found: int | None = None
    total_chunks: int | None = None
    database_modified_at: str | None = None


class SystemSummary(BaseModel):
    name: str
    sections: int


class OutlineCache(BaseModel):
    path: str
    modified_at: datetime
    sections: int


class RunSummary(BaseModel):
    run_id: str
    system: str
    outline_sections: int
    completed_sections: int
    total_sections: int
    has_human_outline: bool
    has_manuscript: bool
    modified_at: datetime


class ArtifactResponse(BaseModel):
    run_id: str
    system: str
    kind: Literal["outline", "manuscript", "writing_plan"]
    content: str


class IndexRequest(BaseModel):
    notes_dirs: list[str] | None = None


class OutlineRequest(BaseModel):
    system: str
    cache_path: str | None = None
    regenerate: bool = False


class ManuscriptRequest(BaseModel):
    system: str
    run_id: str | None = None
    cache_path: str | None = None
    regenerate_outline: bool = False


class AnalysisRequest(BaseModel):
    source: str | None = None
    max_chars: int = Field(default=12000, ge=500, le=100000)
    min_topic_size: int = Field(default=5, ge=2, le=100)


class AnalysisSummary(BaseModel):
    run_id: str
    created_at: str
    source: str
    document_count: int
    keyword_count: int
    topic_count: int


class JobResponse(BaseModel):
    id: str
    kind: JobKind
    status: JobStatus
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    command: list[str]
    run_id: str | None = None
    system: str | None = None
    return_code: int | None = None
    logs: list[str] = Field(default_factory=list)
    error: str | None = None
