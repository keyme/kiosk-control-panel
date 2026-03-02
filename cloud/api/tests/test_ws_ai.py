"""Tests for /ai WebSocket: auth, ai_get_identifiers, ai_log_session, ai_turn."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient

from control_panel.cloud.api.auth import get_current_user
from control_panel.cloud.api.main import app


def _auth_override():
    app.dependency_overrides[get_current_user] = lambda: {
        "granted": True,
        "permission": "check_kiosk_status",
    }


@pytest.fixture
def client_ai_ws():
    """TestClient with validate_token_async mocked so /ai accepts the handshake."""
    with patch("control_panel.cloud.api.main.validate_token_async", new_callable=AsyncMock):
        with TestClient(app) as c:
            yield c


class TestWsAiAuth:
    """Auth: first message must be { event: 'auth', token }. Missing or invalid token closes with 4401."""

    def test_missing_token_closes_4401(self):
        app.dependency_overrides.pop(get_current_user, None)
        try:
            with TestClient(app) as c:
                with c.websocket_connect("/ai") as ws:
                    ws.send_text(json.dumps({"event": "auth", "token": ""}))
                    msg = ws.receive()
                assert msg.get("type") == "websocket.close"
                assert msg.get("code") == 4401
                assert "missing" in (msg.get("reason") or "").lower()
        finally:
            _auth_override()

    def test_invalid_token_closes_4401(self):
        app.dependency_overrides.pop(get_current_user, None)
        try:
            with patch("control_panel.cloud.api.main.validate_token_async", new_callable=AsyncMock) as m:
                m.side_effect = HTTPException(status_code=401, detail="invalid token")
                with TestClient(app) as c:
                    with c.websocket_connect("/ai") as ws:
                        ws.send_text(json.dumps({"event": "auth", "token": "bad"}))
                        msg = ws.receive()
                assert msg.get("type") == "websocket.close"
                assert msg.get("code") == 4401
                assert "invalid" in (msg.get("reason") or "").lower()
        finally:
            _auth_override()


class TestWsAiGetIdentifiers:
    """ai_get_identifiers: success returns identifiers; extract failure returns error."""

    def test_success_returns_identifiers(self, client_ai_ws):
        with patch("control_panel.cloud.api.main.log_analysis.get_empty_workspace", return_value="/tmp/empty"):
            with patch(
                "control_panel.cloud.api.main.log_analysis.extract_identifiers_json",
                return_value={"success": True, "identifiers": ["uuid-123", "2025-12-28T14"], "error_message": None},
            ):
                with patch("control_panel.cloud.api.main.asyncio.to_thread", new_callable=AsyncMock) as to_thread:
                    to_thread.return_value = {"success": True, "identifiers": ["uuid-123", "2025-12-28T14"], "error_message": None}
                    with client_ai_ws.websocket_connect("/ai") as ws:
                        ws.send_text(json.dumps({"event": "auth", "token": "ok"}))
                        assert json.loads(ws.receive_text()).get("event") == "auth_ok"
                        ws.send_text(json.dumps({"id": 1, "event": "ai_get_identifiers", "data": {"question": "session uuid-123 at 2 PM"}}))
                        raw = ws.receive_text()
                        msg = json.loads(raw)
                        assert msg.get("id") == 1
                        assert msg.get("success") is True
                        assert msg.get("result", {}).get("identifiers") == ["uuid-123", "2025-12-28T14"]

    def test_missing_question_returns_error(self, client_ai_ws):
        with client_ai_ws.websocket_connect("/ai") as ws:
            ws.send_text(json.dumps({"event": "auth", "token": "ok"}))
            assert json.loads(ws.receive_text()).get("event") == "auth_ok"
            ws.send_text(json.dumps({"id": 2, "event": "ai_get_identifiers", "data": {}}))
            raw = ws.receive_text()
            msg = json.loads(raw)
            assert msg.get("id") == 2
            assert msg.get("success") is False
            assert "question" in (msg.get("error") or "").lower()

    def test_extract_failure_returns_error(self, client_ai_ws):
        with patch("control_panel.cloud.api.main.log_analysis.get_empty_workspace", return_value="/tmp/empty"):
            with patch("control_panel.cloud.api.main.asyncio.to_thread", new_callable=AsyncMock) as to_thread:
                to_thread.return_value = {"success": False, "identifiers": [], "error_message": "Your question must include..."}
                with client_ai_ws.websocket_connect("/ai") as ws:
                    ws.send_text(json.dumps({"event": "auth", "token": "ok"}))
                    assert json.loads(ws.receive_text()).get("event") == "auth_ok"
                    ws.send_text(json.dumps({"id": 3, "event": "ai_get_identifiers", "data": {"question": "nothing useful"}}))
                    raw = ws.receive_text()
                    msg = json.loads(raw)
                    assert msg.get("id") == 3
                    assert msg.get("success") is False
                    assert "error" in msg


class TestWsAiTurn:
    """ai_turn: unknown thread_id returns error; valid thread_id requires prior ai_log_session."""

    def test_unknown_thread_id_returns_error(self, client_ai_ws):
        with client_ai_ws.websocket_connect("/ai") as ws:
            ws.send_text(json.dumps({"event": "auth", "token": "ok"}))
            assert json.loads(ws.receive_text()).get("event") == "auth_ok"
            ws.send_text(json.dumps({"id": 10, "event": "ai_turn", "data": {"thread_id": "thr_unknown", "text": "hello"}}))
            raw = ws.receive_text()
            msg = json.loads(raw)
            assert msg.get("id") == 10
            assert msg.get("success") is False
            assert "thread" in (msg.get("error") or "").lower() or "unknown" in (msg.get("error") or "").lower()

    def test_missing_thread_id_returns_error(self, client_ai_ws):
        with client_ai_ws.websocket_connect("/ai") as ws:
            ws.send_text(json.dumps({"event": "auth", "token": "ok"}))
            assert json.loads(ws.receive_text()).get("event") == "auth_ok"
            ws.send_text(json.dumps({"id": 11, "event": "ai_turn", "data": {"text": "hello"}}))
            raw = ws.receive_text()
            msg = json.loads(raw)
            assert msg.get("id") == 11
            assert msg.get("success") is False
