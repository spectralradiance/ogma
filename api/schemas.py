from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


JobKind = Literal["index", "outline", "manuscript"]
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
