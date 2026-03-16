"""Tests for GET /api/calibration/ejection_images."""

import pytest


class TestEjectionImages:
    """GET /api/calibration/ejection_images"""

    def test_missing_kiosk(self, client):
        resp = client.get("/api/calibration/ejection_images")
        assert resp.status_code == 400
        assert "kiosk" in resp.json()["error"].lower()

    def test_empty_kiosk(self, client):
        resp = client.get("/api/calibration/ejection_images", params={"kiosk": ""})
        assert resp.status_code == 400
        assert "kiosk" in resp.json()["error"].lower()

    def test_happy_path_response_shape(self, client):
        resp = client.get(
            "/api/calibration/ejection_images",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        # Keys are magazine numbers as strings; values have id and image
        for mag_key, entry in data.items():
            assert mag_key.isdigit()
            assert "id" in entry
            assert "image" in entry
            img = entry["image"]
            assert "key" in img
            assert "filename" in img
            assert "url" in img
            assert isinstance(img["url"], str)
            assert img["url"].startswith("https://")

    def test_happy_path_returns_at_least_one_magazine(self, client):
        resp = client.get(
            "/api/calibration/ejection_images",
            params={"kiosk": "ns9999"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) >= 1
        # Seed data has key_head_check for mag 1 (and 2 when both ids scanned)
        assert "1" in data

    def test_max_ids_limiting(self, client):
        # Seed: id 2 has mag 1 only; id 1 has mag 1 and 2. IDs are scanned [2, 1].
        # max_ids=1 -> only scan id 2 -> at most mag 1
        resp1 = client.get(
            "/api/calibration/ejection_images",
            params={"kiosk": "ns9999", "max_ids": 1},
        )
        assert resp1.status_code == 200
        data1 = resp1.json()
        assert set(data1.keys()) <= {"1"}

        # max_ids=2 -> scan id 2 and 1 -> mag 1 and 2
        resp2 = client.get(
            "/api/calibration/ejection_images",
            params={"kiosk": "ns9999", "max_ids": 2},
        )
        assert resp2.status_code == 200
        data2 = resp2.json()
        assert "1" in data2
        assert "2" in data2
