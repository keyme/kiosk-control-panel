"""Tests for /api/calibration/trace/gripper_cam/* endpoints."""

from control_panel.cloud.api.tests.conftest import TS1


# ── /api/calibration/trace/gripper_cam/runs ──────────────────────────────────


class TestTraceRuns:
    def test_happy_path(self, client):
        resp = client.get(
            "/api/calibration/trace/gripper_cam/runs",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 200
        runs = resp.json()
        assert isinstance(runs, list)
        assert len(runs) >= 1
        for run in runs:
            assert "run_id" in run
        run_ids = [r["run_id"] for r in runs]
        assert TS1 in run_ids

    def test_missing_kiosk(self, client):
        resp = client.get("/api/calibration/trace/gripper_cam/runs")
        assert resp.status_code == 400


# ── /api/calibration/trace/gripper_cam (get trace JSON) ─────────────────────


class TestTraceGet:
    def test_happy_path(self, client):
        resp = client.get(
            "/api/calibration/trace/gripper_cam",
            params={"kiosk": "ns9999", "run_id": TS1},
        )
        assert resp.status_code == 200
        trace = resp.json()
        assert isinstance(trace, dict)
        assert "steps" in trace
        assert isinstance(trace["steps"], list)
        # artifacts should have presigned url injected
        for step in trace["steps"]:
            for artifact in step.get("artifacts", []):
                assert "url" in artifact
                assert isinstance(artifact["url"], str)

    def test_missing_kiosk(self, client):
        resp = client.get(
            "/api/calibration/trace/gripper_cam",
            params={"run_id": TS1},
        )
        assert resp.status_code == 400

    def test_missing_run_id(self, client):
        resp = client.get(
            "/api/calibration/trace/gripper_cam",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 400

    def test_nonexistent_run_id(self, client):
        resp = client.get(
            "/api/calibration/trace/gripper_cam",
            params={"kiosk": "ns9999", "run_id": "1999-01-01-00-00-00-UTC"},
        )
        assert resp.status_code == 404
        assert "not found" in resp.json()["error"].lower()


# ── /api/calibration/trace/gripper_cam/dewarp ────────────────────────────────


class TestTraceDewarp:
    def test_missing_image_url(self, client):
        resp = client.post(
            "/api/calibration/trace/gripper_cam/dewarp",
            json={"homography": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]},
        )
        assert resp.status_code == 400
        assert "image_url" in resp.json()["error"].lower()

    def test_missing_homography(self, client):
        resp = client.post(
            "/api/calibration/trace/gripper_cam/dewarp",
            json={"image_url": "https://example.com/img.png"},
        )
        assert resp.status_code == 400
        assert "homography" in resp.json()["error"].lower()

    def test_invalid_homography_shape(self, client):
        resp = client.post(
            "/api/calibration/trace/gripper_cam/dewarp",
            json={
                "image_url": "https://example.com/img.png",
                "homography": [[1, 0], [0, 1]],
            },
        )
        assert resp.status_code == 400
        assert "homography" in resp.json()["error"].lower()
