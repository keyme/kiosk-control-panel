"""Tests for GET /health WebSocket-proxy health endpoint."""


def test_health_response_shape(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()

    assert body["status"] in ("ok", "warning")
    assert set(body.keys()) == {"status", "limits", "usage", "warnings"}

    limits = body["limits"]
    usage = body["usage"]
    warnings = body["warnings"]

    assert set(limits.keys()) == {
        "ulimit_n",
        "fs_file_max",
        "nf_conntrack_max",
        "memory_limit_bytes",
    }
    assert set(usage.keys()) == {
        "current_open_fds",
        "memory_usage_bytes",
        "active_websocket_connections",
    }

    # In the unit test suite we never establish real WS proxy connections.
    assert usage["active_websocket_connections"] == 0

    assert isinstance(warnings, list)
    for w in warnings:
        assert set(w.keys()) == {"message", "recommendation"}
        assert isinstance(w["message"], str)
        assert isinstance(w["recommendation"], str)

