"""Tests for WebSocket proxy staging gate: stg cannot connect to deployed kiosk."""

import asyncio
import json
from unittest.mock import patch

import pytest

from control_panel.cloud.api.main import STG_DEPLOYED_CLOSE_CODE, app
from control_panel.cloud.api.auth import get_current_user
from starlette.testclient import TestClient


def _hello_message():
    return json.dumps({"event": "hello", "data": {"connected": True, "service": "CONTROL_PANEL", "kiosk_name": "ns9999"}})


def _panel_info_response(deployed: bool):
    return json.dumps({
        "id": 0,
        "success": True,
        "data": {
            "activity": "inactive",
            "kiosk_status": "ALL_SYSTEMS_GO",
            "deployed": deployed,
            "banner": "",
            "store_address": "",
        },
    })


class MockDeviceWsWithRecv:
    """Fake device WebSocket: recv() returns from a queue; async iterator yields iter_messages then blocks."""

    def __init__(self, recv_messages, iter_messages=None):
        self.recv_messages = list(recv_messages)
        self.recv_index = 0
        self.sent = []
        self._iter_messages = list(iter_messages) if iter_messages is not None else []
        self._iter_index = 0

    async def send(self, data):
        self.sent.append(data)

    async def recv(self):
        if self.recv_index < len(self.recv_messages):
            msg = self.recv_messages[self.recv_index]
            self.recv_index += 1
            return msg
        await asyncio.Future()  # block forever

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._iter_index < len(self._iter_messages):
            msg = self._iter_messages[self._iter_index]
            self._iter_index += 1
            return msg
        await asyncio.Future()  # block forever
        raise StopAsyncIteration


class MockDeviceACM:
    """Async context manager that yields a device WS with given recv and optional iter messages."""

    def __init__(self, recv_messages, iter_messages=None):
        self.recv_messages = recv_messages
        self.iter_messages = iter_messages

    async def __aenter__(self):
        return MockDeviceWsWithRecv(self.recv_messages, self.iter_messages)

    async def __aexit__(self, *a):
        return None


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


class TestStgDeployedGate:
    """Staging must not connect to deployed kiosks; prod and non-deployed are allowed."""

    def test_stg_deployed_true_closes_4403(self, client_with_ws_auth):
        """When API_ENV is stg and kiosk returns deployed true, client gets close 4403."""
        recv_messages = [_hello_message(), _panel_info_response(deployed=True)]
        with patch("control_panel.cloud.api.main.API_ENV", "stg"):
            with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
                with patch(
                    "control_panel.cloud.api.main.websockets.connect",
                    return_value=MockDeviceACM(recv_messages),
                ):
                    with client_with_ws_auth.websocket_connect("/ws?device=ns9999&token=any") as ws:
                        # Drain until close (gate may run in different order in threaded test client)
                        while True:
                            msg = ws.receive()
                            if msg.get("type") == "websocket.close":
                                break
                            if msg.get("type") != "websocket.send":
                                break
                        assert msg.get("type") == "websocket.close", f"Expected close, got {msg}"
        assert msg.get("code") == STG_DEPLOYED_CLOSE_CODE
        assert "Staging" in (msg.get("reason") or "")
        assert "deployed" in (msg.get("reason") or "").lower()

    def test_stg_deployed_false_allows_connection(self, client_with_ws_auth):
        """When API_ENV is stg and kiosk returns deployed false, proxy runs and forwards messages."""
        recv_messages = [_hello_message(), _panel_info_response(deployed=False)]
        with patch("control_panel.cloud.api.main.API_ENV", "stg"):
            with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
                with patch(
                    "control_panel.cloud.api.main.websockets.connect",
                    return_value=MockDeviceACM(recv_messages),
                ):
                    with client_with_ws_auth.websocket_connect("/ws?device=ns9999&token=any") as ws:
                        # Should receive buffered hello and panel_info, then connection stays open until we close
                        first = ws.receive()
                        second = ws.receive()
        # Both should be websocket.send (forwarded from device), not websocket.close with 4403
        assert first.get("type") == "websocket.send"
        assert second.get("type") == "websocket.send"
        data1 = json.loads(first.get("text", "{}"))
        data2 = json.loads(second.get("text", "{}"))
        assert data1.get("event") == "hello"
        assert data2.get("id") == 0 and data2.get("data", {}).get("deployed") is False

    def test_prod_deployed_true_allows_connection(self, client_with_ws_auth):
        """When API_ENV is prod and kiosk returns deployed true, proxy runs (no 4403)."""
        messages = [_hello_message(), _panel_info_response(deployed=True)]
        # In prod the gate does not run; device_to_client reads from the iterator.
        with patch("control_panel.cloud.api.main.API_ENV", "prod"):
            with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="wss-key"):
                with patch(
                    "control_panel.cloud.api.main.websockets.connect",
                    return_value=MockDeviceACM(recv_messages=[], iter_messages=messages),
                ):
                    with client_with_ws_auth.websocket_connect("/ws?device=ns9999&token=any") as ws:
                        first = ws.receive()
                        second = ws.receive()
        assert first.get("type") == "websocket.send"
        assert second.get("type") == "websocket.send"
        assert json.loads(second.get("text", "{}")).get("data", {}).get("deployed") is True
