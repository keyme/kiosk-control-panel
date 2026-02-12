"""Tests for GET /api/ping health-check endpoint."""


def test_ping_returns_ok(client):
    resp = client.get("/api/ping")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"status": "ok", "source": "cloud"}
