# Fleet commands: restart process, reset device, switch process list, reboot kiosk, clear cutter stuck.
# All change kiosk state; not read-only. All return { success: True, data: ... } or { success: False, errors: [str] }.

import os
import subprocess
import sys
import threading
from functools import wraps

import pylib as keyme

from control_panel.python import activity
from util.check_users import has_logged_in_user

_KIOSK_CWD = getattr(keyme.config, 'PATH', None) or '/kiosk'
_RESTART_ALL_SCRIPT = os.path.join(_KIOSK_CWD, 'util', 'restart_all.sh')

_ALL_CAMERAS_DEVICES = [
    'bitting_left_camera', 'bitting_right_camera', 'milling_camera',
    'gripper_camera', 'security_camera', 'overhead_camera', 'inventory_camera',
]

_RESET_RESULT_TIMEOUT_SEC = 55  # Stay under typical WS request timeout (60s)

# RESET_DEVICES is async: DEVICE_DIRECTOR sends RESET_RESULT per device to CONTROL_PANEL.
# Pending reset state so fleet_reset_device can block until all results or timeout.
_pending_reset_lock = threading.Lock()
_pending_reset = None  # { 'event': Event(), 'expected': set of device names, 'results': list of dicts }

def check_fleet_command_allowed(data=None):
    """Return (allowed, errors). If not allowed, errors is a non-empty list of strings.
    When data has force=True, skip the kiosk-in-use check (for tech on site / interrupt)."""
    if has_logged_in_user():
        return ( False, [ ( "Remote (fab/SSH) session detected. Commands are temporarily"
                " disabled to prevent conflicts while a developer is connected.") ])
    if activity.is_kiosk_in_use() and not (data and data.get('force')):
        return (False, ["Kiosk is in use. Fleet commands are not allowed while a customer is using the kiosk."])
    return (True, [])

def require_fleet_allowed(f):
    """Decorator: run check_fleet_command_allowed(data); if not allowed return error dict, else call f."""
    @wraps(f)
    def wrapper(data):
        allowed, errors = check_fleet_command_allowed(data)
        if not allowed:
            return {'success': False, 'errors': errors}
        return f(data)
    return wrapper


def deliver_reset_result(request):
    """Called from ControlPanelParser when async RESET_RESULT is received from DEVICE_DIRECTOR.
    request['data'] has 'device', 'result', and optionally 'error_message'.
    When DEVICE_DIRECTOR rejects the request (AssertionError), it sends one RESET_RESULT with
    result=False and no 'device' - we treat that as terminal and set the event immediately.
    """
    global _pending_reset
    data = request.get('data') or {}
    device = data.get('device')
    with _pending_reset_lock:
        if _pending_reset is None:
            return
        _pending_reset['results'].append({
            'device': device,
            'result': data.get('result', False),
            'error_message': data.get('error_message', ''),
        })
        # Request rejected (single result with no device) or we have all per-device results
        done = (
            len(_pending_reset['results']) >= len(_pending_reset['expected'])
            or (device is None and not data.get('result', True))
        )
        if done:
            _pending_reset['event'].set()



