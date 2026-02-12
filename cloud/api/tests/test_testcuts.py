"""Tests for /api/calibration/testcuts/* endpoints."""

import pytest


# ── /api/calibration/testcuts/ids ────────────────────────────────────────────


class TestTestcutIds:
    def test_happy_path(self, client):
        resp = client.get("/api/calibration/testcuts/ids", params={"kiosk": "ns9999"})
        assert resp.status_code == 200
        ids = resp.json()
        assert isinstance(ids, list)
        assert len(ids) >= 2
        # ids come back as integers, sorted descending
        assert all(isinstance(i, int) for i in ids)
        assert ids == sorted(ids, reverse=True)
        assert 1 in ids
        assert 2 in ids

    def test_missing_kiosk(self, client):
        resp = client.get("/api/calibration/testcuts/ids")
        assert resp.status_code == 400
        assert "kiosk" in resp.json()["error"].lower()

    def test_empty_kiosk(self, client):
        resp = client.get("/api/calibration/testcuts/ids", params={"kiosk": ""})
        assert resp.status_code == 400


# ── /api/calibration/testcuts/images ─────────────────────────────────────────


class TestTestcutImages:
    def test_happy_path(self, client):
        resp = client.get(
            "/api/calibration/testcuts/images",
            params={"kiosk": "ns9999", "id": "1"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, dict)
        # should have sections from seeded data
        assert "01_PRE_PICKUP" in data
        assert "02_POST_PICKUP" in data
        # each section is a list of image dicts
        for section_name, images in data.items():
            assert isinstance(images, list)
            for img in images:
                assert "key" in img
                assert "filename" in img
                assert "url" in img
                assert isinstance(img["url"], str)
                assert img["url"].startswith("https://")

    def test_missing_kiosk(self, client):
        resp = client.get("/api/calibration/testcuts/images", params={"id": "1"})
        assert resp.status_code == 400

    def test_missing_id(self, client):
        resp = client.get("/api/calibration/testcuts/images", params={"kiosk": "ns9999"})
        assert resp.status_code == 400

    def test_non_integer_id(self, client):
        resp = client.get(
            "/api/calibration/testcuts/images",
            params={"kiosk": "ns9999", "id": "abc"},
        )
        assert resp.status_code == 400
        assert "integer" in resp.json()["error"].lower()

    def test_nonexistent_id_returns_empty(self, client):
        resp = client.get(
            "/api/calibration/testcuts/images",
            params={"kiosk": "ns9999", "id": "999999"},
        )
        assert resp.status_code == 200
        assert resp.json() == {}
