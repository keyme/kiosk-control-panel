"""Tests for all calibration endpoints (bitting + six run-based types).

Run-based types share the same /runs and /images endpoint shape, so they are
parametrised together.  Bitting is tested separately because it uses /dates
and a different parameter name.
"""

import pytest

from control_panel.cloud.api.tests.conftest import TS1

# ── Run-based calibrations (all use /runs + /images?run_id=) ─────────────────

RUN_CALIBRATIONS = [
    "bump_tower_calibration",
    "grip_calibration",
    "gripper_cam_calibration",
    "gripper_leds_check",
    "overhead_cam_calibration",
    "pickup_y_calibration",
]


@pytest.mark.parametrize("cal_type", RUN_CALIBRATIONS)
class TestRunCalibrationRuns:
    """GET /api/calibration/{cal_type}/runs"""

    def test_happy_path(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/runs",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 200
        runs = resp.json()
        assert isinstance(runs, list)
        assert len(runs) >= 1
        for run in runs:
            assert "run_id" in run
            assert "start_ts" in run
            assert "end_ts" in run

    def test_missing_kiosk(self, client, cal_type):
        resp = client.get(f"/api/calibration/{cal_type}/runs")
        assert resp.status_code == 400
        assert "kiosk" in resp.json()["error"].lower()

    def test_empty_kiosk(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/runs",
            params={"kiosk": ""},
        )
        assert resp.status_code == 400


@pytest.mark.parametrize("cal_type", RUN_CALIBRATIONS)
class TestRunCalibrationImages:
    """GET /api/calibration/{cal_type}/images"""

    def test_happy_path(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/images",
            params={"kiosk": "ns9999", "run_id": TS1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        # run timestamps present
        assert "run_start_ts" in data
        assert "run_end_ts" in data
        # at least one image section
        sections = {k: v for k, v in data.items() if isinstance(v, list)}
        assert len(sections) >= 1
        for images in sections.values():
            for img in images:
                assert "key" in img
                assert "filename" in img
                assert "url" in img
                assert isinstance(img["url"], str)

    def test_missing_kiosk(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/images",
            params={"run_id": TS1},
        )
        assert resp.status_code == 400

    def test_missing_run_id(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/images",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 400

    def test_nonexistent_run_id(self, client, cal_type):
        resp = client.get(
            f"/api/calibration/{cal_type}/images",
            params={"kiosk": "ns9999", "run_id": "1999-01-01-00-00-00-UTC"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # empty dict when the run doesn't exist
        assert data == {}


# ── Bitting calibration (unique: /dates + /images?date=) ────────────────────


class TestBittingDates:
    """GET /api/calibration/bitting_calibration/dates"""

    def test_happy_path(self, client):
        resp = client.get(
            "/api/calibration/bitting_calibration/dates",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 200
        dates = resp.json()
        assert isinstance(dates, list)
        assert len(dates) >= 2
        # newest first
        assert dates == sorted(dates, reverse=True)
        assert "2026-01-15" in dates
        assert "2026-01-10" in dates

    def test_missing_kiosk(self, client):
        resp = client.get("/api/calibration/bitting_calibration/dates")
        assert resp.status_code == 400


class TestBittingImages:
    """GET /api/calibration/bitting_calibration/images"""

    def test_happy_path(self, client):
        resp = client.get(
            "/api/calibration/bitting_calibration/images",
            params={"kiosk": "ns9999", "date": "2026-01-15"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        assert len(data) >= 1
        for section_name, images in data.items():
            assert isinstance(images, list)
            for img in images:
                assert "key" in img
                assert "filename" in img
                assert "url" in img

    def test_missing_kiosk(self, client):
        resp = client.get(
            "/api/calibration/bitting_calibration/images",
            params={"date": "2026-01-15"},
        )
        assert resp.status_code == 400

    def test_missing_date(self, client):
        resp = client.get(
            "/api/calibration/bitting_calibration/images",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 400

    def test_nonexistent_date(self, client):
        resp = client.get(
            "/api/calibration/bitting_calibration/images",
            params={"kiosk": "ns9999", "date": "1999-01-01"},
        )
        assert resp.status_code == 200
        assert resp.json() == {}