@require_fleet_allowed
def fleet_restart_process(data):
    """Restart a single process or all. data['process'] e.g. 'gui' or 'restart_all'.
    Single process: MANAGER RESTART_PROCESS (sync). Restart all: run restart_all.sh in background.
    Control panel (WS) runs as a separate systemd service and is not restarted.
    """
    data = data if isinstance(data, dict) else {}
    process = (data.get('process') or '').strip()
    if not process:
        return {'success': False, 'errors': ['Missing process']}
    try:
        if process == 'restart_all':
            subprocess.Popen(
                [_RESTART_ALL_SCRIPT],
                cwd=_KIOSK_CWD,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {'success': True, 'data': {}}
        response = keyme.ipc.send_sync(
            'MANAGER', 'RESTART_PROCESS', {'process': process.upper()},
            raise_on_error=keyme.ipc.ALL_BUT_TIMEOUT
        )
        if response.get('action') == 'REJECTED':
            reason = (response.get('data') or {}).get('reason', 'Request rejected')
            keyme.log.warning('fleet_restart_process rejected: %s', reason)
            return {'success': False, 'errors': [reason]}
        return {'success': True, 'data': {}}
    except (keyme.ipc.exceptions.TimeoutException, keyme.ipc.exceptions.IPCException) as e:
        keyme.log.error('fleet_restart_process failed: %s', e)
        return {'success': False, 'errors': [str(e)]}
    except Exception as e:
        keyme.log.exception('fleet_restart_process failed')
        return {'success': False, 'errors': [str(e)]}


@require_fleet_allowed
def fleet_reset_device(data):
    """Reset device(s). data['devices'] list; 'all_cameras' is expanded.
    DEVICE_DIRECTOR handles RESET_DEVICES async and sends RESET_RESULT per device to CONTROL_PANEL.
    We register pending state, send IPC, then block until all RESET_RESULTs or timeout.
    """
    global _pending_reset
    data = data if isinstance(data, dict) else {}
    devices = data.get('devices')
    if devices is None:
        return {'success': False, 'errors': ['Missing devices']}
    if not isinstance(devices, (list, tuple)):
        devices = [devices] if devices else []
    devices = list(devices)
    if 'all_cameras' in devices:
        devices = [d for d in devices if d != 'all_cameras'] + _ALL_CAMERAS_DEVICES
    if not devices:
        return {'success': False, 'errors': ['No devices specified']}
    expected = set(devices)
    event = threading.Event()
    results = []
    with _pending_reset_lock:
        if _pending_reset is not None:
            return {'success': False, 'errors': ['Another reset is already in progress']}
        _pending_reset = {'event': event, 'expected': expected, 'results': results}
    try:
        keyme.ipc.send('DEVICE_DIRECTOR', 'RESET_DEVICES', {'devices': devices})
        if not event.wait(timeout=_RESET_RESULT_TIMEOUT_SEC):
            keyme.log.warning('fleet_reset_device timed out waiting for RESET_RESULT')
            with _pending_reset_lock:
                _pending_reset = None
            return {'success': False, 'errors': ['Timed out waiting for device reset results']}
        with _pending_reset_lock:
            _pending_reset = None
            errors = []
            for r in results:
                if not r.get('result', False):
                    msg = r.get('error_message') or 'Reset failed'
                    if r.get('device'):
                        msg = '{}: {}'.format(r['device'], msg)
                    errors.append(msg)
            if errors:
                return {'success': False, 'errors': errors}
            return {'success': True, 'data': {}}
    except Exception as e:
        with _pending_reset_lock:
            _pending_reset = None
        keyme.log.exception('fleet_reset_device failed')
        return {'success': False, 'errors': [str(e)]}


@require_fleet_allowed
def fleet_switch_process_list(data):
    """Load a process list. data['file'] e.g. 'maintenance_processes', data['reason'] optional.
    MANAGER handles CHANGE_CONFIGURATION synchronously: returns CHANGE_CONFIGURATION_STARTED on
    acceptance or REJECTED with reason (e.g. invalid file, reason required for maintenance).
    """
    data = data if isinstance(data, dict) else {}
    file_val = (data.get('file') or '').strip()
    if not file_val:
        return {'success': False, 'errors': ['Missing file']}
    file_with_json = file_val if file_val.endswith('.json') else file_val + '.json'
    reason = data.get('reason') or 'Fleet command'
    try:
        response = keyme.ipc.send_sync(
            'MANAGER', 'CHANGE_CONFIGURATION',
            {
                'action': 'load',
                'file': file_with_json,
                'reason': reason,
                'from': 'CONTROL_PANEL',
            },
            raise_on_error=keyme.ipc.ALL_BUT_TIMEOUT
        )
        if response.get('action') == 'REJECTED':
            reason_msg = (response.get('data') or {}).get('reason', 'Request rejected')
            keyme.log.warning('fleet_switch_process_list rejected: %s', reason_msg)
            return {'success': False, 'errors': [str(reason_msg)]}
        return {'success': True, 'data': {}}
    except (keyme.ipc.exceptions.TimeoutException, keyme.ipc.exceptions.IPCException) as e:
        keyme.log.error('fleet_switch_process_list failed: %s', e)
        return {'success': False, 'errors': [str(e)]}
    except Exception as e:
        keyme.log.exception('fleet_switch_process_list failed')
        return {'success': False, 'errors': [str(e)]}


@require_fleet_allowed
def fleet_reboot_kiosk(data):
    """Run reboot script; return success immediately. Kiosk will disconnect shortly."""
    try:
        subprocess.Popen(
            './util/reboot_kiosk.sh',
            shell=True,
            cwd=_KIOSK_CWD,
        )
        return {'success': True, 'data': {}}
    except Exception as e:
        keyme.log.exception('fleet_reboot_kiosk failed')
        return {'success': False, 'errors': [str(e)]}


@require_fleet_allowed
def fleet_clear_cutter_stuck(data):
    """Run cutter_state.py --remove-stuck; return success/errors from exit code."""
    try:
        script = os.path.join(_KIOSK_CWD, 'cutter', 'shared', 'cutter_state.py')
        proc = subprocess.run(
            [sys.executable, script, '--remove-stuck'],
            cwd=_KIOSK_CWD,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if proc.returncode == 0:
            return {'success': True, 'data': {}}
        err = (proc.stderr or b'').decode('utf-8', errors='replace').strip() or proc.stdout.decode('utf-8', errors='replace').strip()
        return {'success': False, 'errors': [err or 'Script exited with code {}'.format(proc.returncode)]}
    except subprocess.TimeoutExpired:
        return {'success': False, 'errors': ['Script timed out']}
    except Exception as e:
        keyme.log.exception('fleet_clear_cutter_stuck failed')
        return {'success': False, 'errors': [str(e)]}


@require_fleet_allowed
def fleet_load_mom(data):
    """Run cutter_state.py --disable-cutting [reason]; put kiosk in mail order only mode."""
    try:
        script = os.path.join(_KIOSK_CWD, 'cutter', 'shared', 'cutter_state.py')
        reason = (data.get('reason') if isinstance(data, dict) else None) or ''
        proc = subprocess.run(
            [sys.executable, script, '--disable-cutting'] + reason.split(),
            cwd=_KIOSK_CWD,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if proc.returncode == 0:
            return {'success': True, 'data': {}}
        err = (proc.stderr or b'').decode('utf-8', errors='replace').strip() or (proc.stdout or b'').decode('utf-8', errors='replace').strip()
        return {'success': False, 'errors': [err or 'Script exited with code {}'.format(proc.returncode)]}
    except subprocess.TimeoutExpired:
        return {'success': False, 'errors': ['Script timed out']}
    except Exception as e:
        keyme.log.exception('fleet_load_mom failed')
        return {'success': False, 'errors': [str(e)]}


def _run_cutter_state_step(cwd, script, step_name, args):
    """Run cutter_state.py with given args. Return (True, None) on success, (False, error_msg) on failure."""
    try:
        proc = subprocess.run(
            [sys.executable, script] + args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
        if proc.returncode == 0:
            return (True, None)
        err = (proc.stderr or b'').decode('utf-8', errors='replace').strip() or (proc.stdout or b'').decode('utf-8', errors='replace').strip()
        return (False, '{}: {}'.format(step_name, err or 'Script exited with code {}'.format(proc.returncode)))
    except subprocess.TimeoutExpired:
        return (False, '{}: Script timed out'.format(step_name))
    except Exception as e:
        return (False, '{}: {}'.format(step_name, str(e)))


@require_fleet_allowed
def fleet_restore_cutting(data):
    """Run clear-exposed-key-lock, remove-stuck, then restore-cutting; re-enable cutting, clear MOM."""
    try:
        script = os.path.join(_KIOSK_CWD, 'cutter', 'shared', 'cutter_state.py')
        errors = []
        for step_name, args in [
            ('clear-exposed-key-lock', ['--clear-exposed-key-lock']),
            ('remove-stuck', ['--remove-stuck']),
            ('restore-cutting', ['--restore-cutting']),
        ]:
            ok, err = _run_cutter_state_step(_KIOSK_CWD, script, step_name, args)
            if not ok:
                errors.append(err)
        if errors:
            return {'success': False, 'errors': errors}
        return {'success': True, 'data': {}}
    except Exception as e:
        keyme.log.exception('fleet_restore_cutting failed')
        return {'success': False, 'errors': [str(e)]}
