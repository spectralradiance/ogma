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
    process: asyncio.subprocess.Process | None = field(default=None, repr=False)
    changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def response(self) -> JobResponse:
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
    def __init__(self, root: Path) -> None:
        self.root = root
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self.worker: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self.worker is None:
            self.queue = asyncio.Queue()
            self.worker = asyncio.create_task(self._worker())

    async def stop(self) -> None:
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
        command = [sys.executable, *arguments]
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
        while True:
            job = await self.queue.get()
            try:
                if job.status == "cancelled":
                    continue
                await self._run(job)
            finally:
                self.queue.task_done()

    async def _run(self, job: Job) -> None:
        job.status = "running"
        job.started_at = datetime.now().astimezone()
        job.changed.set()
        job.changed.clear()
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        try:
            job.process = await asyncio.create_subprocess_exec(
                *job.command,
                cwd=self.root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                creationflags=creationflags,
            )
            assert job.process.stdout is not None
            while line := await job.process.stdout.readline():
                job.logs.append(line.decode(errors="replace").rstrip())
                job.changed.set()
                job.changed.clear()
            job.return_code = await job.process.wait()
            if job.status != "cancelled":
                job.status = "completed" if job.return_code == 0 else "failed"
                if job.status == "failed":
                    job.error = f"Process exited with code {job.return_code}"
        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
            job.logs.append(f"ERROR: {exc}")
        finally:
            job.finished_at = datetime.now().astimezone()
            job.process = None
            job.changed.set()
