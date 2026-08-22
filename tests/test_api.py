import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import app, manager
from api.jobs import Job, JobManager
from api.schemas import AnalysisRequest


def test_health_and_systems() -> None:
    with TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        response = client.get("/api/systems")
        assert response.status_code == 200
        systems = {item["name"]: item["sections"] for item in response.json()}
        assert systems == {
            "Universal Metaphysics": 100,
            "Tree of Life": 37,
            "Invocation": 10,
        }


def test_index_status_and_runs_are_readable() -> None:
    with TestClient(app) as client:
        index = client.get("/api/index/status")
        assert index.status_code == 200
        assert index.json()["available"] is True
        runs = client.get("/api/runs")
        assert runs.status_code == 200
        assert isinstance(runs.json(), list)


def test_unknown_system_is_rejected() -> None:
    with TestClient(app) as client:
        response = client.get("/api/outlines/Unknown/caches")
        assert response.status_code == 422


def test_generation_requests_default_to_split_extract_and_write_models() -> None:
    from api.main import DEFAULT_EXTRACT_MODEL, DEFAULT_WRITE_MODEL

    assert DEFAULT_EXTRACT_MODEL == "Qwen/Qwen3-14B"
    assert DEFAULT_WRITE_MODEL == "nbeerbower/Vitus-Qwen3-14B"


def test_workspace_lists_reads_and_rejects_unsafe_paths(tmp_path: Path) -> None:
    import api.main as api_main

    root = tmp_path / "writing-desktop"
    root.mkdir()
    note = root / "note.md"
    note.write_text("Original text", encoding="utf-8")
    original_roots = api_main.WORKSPACE_ROOTS
    api_main.WORKSPACE_ROOTS = {"writing-desktop": root}
    try:
        with TestClient(app) as client:
            files = client.get("/api/workspace/files")
            assert files.status_code == 200
            assert files.json()[0]["path"] == "writing-desktop/note.md"

            document = client.get(
                "/api/workspace/file", params={"path": "writing-desktop/note.md"}
            )
            assert document.json()["content"] == "Original text"

            saved = client.put(
                "/api/workspace/file",
                json={"path": "writing-desktop/note.md", "content": "Updated text"},
            )
            assert saved.status_code == 200
            assert note.read_text(encoding="utf-8") == "Updated text"

            assert client.get(
                "/api/workspace/file", params={"path": "writing-desktop/../secret.md"}
            ).status_code == 422
            assert client.get(
                "/api/workspace/file", params={"path": "writing-desktop/image.png"}
            ).status_code == 422
    finally:
        api_main.WORKSPACE_ROOTS = original_roots


def test_analysis_endpoints_validate_without_running_models() -> None:
    assert "max_documents" not in AnalysisRequest.model_fields
    with TestClient(app) as client:
        analyses = client.get("/api/analyses")
        assert analyses.status_code == 200
        assert isinstance(analyses.json(), list)
        invalid = client.post(
            "/api/analyses",
            json={"source": "Z:/path/that/does/not/exist"},
        )
        assert invalid.status_code == 422


def test_job_manager_streams_subprocess_output() -> None:
    async def scenario() -> None:
        manager = JobManager(Path.cwd())
        await manager.start()
        response = await manager.submit("analysis", ["-c", "print('worker-ready')"])
        for _ in range(100):
            job = manager.get(response.id)
            assert job is not None
            if job.status in {"completed", "failed"}:
                break
            await asyncio.sleep(0.02)
        assert job.status == "completed"
        assert job.logs == ["worker-ready"]
        await manager.stop()

    asyncio.run(scenario())


def test_active_job_prefers_running_over_queued() -> None:
    manager = JobManager(Path.cwd())
    now = datetime.now().astimezone()
    queued = Job(id="queued", kind="analysis", command=[], created_at=now)
    running = Job(
        id="running",
        kind="analysis",
        command=[],
        created_at=now + timedelta(seconds=1),
        status="running",
    )
    manager.jobs = {queued.id: queued, running.id: running}

    assert manager.active("analysis") is running


def test_analysis_submission_reuses_active_job() -> None:
    active = Job(
        id="existing-analysis",
        kind="analysis",
        command=[],
        created_at=datetime.now().astimezone(),
        status="running",
        run_id="generated-existing",
    )
    manager.jobs[active.id] = active
    try:
        with TestClient(app) as client:
            response = client.post("/api/analyses", json={})
        assert response.status_code == 202
        assert response.json()["id"] == active.id
        assert response.json()["run_id"] == active.run_id
    finally:
        manager.jobs.pop(active.id, None)
