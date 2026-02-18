"""Tests for KeyMe/ANF opaque-token authentication."""

from unittest.mock import patch, MagicMock

import pytest
from starlette.testclient import TestClient


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_raw_client():
    """Return a TestClient *without* the auth dependency override so real
    auth logic runs."""
    from control_panel.cloud.api.auth import get_current_user, _token_cache
    from control_panel.cloud.api.main import app

    # Remove any override that conftest may have set
    app.dependency_overrides.pop(get_current_user, None)
    _token_cache.clear()
    client = TestClient(app, raise_server_exceptions=False)
    return client, app, get_current_user, _token_cache


def _restore_override(app, get_current_user):
    """Re-install the fake override so other session-scoped tests still pass."""
    app.dependency_overrides[get_current_user] = lambda: {
        "granted": True,
        "permission": "check_kiosk_status",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMissingToken:
    def test_no_header_returns_401(self):
        client, app, dep, _cache = _make_raw_client()
        try:
            resp = client.get("/api/ping")
            assert resp.status_code == 401
            assert "Missing KEYME-TOKEN" in resp.json()["detail"]
        finally:
            _restore_override(app, dep)


class TestInvalidToken:
    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_anf_non_200_returns_401(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_get.return_value = mock_resp

        client, app, dep, _cache = _make_raw_client()
        try:
            resp = client.get("/api/ping", headers={"KEYME-TOKEN": "bad-token"})
            assert resp.status_code == 401
        finally:
            _restore_override(app, dep)

    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_granted_false_returns_401(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": False, "permission": "check_kiosk_status"}
        mock_get.return_value = mock_resp

        client, app, dep, _cache = _make_raw_client()
        try:
            resp = client.get("/api/ping", headers={"KEYME-TOKEN": "no-perms-token"})
            assert resp.status_code == 401
            assert "Access denied" in resp.json()["detail"]
        finally:
            _restore_override(app, dep)


class TestValidToken:
    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_granted_true_allows_request(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": True, "permission": "check_kiosk_status"}
        mock_get.return_value = mock_resp

        client, app, dep, _cache = _make_raw_client()
        try:
            resp = client.get("/api/ping", headers={"KEYME-TOKEN": "good-token"})
            assert resp.status_code == 200
            assert resp.json()["status"] == "ok"
        finally:
            _restore_override(app, dep)


class TestTokenCaching:
    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_second_call_uses_cache(self, mock_get):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": True, "permission": "check_kiosk_status"}
        mock_get.return_value = mock_resp

        client, app, dep, _cache = _make_raw_client()
        try:
            # First call — hits ANF
            resp1 = client.get("/api/ping", headers={"KEYME-TOKEN": "cached-token"})
            assert resp1.status_code == 200
            assert mock_get.call_count == 1

            # Second call — should use cache, no additional ANF call
            resp2 = client.get("/api/ping", headers={"KEYME-TOKEN": "cached-token"})
            assert resp2.status_code == 200
            assert mock_get.call_count == 1  # still 1
        finally:
            _restore_override(app, dep)


class TestValidatePermission:
    """validate_permission(token, permission_slug) for fleet commands."""

    def _clear_permission_cache(self):
        from control_panel.cloud.api.auth import _permission_cache
        _permission_cache.clear()

    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_granted_true_returns_true_and_user_id(self, mock_get):
        self._clear_permission_cache()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": True, "email": "u@example.com"}
        mock_get.return_value = mock_resp

        from control_panel.cloud.api.auth import validate_permission
        granted, user_id = validate_permission("tok", "reboot_kiosk")
        assert granted is True
        assert user_id == "u@example.com"
        assert mock_get.call_count == 1

    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_granted_false_returns_false(self, mock_get):
        self._clear_permission_cache()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": False}
        mock_get.return_value = mock_resp

        from control_panel.cloud.api.auth import validate_permission
        granted, user_id = validate_permission("tok", "reboot_kiosk")
        assert granted is False
        assert user_id is None

    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_cache_prevents_second_anf_call(self, mock_get):
        self._clear_permission_cache()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"granted": True}
        mock_get.return_value = mock_resp

        from control_panel.cloud.api.auth import validate_permission
        validate_permission("cache-token", "clear_cutter_stuck")
        validate_permission("cache-token", "clear_cutter_stuck")
        assert mock_get.call_count == 1

    def test_empty_token_returns_false_none(self):
        from control_panel.cloud.api.auth import validate_permission
        granted, user_id = validate_permission(None, "reboot_kiosk")
        assert granted is False
        assert user_id is None

    @patch("control_panel.cloud.api.auth.httpx.get")
    def test_non_200_returns_false_none(self, mock_get):
        self._clear_permission_cache()
        mock_resp = MagicMock()
        mock_resp.status_code = 403
        mock_get.return_value = mock_resp

        from control_panel.cloud.api.auth import validate_permission
        granted, user_id = validate_permission("tok", "reboot_kiosk")
        assert granted is False
        assert user_id is None


class TestApiEnvValidation:
    def test_invalid_env_raises_runtime_error(self):
        """Importing auth with an invalid API_ENV must raise RuntimeError."""
        import importlib
        import os

        old = os.environ.get("API_ENV")
        os.environ["API_ENV"] = "invalid_env"
        try:
            import control_panel.cloud.api.auth as auth_mod
            with pytest.raises(RuntimeError, match="Invalid API_ENV"):
                importlib.reload(auth_mod)
        finally:
            # Restore
            if old is None:
                os.environ.pop("API_ENV", None)
            else:
                os.environ["API_ENV"] = old
            # Reload with valid env so rest of tests work
            import control_panel.cloud.api.auth as auth_mod2
            importlib.reload(auth_mod2)
