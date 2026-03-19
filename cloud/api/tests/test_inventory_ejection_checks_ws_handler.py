import sys
import types
from unittest.mock import MagicMock


def _install_fake_pylib(monkeypatch):
    """Install a minimal fake `pylib` module so importing control_panel python modules works in unit tests.

    The real pylib pulls in pyOpenSSL which isn't installed in the cloud test environment.
    """
    fake_pylib = types.ModuleType("pylib")

    fake_pylib.config = types.SimpleNamespace(
        PATH="/tmp",
        STATE_PATH="/tmp",
        CONFIG_PATH="/tmp",
        KIOSK_NAME="NS0000",
        KIOSK_GEN=4,
    )
    fake_pylib.log = types.SimpleNamespace(
        info=lambda *a, **k: None,
        error=lambda *a, **k: None,
        warning=lambda *a, **k: None,
        debug=lambda *a, **k: None,
    )

    class _TimeoutException(Exception):
        pass

    class _IPCException(Exception):
        pass

    fake_pylib.ipc = types.SimpleNamespace(
        NO_ERRORS=0,
        exceptions=types.SimpleNamespace(
            TimeoutException=_TimeoutException,
            IPCException=_IPCException,
        ),
        send=lambda *a, **k: None,
        send_sync=lambda *a, **k: None,
        Request=object,
        Response=object,
    )
    fake_pylib.process = types.SimpleNamespace(name="CONTROL_PANEL")
    fake_pylib.status = types.SimpleNamespace(remote=types.SimpleNamespace(get=lambda *a, **k: None))
    fake_pylib.git = types.SimpleNamespace(get_tags=lambda: "")

    monkeypatch.setitem(sys.modules, "pylib", fake_pylib)
    return fake_pylib


def test_check_fleet_command_allowed_override_remote(monkeypatch):
    _install_fake_pylib(monkeypatch)
    from control_panel.python import fleet_commands

    # Case 1: developer/fab session detected, no override -> blocked
    monkeypatch.setattr(fleet_commands, "has_logged_in_user", lambda: True)
    monkeypatch.setattr(fleet_commands.activity, "is_kiosk_in_use", lambda: False)
    allowed, errors = fleet_commands.check_fleet_command_allowed({})
    assert allowed is False
    assert errors and "Remote (fab/SSH) session detected" in errors[0]

    # Case 2: developer/fab session detected, override -> allowed (if kiosk not in use)
    allowed, errors = fleet_commands.check_fleet_command_allowed({"override_remote": True}, allow_remote_override=True)
    assert allowed is True
    assert errors == []

    # Case 3: kiosk is in use still blocks unless force=True (even with override_remote)
    monkeypatch.setattr(fleet_commands.activity, "is_kiosk_in_use", lambda: True)
    allowed, errors = fleet_commands.check_fleet_command_allowed({"override_remote": True}, allow_remote_override=True)
    assert allowed is False
    assert errors and "Kiosk is in use" in errors[0]


def test_inventory_run_ejection_checks_input_validation_and_dispatch(monkeypatch):
    _install_fake_pylib(monkeypatch)
    from control_panel.python import server

    # Allow gate for input validation tests.
    monkeypatch.setattr(server, "check_fleet_command_allowed", lambda data, **kwargs: (True, []))

    send_mock = MagicMock()
    monkeypatch.setattr(server.keyme.ipc, "send", send_mock)

    # Missing magazine -> INVALID_INPUT
    res = server.inventory_run_ejection_checks({})
    assert res["success"] is False
    assert any("magazine required" in e for e in res["errors"])

    # Non-integer magazine -> INVALID_INPUT
    res = server.inventory_run_ejection_checks({"magazine": "abc"})
    assert res["success"] is False
    assert any("magazine must be 1-20" in e for e in res["errors"])

    # Out of range magazine -> INVALID_INPUT
    res = server.inventory_run_ejection_checks({"magazine": 21})
    assert res["success"] is False
    assert any("magazine must be 1-20" in e for e in res["errors"])

    # Happy path dispatch
    res = server.inventory_run_ejection_checks({"magazine": 1})
    assert res["success"] is True
    assert res["data"].get("started") is True

    assert send_mock.call_count == 1
    call_args = send_mock.call_args[0]
    assert call_args[0] == "JOB_SERVER"
    assert call_args[1] == "RUN_JOB"
    payload = call_args[2]
    assert payload["name"] == "test_ejections"
    assert payload["inputs"]["mag_numbers"] == [1]
    assert payload["inputs"]["eject_keys"] == 1
    assert payload["inputs"]["retries"] == 3
    assert payload["inputs"]["make_ticket"] is False

