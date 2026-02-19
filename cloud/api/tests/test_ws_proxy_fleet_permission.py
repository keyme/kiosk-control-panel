"""Tests for WebSocket proxy fleet command permission checks."""

import asyncio
import json
from unittest.mock import patch

import pytest

from control_panel.cloud.api.main import app
from control_panel.cloud.api.auth import get_current_user
from starlette.testclient import TestClient


class MockDeviceWs:
    """Fake device WebSocket: async send, async iterator that never yields."""

    def __init__(self):
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    def __aiter__(self):
        return self

    async def __anext__(self):
        await asyncio.Future()  # never completes
        raise StopAsyncIteration


class MockDeviceACM:
    """Async context manager that yields MockDeviceWs."""

    async def __aenter__(self):
        return MockDeviceWs()

    async def __aexit__(self, *a):
        return None


async def _mock_permission_denied(*a, **k):
    return (False, None)


async def _mock_permission_denied_with_user(*a, **k):
    return (False, "user@example.com")


async def _mock_permission_granted(*a, **k):
    return (True, None)


@pytest.fixture
def client_with_ws_auth():
    """TestClient with validate_token_async mocked so /ws accepts the handshake."""
    app.dependency_overrides.pop(get_current_user, None)
    with patch("control_panel.cloud.api.main.validate_token_async"):
        with TestClient(app) as c:
            yield c
    app.dependency_overrides[get_current_user] = lambda: {
        "granted": True,
        "permission": "check_kiosk_status",
    }


class TestWsProxyFleetPermissionDenied:
    """When validate_permission returns False, client gets specific error JSON."""

    def test_permission_denied_returns_specific_error_without_user(self, client_with_ws_auth):
        with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
            with patch(
                "control_panel.cloud.api.main.websockets.connect",
                return_value=MockDeviceACM(),
            ):
                with patch(
                    "control_panel.cloud.api.main.validate_permission_async",
                    side_effect=_mock_permission_denied,
                ):
                    with client_with_ws_auth.websocket_connect(
                        "/ws?device=ns9999&token=any"
                    ) as ws:
                        ws.send_text(json.dumps({
                            "id": "req-1",
                            "event": "fleet_reboot_kiosk",
                            "data": {},
                        }))
                        msg = ws.receive()
        assert msg.get("type") == "websocket.send"
        text = msg.get("text", "")
        data = json.loads(text)
        assert data.get("success") is False
        assert data.get("id") == "req-1"
        errors = data.get("errors", [])
        assert len(errors) == 1
        assert "reboot_kiosk" in errors[0]
        assert "Permission denied" in errors[0]
        assert "'reboot_kiosk'" in errors[0] or "reboot_kiosk" in errors[0]

    def test_permission_denied_includes_user_when_available(self, client_with_ws_auth):
        with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
            with patch(
                "control_panel.cloud.api.main.websockets.connect",
                return_value=MockDeviceACM(),
            ):
                with patch(
                    "control_panel.cloud.api.main.validate_permission_async",
                    side_effect=_mock_permission_denied_with_user,
                ):
                    with client_with_ws_auth.websocket_connect(
                        "/ws?device=ns9999&token=any"
                    ) as ws:
                        ws.send_text(json.dumps({
                            "id": "req-2",
                            "event": "fleet_reboot_kiosk",
                            "data": {},
                        }))
                        msg = ws.receive()
        assert msg.get("type") == "websocket.send"
        data = json.loads(msg.get("text", "{}"))
        assert data.get("success") is False
        errors = data.get("errors", [])
        assert len(errors) == 1
        assert "user@example.com" in errors[0]
        assert "reboot_kiosk" in errors[0]


class TestWsProxyFleetPermissionGranted:
    """When validate_permission returns True, message is forwarded to device."""

    def test_message_forwarded_when_permission_granted(self, client_with_ws_auth):
        captured_ws = []

        class CapturingACM:
            async def __aenter__(self):
                w = MockDeviceWs()
                captured_ws.append(w)
                return w

            async def __aexit__(self, *a):
                return None

        with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
            with patch(
                "control_panel.cloud.api.main.websockets.connect",
                return_value=CapturingACM(),
            ):
                with patch(
                    "control_panel.cloud.api.main.validate_permission_async",
                    side_effect=_mock_permission_granted,
                ):
                    with client_with_ws_auth.websocket_connect(
                        "/ws?device=ns9999&token=any"
                    ) as ws:
                        payload = {
                            "id": "req-3",
                            "event": "fleet_reboot_kiosk",
                            "data": {},
                        }
                        ws.send_text(json.dumps(payload))
                        import time
                        time.sleep(0.2)
        assert len(captured_ws) == 1
        assert len(captured_ws[0].sent) == 1
        forwarded = json.loads(captured_ws[0].sent[0])
        assert forwarded.get("event") == "fleet_reboot_kiosk"
        assert forwarded.get("id") == "req-3"
