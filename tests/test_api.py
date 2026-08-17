from fastapi.testclient import TestClient

from api.main import app


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
