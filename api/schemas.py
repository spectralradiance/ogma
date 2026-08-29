"""Pydantic contracts shared by Ogma's REST and SSE endpoints.

These models are mirrored by strict interfaces in ``frontend/src/types.ts``.
Keep both sides synchronized when fields or allowed state values change.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


# Literal state values keep the generated OpenAPI schema and TypeScript client
# honest about the finite set of operations the job queue understands.
JobKind = Literal["index", "organize_chaos", "outline", "manuscript", "analysis", "concepts", "chat", "download_model"]
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


class WorkspaceFileSummary(BaseModel):
    path: str
    size: int
    modified_at: datetime


class WorkspaceFileResponse(WorkspaceFileSummary):
    content: str


class WorkspaceFileUpdate(BaseModel):
    path: str
    content: str


class IndexRequest(BaseModel):
    notes_dirs: list[str] | None = None


class OrganizeChaosRequest(BaseModel):
    dry_run: bool = False
    threshold: float | None = Field(default=None, gt=0, le=1)
    run_id: str | None = None


class ChaosStatus(BaseModel):
    unsorted_files: int
    imported_files: int
    last_run_at: datetime | None = None


class OutlineRequest(BaseModel):
    system: str
    run_id: str | None = None
    cache_path: str | None = None
    regenerate: bool = False
    provider: Literal["local", "claude"] | None = None
    extract_model_name: str | None = None
    model_name: str | None = None


class ManuscriptRequest(BaseModel):
    system: str
    run_id: str | None = None
    cache_path: str | None = None
    regenerate_outline: bool = False
    provider: Literal["local", "claude"] | None = None
    extract_model_name: str | None = None
    write_model_name: str | None = None
    model_name: str | None = None


class AnalysisRequest(BaseModel):
    source: str | None = None
    run_id: str | None = None
    max_chars: int = Field(default=12000, ge=500, le=100000)
    min_topic_size: int | None = Field(default=None, ge=2, le=1000)
    embedding_model: str | None = None


class AnalysisSummary(BaseModel):
    run_id: str
    created_at: str
    source: str
    embedding_model: str | None = None
    document_count: int
    keyword_count: int
    topic_count: int


class ConceptsRequest(BaseModel):
    target_count: int = Field(default=200, ge=1, le=5000)
    provider: Literal["local", "claude"] | None = None
    extract_model_name: str | None = None
    systems: list[str] | None = None
    run_id: str | None = None


class ConceptsArtifact(BaseModel):
    content: str
    modified_at: datetime | None = None


class PipelineStepFiles(BaseModel):
    step: str
    label: str
    done: bool
    detail: str | None = None
    files: list[str] = Field(default_factory=list)


class PipelineRun(BaseModel):
    run_id: str
    created_at: datetime
    steps: list[PipelineStepFiles]
    generation_model: str | None = None
    embedding_model: str | None = None


class CreatePipelineRunRequest(BaseModel):
    generation_model: str | None = None
    embedding_model: str | None = None


class ModelCatalogEntry(BaseModel):
    value: str
    label: str
    kind: Literal["generation", "embedding"]
    provider: Literal["local", "claude"]
    builtin: bool
    downloaded: bool


class AddModelRequest(BaseModel):
    value: str
    label: str
    kind: Literal["generation", "embedding"]
    provider: Literal["local", "claude"] = "local"


class DownloadModelRequest(BaseModel):
    value: str


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatSession(BaseModel):
    session_id: str
    updated_at: datetime | None = None
    messages: list[ChatMessage] = Field(default_factory=list)


class ChatRequest(BaseModel):
    session_id: str
    message: str
    provider: Literal["local", "claude"] | None = None
    model_name: str | None = None
    top_k: int | None = None
    no_rag: bool = False


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
