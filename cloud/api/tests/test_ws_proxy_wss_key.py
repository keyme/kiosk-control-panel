"""Tests for WSS API key: cloud in-memory cache and proxy behavior (header / close 4500)."""

import json
from unittest.mock import patch, MagicMock

import pytest

from control_panel.cloud.api.main import _get_wss_api_key, _wss_api_key
from control_panel.shared import WSS_SECRET_ID


def _reset_wss_key():
    """Reset module-level cache so _get_wss_api_key() will refetch from mock."""
    import control_panel.cloud.api.main as main_mod
    main_mod._wss_api_key = None


class TestGetWssApiKey:
    """_get_wss_api_key(): in-memory cache and Secrets Manager parsing."""

    def test_returns_plain_string_secret(self):
        _reset_wss_key()
        fake_key = "plain-secret-key-123"
        mock_response = {"SecretString": fake_key}
        with patch("control_panel.cloud.api.main.boto3") as mock_boto:
            mock_client = MagicMock()
            mock_client.get_secret_value.return_value = mock_response
            mock_boto.client.return_value = mock_client
            result = _get_wss_api_key()
        assert result == fake_key
        assert _get_wss_api_key() == fake_key  # cache hit

    def test_returns_json_wss_api_key_field(self):
        _reset_wss_key()
        fake_key = "json-key-456"
        mock_response = {"SecretString": json.dumps({"WSS_API_KEY": fake_key})}
        with patch("control_panel.cloud.api.main.boto3") as mock_boto:
            mock_client = MagicMock()
            mock_client.get_secret_value.return_value = mock_response
            mock_boto.client.return_value = mock_client
            result = _get_wss_api_key()
        assert result == fake_key

    def test_returns_json_api_key_field(self):
        _reset_wss_key()
        fake_key = "api-key-field"
        mock_response = {"SecretString": json.dumps({"api_key": fake_key})}
        with patch("control_panel.cloud.api.main.boto3") as mock_boto:
            mock_client = MagicMock()
            mock_client.get_secret_value.return_value = mock_response
            mock_boto.client.return_value = mock_client
            result = _get_wss_api_key()
        assert result == fake_key

    def test_returns_none_on_exception(self):
        _reset_wss_key()
        with patch("control_panel.cloud.api.main.boto3") as mock_boto:
            mock_client = MagicMock()
            mock_client.get_secret_value.side_effect = Exception("secret not found")
            mock_boto.client.return_value = mock_client
            result = _get_wss_api_key()
        assert result is None


class TestWsProxyWssKey:
    """ws_proxy: closes with 4500 when key missing; sends Authorization header when key present."""

    @pytest.fixture
    def client_with_ws_auth(self):
        """TestClient with validate_token mocked so /ws accepts the handshake."""
        from control_panel.cloud.api.auth import get_current_user
        from control_panel.cloud.api.main import app
        from starlette.testclient import TestClient

        app.dependency_overrides.pop(get_current_user, None)
        with patch("control_panel.cloud.api.main.validate_token"):
            with TestClient(app) as c:
                yield c
        from control_panel.cloud.api.main import app as app2
        app2.dependency_overrides[get_current_user] = lambda: {
            "granted": True,
            "permission": "check_kiosk_status",
        }

    def test_proxy_closes_4500_when_wss_key_missing(self, client_with_ws_auth):
        with patch("control_panel.cloud.api.main._get_wss_api_key", return_value=None):
            with client_with_ws_auth.websocket_connect(
                "/ws?device=ns9999&token=any"
            ) as ws:
                msg = ws.receive()
        assert msg.get("type") == "websocket.close"
        assert msg.get("code") == 4500
        assert "server config" in (msg.get("reason") or "")

    def test_proxy_sends_authorization_header_when_wss_key_present(self, client_with_ws_auth):
        connect_kwargs = {}

        class RaisingACM:
            """Async context manager that captures connect() kwargs and raises on enter."""

            def __init__(self, kwargs):
                self._kwargs = kwargs

            async def __aenter__(self):
                connect_kwargs.update(self._kwargs)
                raise OSError("connect refused for test")

            async def __aexit__(self, *a):
                return None

        def capture_connect(*args, **kwargs):
            return RaisingACM(kwargs)

        with patch("control_panel.cloud.api.main._get_wss_api_key", return_value="test-key-789"):
            with patch(
                "control_panel.cloud.api.main.websockets.connect",
                side_effect=capture_connect,
            ):
                try:
                    with client_with_ws_auth.websocket_connect(
                        "/ws?device=ns9999&token=any"
                    ) as ws:
                        while True:
                            msg = ws.receive()
                            if msg.get("type") == "websocket.close":
                                break
                except Exception:
                    pass
        assert connect_kwargs.get("additional_headers", {}).get("Authorization") == "Bearer test-key-789"
