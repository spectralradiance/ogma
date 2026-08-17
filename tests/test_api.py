import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import app
from api.jobs import JobManager
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
