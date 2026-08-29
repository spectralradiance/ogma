import asyncio
from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient

import api.main as api_main
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
            "Evocation": 5,
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
    from api.main import DEFAULT_CLAUDE_MODEL, DEFAULT_EXTRACT_MODEL, DEFAULT_WRITE_MODEL
    from api.main import generation_provider
    from api.schemas import ManuscriptRequest, OutlineRequest

    assert DEFAULT_EXTRACT_MODEL == "Qwen/Qwen2.5-7B-Instruct"
    assert DEFAULT_WRITE_MODEL == "Qwen/Qwen2.5-7B-Instruct"
    assert DEFAULT_CLAUDE_MODEL == "claude-opus-5"
    assert generation_provider(OutlineRequest(system="Invocation")) == "local"
    assert generation_provider(ManuscriptRequest(system="Invocation", provider="claude")) == "claude"
    assert generation_provider(
        ManuscriptRequest(system="Invocation", extract_model_name="claude-opus-5")
    ) == "claude"


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


def test_organize_chaos_status_and_submission_reuses_active_job() -> None:
    with TestClient(app) as client:
        status = client.get("/api/organize-chaos/status")
        assert status.status_code == 200
        body = status.json()
        assert isinstance(body["unsorted_files"], int)
        assert isinstance(body["imported_files"], int)

    active = Job(
        id="existing-organize-chaos",
        kind="organize_chaos",
        command=[],
        created_at=datetime.now().astimezone(),
        status="running",
    )
    manager.jobs[active.id] = active
    try:
        with TestClient(app) as client:
            response = client.post("/api/organize-chaos", json={"dry_run": True})
        assert response.status_code == 202
        assert response.json()["id"] == active.id
    finally:
        manager.jobs.pop(active.id, None)


def test_concepts_artifact_missing_and_submission_reuses_active_job() -> None:
    with TestClient(app) as client:
        no_run = client.get("/api/concepts")
        assert no_run.status_code == 422
        missing = client.get("/api/concepts", params={"run_id": "generated202601010000"})
        assert missing.status_code == 404

    active = Job(
        id="existing-concepts",
        kind="concepts",
        command=[],
        created_at=datetime.now().astimezone(),
        status="running",
    )
    manager.jobs[active.id] = active
    try:
        with TestClient(app) as client:
            response = client.post("/api/concepts", json={"target_count": 50})
        assert response.status_code == 202
        assert response.json()["id"] == active.id
    finally:
        manager.jobs.pop(active.id, None)


def test_chat_session_lifecycle() -> None:
    with TestClient(app) as client:
        empty = client.get("/api/chat/regression-test-session")
        assert empty.status_code == 200
        assert empty.json()["messages"] == []

        cleared = client.delete("/api/chat/regression-test-session")
        assert cleared.status_code == 200

        invalid = client.get("/api/chat/bad.session.id")
        assert invalid.status_code == 422


def test_chat_submission_reuses_active_job_for_same_session() -> None:
    active = Job(
        id="existing-chat",
        kind="chat",
        command=[],
        created_at=datetime.now().astimezone(),
        status="running",
        system="session-a",
    )
    manager.jobs[active.id] = active
    try:
        with TestClient(app) as client:
            same_session = client.post("/api/chat", json={"session_id": "session-a", "message": "hi"})
            assert same_session.status_code == 202
            assert same_session.json()["id"] == active.id
    finally:
        manager.jobs.pop(active.id, None)


def test_pipeline_run_can_be_created_and_listed() -> None:
    with TestClient(app) as client:
        created = client.post("/api/pipeline-runs")
        assert created.status_code == 201
        body = created.json()
        assert body["run_id"].startswith("generated")
        assert isinstance(body["steps"], list)
        assert {step["step"] for step in body["steps"]} >= {"organize_chaos", "index", "analysis", "concepts"}

        listed = client.get("/api/pipeline-runs")
        assert listed.status_code == 200
        assert isinstance(listed.json(), list)


def test_model_catalog_lists_builtins_and_supports_custom_additions(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(api_main, "INTERMEDIARY_DIR", tmp_path)
    with TestClient(app) as client:
        builtin = client.get("/api/models")
        assert builtin.status_code == 200
        values = {entry["value"] for entry in builtin.json()}
        assert "Qwen/Qwen2.5-7B-Instruct" in values
        assert "BAAI/bge-large-en-v1.5" in values
        assert all(entry["builtin"] for entry in builtin.json())

        added = client.post("/api/models", json={
            "value": "intfloat/e5-large-v2", "label": "E5 large", "kind": "embedding", "provider": "local",
        })
        assert added.status_code == 201
        custom_entry = next(entry for entry in added.json() if entry["value"] == "intfloat/e5-large-v2")
        assert custom_entry["builtin"] is False
        assert custom_entry["downloaded"] is False

        duplicate = client.post("/api/models", json={
            "value": "intfloat/e5-large-v2", "label": "dup", "kind": "embedding", "provider": "local",
        })
        assert duplicate.status_code == 409

        builtin_conflict = client.post("/api/models", json={
            "value": "BAAI/bge-large-en-v1.5", "label": "dup", "kind": "embedding", "provider": "local",
        })
        assert builtin_conflict.status_code == 409

        removed = client.delete("/api/models/intfloat%2Fe5-large-v2")
        assert removed.status_code == 200
        assert "intfloat/e5-large-v2" not in {entry["value"] for entry in removed.json()}

        cannot_remove_builtin = client.delete("/api/models/BAAI%2Fbge-large-en-v1.5")
        assert cannot_remove_builtin.status_code == 409


def test_download_model_rejects_unknown_and_claude_models(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(api_main, "INTERMEDIARY_DIR", tmp_path)
    with TestClient(app) as client:
        unknown = client.post("/api/models/download", json={"value": "not/a-real-model"})
        assert unknown.status_code == 404

        claude_model = client.post("/api/models/download", json={"value": "claude-opus-5"})
        assert claude_model.status_code == 422


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
