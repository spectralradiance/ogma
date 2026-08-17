"""In-process queue for long-running Python workers.

The API deliberately uses one consumer. Indexing and local model processes are
memory intensive, and concurrent GPU jobs can exhaust VRAM or make the desktop
unresponsive. Jobs survive for the lifetime of the API process and expose their
captured output to both polling endpoints and Server-Sent Events.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
import os
import signal
import subprocess
import sys
from uuid import uuid4

from api.schemas import JobKind, JobResponse, JobStatus


@dataclass
class Job:
    """Mutable runtime state for one queued subprocess.

    ``process`` and ``changed`` are internal synchronization details and are
    omitted from the Pydantic response returned to clients.
    """
    id: str
    kind: JobKind
    command: list[str]
    created_at: datetime
    run_id: str | None = None
    system: str | None = None
    status: JobStatus = "queued"
    started_at: datetime | None = None
    finished_at: datetime | None = None
    return_code: int | None = None
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    process: subprocess.Popen[str] | None = field(default=None, repr=False)
    changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def response(self) -> JobResponse:
        """Create an immutable API snapshot of the current job state."""
        return JobResponse(
            id=self.id,
            kind=self.kind,
            status=self.status,
            created_at=self.created_at,
            started_at=self.started_at,
            finished_at=self.finished_at,
            command=self.command,
            run_id=self.run_id,
            system=self.system,
            return_code=self.return_code,
            logs=self.logs,
            error=self.error,
        )


class JobManager:
    """Serialize worker subprocesses and retain their logs for the API session."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.worker: asyncio.Task[None] | None = None

    async def start(self) -> None:
        """Start a fresh queue consumer for the current asyncio event loop.

        Recreating the queue matters in tests and development reloads because
        asyncio primitives are bound to the loop on which they are first used.
        """
        if self.worker is None:
            self.queue = asyncio.Queue()
            self.worker = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        """Stop the queue consumer during FastAPI lifespan shutdown."""
        if self.worker is not None:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
            self.worker = None

    async def submit(
        self,
        kind: JobKind,
        arguments: list[str],
        run_id: str | None = None,
        system: str | None = None,
    ) -> JobResponse:
        """Register a subprocess invocation and enqueue it without blocking HTTP."""
        # ``-u`` disables Python's stdio buffering so phase/progress messages
        # become visible to SSE clients immediately rather than at process exit.
        command = [sys.executable, "-u", *arguments]
        job = Job(
            id=uuid4().hex,
            kind=kind,
            command=command,
            created_at=datetime.now().astimezone(),
            run_id=run_id,
            system=system,
        )
        self.jobs[job.id] = job
        await self.queue.put(job)
        return job.response()

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self) -> list[JobResponse]:
        return [
            job.response()
            for job in sorted(self.jobs.values(), key=lambda item: item.created_at, reverse=True)
        ]

    async def cancel(self, job_id: str) -> JobResponse | None:
        """Cancel queued work or signal a running process group.

        Windows needs ``CTRL_BREAK_EVENT`` so Python workers can unwind and
        flush resumable progress rather than being terminated without cleanup.
        """
        job = self.jobs.get(job_id)
        if job is None:
            return None
        if job.process and job.status == "running":
            if os.name == "nt":
                job.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                job.process.terminate()
            job.status = "cancelled"
            job.finished_at = datetime.now().astimezone()
            job.changed.set()
        elif job.status == "queued":
            job.status = "cancelled"
            job.finished_at = datetime.now().astimezone()
            job.changed.set()
        return job.response()

    async def _worker(self) -> None:
        """Consume one job at a time; this is the GPU serialization boundary."""
        while True:
            job = await self.queue.get()
            try:
                if job.status == "cancelled":
                    continue
                await self._run(job)
            finally:
                self.queue.task_done()

    async def _run(self, job: Job) -> None:
        """Execute a child process and mirror merged stdout/stderr into the job.

        ``changed`` is an edge-triggered wakeup for SSE listeners. The complete
        snapshot remains in ``logs``, so clients can reconnect without losing
        output even when several lines arrive before they render.
        """
        job.status = "running"
        job.started_at = datetime.now().astimezone()
        job.changed.set()
        job.changed.clear()
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        try:
            # Uvicorn's Windows reload loop can use SelectorEventLoop, which does
            # not implement asyncio subprocess transports. Popen plus to_thread
            # works under both Windows loop policies while keeping HTTP non-blocking.
            job.process = subprocess.Popen(
                job.command,
                cwd=self.root,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
            assert job.process.stdout is not None
            while line := await asyncio.to_thread(job.process.stdout.readline):
                job.logs.append(line.rstrip())
                job.changed.set()
                job.changed.clear()
            job.return_code = await asyncio.to_thread(job.process.wait)
            if job.status != "cancelled":
                job.status = "completed" if job.return_code == 0 else "failed"
                if job.status == "failed":
                    job.error = f"Process exited with code {job.return_code}"
        except Exception as exc:
            job.status = "failed"
            # repr preserves exception types such as NotImplementedError whose
            # string representation is empty, making UI failures actionable.
            job.error = repr(exc)
            job.logs.append(f"ERROR: {exc!r}")
        finally:
            job.finished_at = datetime.now().astimezone()
            job.process = None
            job.changed.set()
