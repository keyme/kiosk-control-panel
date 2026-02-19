"""Tests for GET /api/status probe endpoint (no auth, 200 when WSS key present, 503 when missing)."""

from unittest.mock import patch


def test_status_returns_200_when_wss_key_present(client):
    with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
        resp = client.get("/api/status")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_status_returns_503_when_wss_key_missing(client):
    with patch("control_panel.cloud.api.main._get_wss_api_key", return_value=None):
        resp = client.get("/api/status")
    assert resp.status_code == 503
    body = resp.json()
    assert body["status"] == "error"
    assert body["missing"] == "WSS API key"
