# System imports.
import base64
import logging
import os
import platform
import random
import subprocess
import sys
import threading
import time
import json as _json
from datetime import datetime
from functools import partial, wraps

from flask import Flask, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit

import pylib as keyme

from control_panel.python.putil import SocketErrors, WebsocketError, WebsocketSuccess
from control_panel.python.shared import PORTS
from control_panel.python import wellness

# Cameras supported for take_image (same set as setup/scripts/putil/image.py).
TAKE_IMAGE_CAMERAS = [
    'bitting_video_left',
    'bitting_video_right',
    'gripper_camera',
    'milling_video',
    'overhead_camera',
    'security_camera',
    'screenshot',
    'inventory_camera',
    'bitting_video_left_roi_box',
    'bitting_video_right_roi_box',
]

# Match gui5/python's protection against Engine.IO decode packet bursts.
if sys.version_info[0] == 3 and sys.version_info[1] >= 6:
    try:
        from engineio.payload import Payload
        default_packet_size = 16
        cfg_path = os.path.join(keyme.config.PATH, "control_panel", "config", "control_panel.json")
        if os.path.isfile(cfg_path):
            cfg = _json.load(open(cfg_path))
            Payload.max_decode_packets = cfg.get("max_decode_packets", default_packet_size)
        else:
            Payload.max_decode_packets = default_packet_size
    except Exception as e:
        # Fail open: do not block server startup if engineio internals change.
        keyme.log.error(f"Engine.IO payload config skipped: {e}")


# Setup the flask server. Device: Socket.IO only; no REST, no static/JS.
app = Flask(__name__)
CORS(app)
app.config['CORS_HEADERS'] = 'Content-Type'

_cfg_path = os.path.join(keyme.config.PATH, "control_panel", "config", "control_panel.json")

# Track connected SIDs for get_connection_count. Connection limit is enforced by the frontend only.
_connected_sids = set()
_connection_lock = threading.Lock()

# State file for system_monitor: attribute python3 network traffic to CONTROL_PANEL
# only when clients are actively connected.
_CONNECTION_COUNT_STATE = 'state/control_panel/connection_count.json'

def _write_connection_count(count):
    """Write current connection count to state file for system_monitor."""
    try:
        keyme.config.save(_CONNECTION_COUNT_STATE, {'connection_count': count})
    except Exception:
        pass

# Flask-SocketIO server.
socket = SocketIO(app, async_mode='threading', logger=False, engineio_logger=False)
socket.init_app(app, cors_allowed_origins='*')

# TTL cache for polled handlers: key -> (timestamp, value). Reduces duplicate work when multiple clients poll.
_CACHE_TTL_FAST_SEC = 4
_CACHE_TTL_SLOW_SEC = 8
_cache = {}
_cache_lock = threading.Lock()
if os.path.isfile(_cfg_path):
    try:
        _cfg = _json.load(open(_cfg_path))
        _CACHE_TTL_FAST_SEC = _cfg.get("cache_ttl_fast_sec", _CACHE_TTL_FAST_SEC)
        _CACHE_TTL_SLOW_SEC = _cfg.get("cache_ttl_slow_sec", _CACHE_TTL_SLOW_SEC)
    except Exception:
        pass


def _cached(key, ttl_sec, compute_fn):
    """Return cached value if non-expired, else compute, store and return. Thread-safe."""
    now = time.time()
    with _cache_lock:
        if key in _cache:
            ts, val = _cache[key]
            if now - ts < ttl_sec:
                return val
        val = compute_fn()
        _cache[key] = (now, val)
        return val


# Reduce socket.io log noise.
class SocketIOLogFilter(logging.Filter):
    def filter(self, record):
        return 'socket.io' not in record.getMessage()


logging.getLogger('werkzeug').addFilter(SocketIOLogFilter())


def _handle_errors(handler=None, return_value=None):
    """Decorator which catches common IPC exceptions and standardizes output."""
    if handler is None:
        return partial(_handle_errors, return_value=return_value)

    @wraps(handler)
    def wrapper(message):
        try:
            response = handler(message)
        except keyme.ipc.exceptions.TimeoutException:
            return WebsocketError(SocketErrors.IPC_TIMED_OUT.value).to_json()
        except keyme.ipc.exceptions.IPCException as e:
            err_msg = "{}: {}".format(e.__class__.__name__, e)
            return WebsocketError([SocketErrors.IPC_ERROR.value, err_msg]).to_json()
        except (TypeError, ValueError, KeyError, AttributeError, RuntimeError, OSError, LookupError) as e:
            err_msg = "{}: {}".format(e.__class__.__name__, e)
            return WebsocketError([SocketErrors.OTHER.value, err_msg]).to_json()

        if isinstance(response, (WebsocketError, WebsocketSuccess)):
            return response.to_json()
        if not isinstance(response, (keyme.ipc.Request, keyme.ipc.Response)):
            return WebsocketSuccess(response).to_json()
        data = response.get('data')
        if response.get('action') == 'REJECTED':
            return WebsocketError([SocketErrors.IPC_REJECTED.value, response.get('data')]).to_json()
        if return_value:
            data = data.get(return_value) if data else None
        return WebsocketSuccess(data).to_json()
    return wrapper


_IPC_ERRORS = (keyme.ipc.exceptions.TimeoutException, keyme.ipc.exceptions.IPCException)


def _activity():
    """Activity from new_activity_check logic (gui5/scripts/activity_check.py). Returns 'inactive'|'active'|'service'."""
    try:
        svc = keyme.status.remote.get(
            'processes.MANAGER.configuration.service',
            logging=False,
            raise_on_error=keyme.ipc.NO_ERRORS)
        if svc is True:
            return 'service'
    except _IPC_ERRORS as e:
        keyme.log.error(f"Activity service check failed, assuming not service: {e}")
    try:
        idle = keyme.status.remote.get(
            'abilities.idle_kiosk',
            logging=False,
            raise_on_error=keyme.ipc.NO_ERRORS)
        if idle is None or idle is True:
            return 'inactive'
        return 'active'
    except _IPC_ERRORS as e:
        keyme.log.error(f"Activity idle check failed, assuming inactive: {e}")
        return 'inactive'


def _kiosk_state():
    """Kiosk state from ABILITIES_MANAGER GET_STATUS key 'state' (abilities_manager/tools/get_status.py)."""
    try:
        r = keyme.ipc.send_sync('ABILITIES_MANAGER', 'GET_STATUS', {'key': 'state'}, logging=False)
        s = (r.get('data') or {}).get('status')
        return s if isinstance(s, str) else 'UNKNOWN'
    except _IPC_ERRORS + (TypeError, AttributeError, KeyError) as e:
        keyme.log.error(f"Kiosk state IPC failed, returning UNKNOWN: {e}")
        return 'UNKNOWN'


def _panel_info():
    """Panel + store info for title bar and sidebar. Safe defaults on error."""
    def _str(v):
        return str(v) if v is not None else ''
    gen = getattr(keyme.config, 'KIOSK_GEN', None)
    generation = ('Gen {}'.format(gen) if gen is not None else '') or ''
    try:
        git_tag = (keyme.git.get_tags() or '').strip() or ''
    except (OSError, ValueError, TypeError) as e:
        keyme.log.error(f"Panel info: git_tag failed: {e}")
        git_tag = ''
    try:
        banner = _str(keyme.deployed.banner_name())
    except (OSError, TypeError, KeyError, ValueError) as e:
        keyme.log.error(f"Panel info: banner failed: {e}")
        banner = ''
    try:
        deployed = bool(keyme.deployed.get())
    except (OSError, TypeError, KeyError, ValueError) as e:
        keyme.log.error(f"Panel info: deployed failed: {e}")
        deployed = False
    try:
        store_address = _str(keyme.deployed.store_address())
    except (OSError, TypeError, KeyError, ValueError) as e:
        keyme.log.error(f"Panel info: store_address failed: {e}")
        store_address = ''
    return {
        'activity': _activity(),
        'kiosk_status': _kiosk_state(),
        'generation': generation,
        'git_tag': git_tag,
        'banner': banner,
        'deployed': deployed,
        'store_address': store_address,
        'banner_name': banner,
    }


def _format_uptime(seconds):
    """Format seconds since boot as 'X days, Y hours, Z mins'."""
    if seconds is None or seconds < 0:
        return ''
    s = int(seconds)
    days, s = divmod(s, 86400)
    hours, s = divmod(s, 3600)
    mins = s // 60
    parts = []
    if days:
        parts.append('{} day{}'.format(days, 's' if days != 1 else ''))
    if hours:
        parts.append('{} hour{}'.format(hours, 's' if hours != 1 else ''))
    parts.append('{} min{}'.format(mins, 's' if mins != 1 else ''))
    return ', '.join(parts)


def _uptime_from_proc():
    """Fallback: parse /proc/uptime (seconds)."""
    try:
        with open('/proc/uptime', 'r') as f:
            s = f.read().split()[0]
        return float(s)
    except (OSError, IndexError, ValueError) as e:
        keyme.log.error(f"Could not read /proc/uptime: {e}")
        return None


def get_cpu_temp_sys():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return int(f.read().strip()) / 1000.0
    except (OSError, ValueError):
        return None


def _os_version_ubuntu():
    """Read Ubuntu (or distro) version from /etc/os-release."""
    try:
        with open('/etc/os-release', 'r') as f:
            data = {}
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' in line:
                    k, v = line.split('=', 1)
                    data[k] = v.strip('"').strip("'")
        pretty = data.get('PRETTY_NAME') or data.get('NAME', '')
        ver = data.get('VERSION_ID', '')
        if pretty:
            return pretty
        if data.get('NAME', '').lower() == 'ubuntu' and ver:
            return 'Ubuntu {}'.format(ver)
        if ver:
            return '{} {}'.format(data.get('NAME', 'Unknown'), ver)
        return data.get('NAME', '') or platform.platform()
    except (OSError, KeyError, IndexError, ValueError) as e:
        keyme.log.error(f"OS version read failed: {e}")
        try:
            return platform.platform()
        except (TypeError, ValueError):
            return ''


def _computer_stats():
    """CPU, memory, uptime, CPU temp, OS version, load average. Uses psutil when available."""
    out = {
        'cpu_percent': None,
        'memory_percent': None,
        'uptime': '',
        'cpu_temp': '',
        'os_version': '',
        'load_average': '',
        'time_updated': '',
    }
    try:
        import psutil
    except ImportError as e:
        keyme.log.error(f"psutil not available, computer stats limited: {e}")
        out['time_updated'] = datetime.now().strftime('%a %b %d %Y %H:%M:%S')
        return out

    try:
        out['cpu_percent'] = round(psutil.cpu_percent(interval=0.1), 1)
    except (TypeError, ValueError, AttributeError, OSError) as e:
        keyme.log.error(f"Computer stats: cpu_percent unavailable: {e}")

    try:
        mem = psutil.virtual_memory()
        out['memory_percent'] = round(mem.percent, 1)
    except (TypeError, ValueError, AttributeError, OSError) as e:
        keyme.log.error(f"Computer stats: memory_percent unavailable: {e}")

    try:
        boot_fn = getattr(psutil, 'boot_time', None) or getattr(psutil, 'boottime', None)
        if boot_fn is not None:
            bt = boot_fn()
            out['uptime'] = _format_uptime(time.time() - bt)
    except (TypeError, ValueError, AttributeError, OSError) as e:
        keyme.log.error(f"Computer stats: uptime unavailable: {e}")
    if not out['uptime']:
        secs = _uptime_from_proc()
        if secs is not None:
            out['uptime'] = _format_uptime(secs)

    temp_c = get_cpu_temp_sys()
    if temp_c is not None:
        out['cpu_temp'] = '{:.0f} \u00b0C'.format(temp_c)

    try:
        out['os_version'] = _os_version_ubuntu()
    except (TypeError, ValueError, OSError) as e:
        keyme.log.error(f"OS version unavailable: {e}")

    try:
        load = os.getloadavg()
        out['load_average'] = '{:.2f}, {:.2f}, {:.2f}'.format(load[0], load[1], load[2])
    except (OSError, AttributeError) as e:
        keyme.log.error(f"Load average unavailable: {e}")

    out['time_updated'] = datetime.now().strftime('%a %b %d %Y %H:%M:%S')
    return out


LOGINS_CSV = '/tmp/keyme_logins.csv'


def _live_remote_ttys():
    """Return list of TTYs (e.g. pts/0) that currently have a remote (SSH) session."""
    try:
        r = subprocess.run(
            ['who'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=5,
        )
        if r.returncode != 0 or not r.stdout:
            return []
        ttys = []
        for line in r.stdout.strip().splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[-1].startswith('(') and parts[-1].endswith(')'):
                ttys.append(parts[1])
        return ttys
    except (subprocess.TimeoutExpired, OSError, ValueError, FileNotFoundError):
        keyme.log.warning("Terminals: who (remote TTYs) failed")
        return []


def _ttys_to_users_from_csv():
    """Read keyme_logins.csv in order; return list of (tty_norm, user) with last occurrence per TTY.
    Order is file order (bottom of file = most recent = later in list)."""
    if not os.path.isfile(LOGINS_CSV):
        return []
    result = []  # (tty_norm, user) in order of last occurrence in file
    seen_ttys = set()
    try:
        with open(LOGINS_CSV, encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.split(None, 1)
                if len(parts) != 2:
                    continue
                user, tty = parts
                norm = tty[5:] if tty.startswith('/dev/') else tty
                if norm in seen_ttys:
                    result = [(t, u) for t, u in result if t != norm]
                result.append((norm, user))
                seen_ttys.add(norm)
    except (OSError, IOError) as e:
        keyme.log.error(f"Terminals: could not read {LOGINS_CSV}: {e}")
        return []
    return result


def _terminals():
    """Remote (SSH) and local terminal counts; SSH usernames from keyme_logins.csv + who."""
    out = {'remote_users': [], 'remote_count': 0, 'local_count': 0}

    live_ttys = set(_live_remote_ttys())
    out['remote_count'] = len(live_ttys)

    try:
        r = subprocess.run(
            "who | awk '$2 ~ /^pts/ && $NF !~ /^\\([0-9.]+\\)$/ && $NF != \"(:0)\"' | wc -l",
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=5,
        )
        out['local_count'] = int((r.stdout or '').strip() or 0)
    except (subprocess.TimeoutExpired, OSError, ValueError, FileNotFoundError) as e:
        keyme.log.error(f"Terminals: who (local count) failed: {e}")

    # Order by CSV (file order): users currently live, in order of last appearance in file
    tty_user_list = _ttys_to_users_from_csv()
    out['remote_users'] = [user for tty, user in tty_user_list if tty in live_ttys]

    return out


def _run_get_status(*args):
    """Run get_status.py with given args. Returns (stdout, stderr) as strings."""
    script = os.path.join(keyme.config.PATH, 'abilities_manager', 'tools', 'get_status.py')
    cmd = [sys.executable, script] + list(args)
    try:
        r = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=15,
            cwd=keyme.config.PATH,
        )
        return (r.stdout or '', r.stderr or '')
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.warning(f"get_status subprocess failed: {e}")
        return ('', str(e))


def _keystat():
    """Run keystat (ps -ef --sort=cmd | grep '[K]IOSK'), parse into [{name, pid, user, cpu, runtime}]."""
    cmd = "ps -ef --sort=cmd | grep '[K]IOSK'"
    try:
        r = subprocess.run(
            cmd,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=15,
        )
        raw = (r.stdout or '').strip()
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.error(f"Keystat subprocess failed: {e}")
        return []

    processes = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            pid = int(parts[1])
        except (ValueError, TypeError):
            continue
        user = parts[0]
        c_raw = parts[3]
        try:
            cpu = int(c_raw) if c_raw not in ('-', '') else 0
        except (ValueError, TypeError):
            cpu = 0
        runtime = parts[6]
        name = ' '.join(parts[7:])
        processes.append({
            'name': name,
            'pid': pid,
            'user': user,
            'cpu': cpu,
            'runtime': runtime,
        })
    return processes


def _wtf_why_degraded():
    """Run wtf and why-degraded equivalents (get_status), plus keystat; return combined kiosk stats."""
    out = {
        'wtf': {'stdout': '', 'stderr': ''},
        'why_degraded': {'stdout': '', 'stderr': ''},
        'processes': [],
        'time_updated': '',
    }
    so, se = _run_get_status('-k', 'degraded_data', '-j')
    out['wtf']['stdout'] = 'degraded abilities: {}'.format(so.strip()) if so.strip() else 'degraded abilities: '
    out['wtf']['stderr'] = se

    so, se = _run_get_status('-k', 'degraded_data')
    out['why_degraded']['stdout'] = so
    out['why_degraded']['stderr'] = se

    try:
        out['processes'] = _keystat()
    except (TypeError, ValueError, OSError) as e:
        keyme.log.error(f"wtf_why_degraded: keystat failed: {e}")

    out['time_updated'] = datetime.now().strftime('%a %b %d %Y %H:%M:%S')
    return out


# Abilities keys used by Attention Needed + Cameras (Status page).
_ABILITIES_KEYS = frozenset([
    'X_calibrated', 'Y_calibrated', 'Z_calibrated', 'C_calibrated',
    'pci_buses_present', 'pci_cards_working', 'screen_settings_correct',
    'gui_app_mounted', 'symlinks_correct',
    'bitting_left_camera_connected', 'bitting_left_no_frames', 'bitting_left_ready_to_scan',
    'bitting_right_camera_connected', 'bitting_right_no_frames', 'bitting_right_ready_to_scan',
    'milling_camera_connected', 'milling_no_frames', 'milling_ready',
    'gripper_camera_connected', 'gripper_no_frames', 'gripper_camera_ready', 'gripper_camera_critical',
    'inventory_camera_connected', 'inventory_no_frames', 'inventory_camera_ready',
    'security_camera_connected', 'security_no_frames', 'security_camera_ready',
    'minor_cameras_critical',
])
# Process keys used by Cameras (raw expand) + Motion.
_PROCESS_KEYS = frozenset([
    'DET_BITTING_LEFT', 'DET_BITTING_RIGHT', 'DET_MILLING',
    'GRIPPER_CAM', 'INVENTORY_CAMERA', 'SECURITY_CAMERA', 'MOTION',
])


def _get_status_full():
    """Fetch full status dict from ABILITIES_MANAGER GET_STATUS (key=None). Returns None on error."""
    try:
        r = keyme.ipc.send_sync('ABILITIES_MANAGER', 'GET_STATUS', {'key': None}, logging=False)
        return (r.get('data') or {}).get('status')
    except _IPC_ERRORS + (TypeError, AttributeError, KeyError) as e:
        keyme.log.error(f"GET_STATUS full failed: {e}")
        return None


def _status_sections():
    """Trimmed status for Attention Needed, Cameras, Devices, Motion. Single IPC GET_STATUS."""
    empty = {'abilities': {}, 'devices': {}, 'processes': {}, 'time_updated': {}}
    full = _get_status_full()
    if not full or not isinstance(full, dict):
        ts = datetime.now().strftime('%a %b %d %Y %H:%M:%S')
        empty['time_updated'] = {'cameras': ts, 'devices': ts, 'motion': ts, 'problems': ts}
        return empty

    ts = datetime.now().strftime('%a %b %d %Y %H:%M:%S')
    out = {'time_updated': {'cameras': ts, 'devices': ts, 'motion': ts, 'problems': ts}}

    a = full.get('abilities') or {}
    out['abilities'] = {k: a[k] for k in _ABILITIES_KEYS if k in a}

    out['devices'] = dict(full.get('devices') or {})

    procs = full.get('processes') or {}
    out['processes'] = {k: dict(procs[k]) for k in _PROCESS_KEYS if k in procs and isinstance(procs[k], dict)}

    return out


# IPC policy: Do not add generic client->ZMQ IPC (e.g. passthrough "ipc.send").
# Any ZMQ IPC used by the control panel must be exposed via a dedicated Socket.IO
# event and implemented in this file (fixed target/action or server-side checks).
# This keeps the client surface minimal and auditable. (For future developers/LLMs.)


@socket.on('connect')
def on_connect():
    sid = getattr(request, 'sid', None)
    if not sid:
        return
    with _connection_lock:
        _connected_sids.add(sid)
        total = len(_connected_sids)
    _write_connection_count(total)
    keyme.log.info(f"Control panel client connected sid={sid} total_connections={total}")
    socket.emit('hello', {
        'connected': True,
        'service': 'CONTROL_PANEL',
        'kiosk_name': getattr(keyme.config, 'KIOSK_NAME', None) or ''
    })


@socket.on('disconnect')
def on_disconnect():
    sid = getattr(request, 'sid', None)
    with _connection_lock:
        _connected_sids.discard(sid)
        total = len(_connected_sids)
    _write_connection_count(total)
    keyme.log.info(f"Control panel client disconnected sid={sid} total_connections={total}")


@socket.on('get_kiosk_name')
def get_kiosk_name():
    """Client requests kiosk name; return via ack. Use when hello was missed (e.g. fast connect)."""
    keyme.log.info("socket.io: requesting get_kiosk_name")
    return {'kiosk_name': getattr(keyme.config, 'KIOSK_NAME', None) or ''}


@socket.on('get_panel_info')
def get_panel_info():
    """Title bar + store info. Polled with status snapshot (e.g. every 10s)."""
    keyme.log.info("socket.io: requesting get_panel_info")
    return _cached('panel_info', _CACHE_TTL_FAST_SEC, _panel_info)


@socket.on('get_activity')
def get_activity():
    """Activity only. Poll every 5s for live updates."""
    keyme.log.info("socket.io: requesting get_activity")
    return {'activity': _activity()}


@socket.on('get_computer_stats')
def get_computer_stats():
    """Computer Stats (CPU, memory, uptime, CPU temp, OS version). Poll every 5s."""
    keyme.log.info("socket.io: requesting get_computer_stats")
    return _cached('computer_stats', _CACHE_TTL_FAST_SEC, _computer_stats)


@socket.on('get_terminals')
def get_terminals():
    """Remote (SSH) and local terminal counts; SSH usernames from keyme_logins.csv + who. Poll with activity."""
    keyme.log.info("socket.io: requesting get_terminals")
    return _cached('terminals', _CACHE_TTL_FAST_SEC, _terminals)


@socket.on('get_wtf_why_degraded')
def get_wtf_why_degraded():
    """wtf and why-degraded command outputs (stdout+stderr). Poll with Kiosk Stats."""
    keyme.log.info("socket.io: requesting get_wtf_why_degraded")
    return _cached('wtf_why_degraded', _CACHE_TTL_SLOW_SEC, _wtf_why_degraded)


@socket.on('get_status_sections')
def get_status_sections():
    """Trimmed status for Attention Needed, Cameras, Devices, Motion. One IPC GET_STATUS."""
    keyme.log.info("socket.io: requesting get_status_sections")
    return _cached('status_sections', _CACHE_TTL_SLOW_SEC, _status_sections)


@socket.on('get_connection_count')
def get_connection_count():
    """Current number of Socket.IO connections to this control panel. Not cached."""
    keyme.log.info("socket.io: requesting get_connection_count")
    with _connection_lock:
        return {'count': len(_connected_sids)}


def _build_status_snapshot_core():
    """Build the cacheable part of the status snapshot (no connection_count)."""
    return {
        'computer_stats': _computer_stats(),
        'terminals': _terminals(),
        'wtf_why_degraded': _wtf_why_degraded(),
        'status_sections': _status_sections(),
    }


_STATUS_SNAPSHOT_TTL_SEC = 6


@socket.on('get_status_snapshot')
def get_status_snapshot():
    """Single response with computer_stats, terminals, wtf_why_degraded, status_sections (cached), and connection_count (fresh)."""
    keyme.log.info("socket.io: requesting get_status_snapshot")
    data = _cached('status_snapshot', _STATUS_SNAPSHOT_TTL_SEC, _build_status_snapshot_core)
    with _connection_lock:
        data = dict(data, connection_count=len(_connected_sids))
    return data


def _discover_process_configs():
    """Discover (process, filename) from filesystem. Walk PATH; skip top-level config dir.
    For each other top-level dir with a config/ subdir, collect every config/*.json."""
    path = keyme.config.PATH
    config_dir = keyme.config.CONFIG_DIR
    seen = []
    try:
        for name in sorted(os.listdir(path)):
            if name == config_dir:
                continue
            process_dir = os.path.join(path, name)
            if not os.path.isdir(process_dir):
                continue
            config_path = os.path.join(process_dir, config_dir)
            if not os.path.isdir(config_path):
                continue
            for f in sorted(os.listdir(config_path)):
                if f.endswith('.json'):
                    seen.append((name, f))
    except OSError as e:
        keyme.log.error("Config discovery failed: %s", e)
    return seen


@socket.on('get_all_configs')
def get_all_configs():
    """Load all process configs on demand: discover (process, filename), cascade_load each;
    also include top-level hardware config (config/hardware.json). Return nested payload."""
    keyme.log.info("socket.io: requesting get_all_configs")
    specs = _discover_process_configs()
    configs = {}
    for process, filename in specs:
        if process not in configs:
            configs[process] = {}
        try:
            cfg = keyme.config.cascade_load(filename, process=process, use_splits=True)
            configs[process][filename] = cfg
        except Exception as e:
            keyme.log.error("Failed to load %s/%s: %s", process, filename, e)
            configs[process][filename] = None
    # Top-level hardware manifest (config/hardware.json); not per-process.
    hardware = getattr(keyme.config, 'hardware', None)
    if hardware is not None and hasattr(hardware, 'copy'):
        hardware = dict(hardware)
    elif hardware is None:
        hardware = {}
    return WebsocketSuccess({'configs': configs, 'hardware': hardware}).to_json()


def _take_image_on_device(camera, resize_factor=0.5):
    """Run take_image.py or scrot on the device; return (image_base64, None) or (None, error_msg)."""
    if camera not in TAKE_IMAGE_CAMERAS:
        return None, 'Invalid camera'

    try:
        resize_factor = float(resize_factor)
        if not (0.1 <= resize_factor <= 1.0):
            return None, 'resize_factor must be between 0.1 and 1.0'
    except (TypeError, ValueError):
        return None, 'Invalid resize_factor'

    resize_factor_str = str(resize_factor)
    temp_path = '/tmp/{}.jpg'.format(random.randrange(2 ** 31))
    kiosk_path = keyme.config.PATH
    scripts_dir = os.path.join(kiosk_path, 'scripts')
    take_image_script = os.path.join(scripts_dir, 'take_image.py')
    draw_roi_script = os.path.join(scripts_dir, 'draw_roi_crop_box.py')

    # Resolve ROI variants to base camera + roi_side
    if camera == 'bitting_video_left_roi_box':
        base_camera = 'bitting_video_left'
        roi_side = 'left'
    elif camera == 'bitting_video_right_roi_box':
        base_camera = 'bitting_video_right'
        roi_side = 'right'
    else:
        base_camera = camera
        roi_side = None

    try:
        if base_camera == 'screenshot':
            env = dict(os.environ)
            env['DISPLAY'] = ':0'
            r = subprocess.run(
                ['sudo', 'env', 'DISPLAY=:0', 'scrot', temp_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
                env=env,
            )
        else:
            device_name = 'keyme_{}'.format(base_camera)
            r = subprocess.run(
                [sys.executable, take_image_script, device_name, temp_path,
                 '--resize_factor', resize_factor_str],
                cwd=kiosk_path,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=60,
            )
            if r.returncode == 0 and roi_side is not None:
                r_roi = subprocess.run(
                    [sys.executable, draw_roi_script, roi_side, temp_path,
                     temp_path, resize_factor_str],
                    cwd=kiosk_path,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=15,
                )
                if r_roi.returncode != 0:
                    keyme.log.warning(
                        'draw_roi_crop_box failed: %s', (r_roi.stderr or b'').decode(errors='replace')
                    )

        if r.returncode != 0:
            err = (r.stderr or b'').decode(errors='replace') or (r.stdout or b'').decode(errors='replace')
            return None, 'Capture failed: {}'.format(err.strip() or 'exit {}'.format(r.returncode))

        if not os.path.isfile(temp_path):
            return None, 'Capture produced no file'

        with open(temp_path, 'rb') as f:
            data = f.read()
        return base64.b64encode(data).decode('ascii'), None
    except subprocess.TimeoutExpired:
        return None, 'Capture timed out'
    except (OSError, IOError) as e:
        return None, '{}: {}'.format(type(e).__name__, e)
    finally:
        try:
            if os.path.isfile(temp_path):
                os.remove(temp_path)
        except OSError:
            pass


@socket.on('take_image')
def take_image(message):
    """Take a camera image on the device; return { camera, imageBase64 } or { error } via ack."""
    data = message if isinstance(message, dict) else {}
    camera = (data.get('camera') or '').strip()
    if not camera:
        return {'error': 'Missing camera'}
    keyme.log.info(f"Control panel take_image camera={camera}")
    resize_factor = data.get('resize_factor', 0.5)
    image_b64, err = _take_image_on_device(camera, resize_factor)
    if err:
        return {'error': err}
    return {'camera': camera, 'imageBase64': image_b64}


@socket.on('get_wellness_check')
def get_wellness_check():
    """Wellness check: stream progress per step, then return { summary, detailed } or { error }."""
    keyme.log.info("Control panel get_wellness_check started")
    try:
        summary_list = []
        detailed = {}
        sid = getattr(request, 'sid', None)
        for step, items, dk, dv in wellness.run_wellness_check_stream():
            summary_list.extend(items)
            if dk:
                detailed[dk] = dv
            if sid:
                emit('wellness_progress', {
                    'step': step,
                    'summary_items': items,
                    'detailed_key': dk,
                    'detailed_value': dv,
                }, room=sid)
        return {'summary': summary_list, 'detailed': detailed}
    except (TypeError, ValueError, OSError, IOError, KeyError, AttributeError) as e:
        keyme.log.error(f"Wellness check failed: {e}")
        return {'error': '{}: {}'.format(type(e).__name__, e)}


@socket.on('get_data_usage')
def get_data_usage():
    """Return all data usage JSON files from system_monitor archives and running totals."""
    keyme.log.info("socket.io: requesting get_data_usage")
    _kiosk = getattr(keyme.config, 'PATH', None) or '/kiosk'
    try:
        sm_cfg_path = os.path.join(_kiosk, "system_monitor", "config", "system_monitor.json")
        with open(sm_cfg_path) as f:
            sm_cfg = _json.load(f)
    except Exception as e:
        keyme.log.error("Failed to load system_monitor config: %s", e)
        return WebsocketError("Failed to load system_monitor config: {}".format(e)).to_json()

    result = {"daily": {}, "monthly": {}, "running_totals": {}}

    # Read daily archive files.
    daily_dir = os.path.join(_kiosk, sm_cfg.get("daily_archive_dir", "state/system_monitor/daily_data_usage/"))
    if os.path.isdir(daily_dir):
        for fname in sorted(os.listdir(daily_dir)):
            if fname.endswith(".json"):
                try:
                    with open(os.path.join(daily_dir, fname)) as f:
                        result["daily"][fname.replace(".json", "")] = _json.load(f)
                except Exception as e:
                    keyme.log.error("Failed to read daily file %s: %s", fname, e)

    # Read monthly archive files.
    monthly_dir = os.path.join(_kiosk, sm_cfg.get("monthly_archive_dir", "state/system_monitor/monthly_data_usage/"))
    if os.path.isdir(monthly_dir):
        for fname in sorted(os.listdir(monthly_dir)):
            if fname.endswith(".json"):
                try:
                    with open(os.path.join(monthly_dir, fname)) as f:
                        result["monthly"][fname.replace(".json", "")] = _json.load(f)
                except Exception as e:
                    keyme.log.error("Failed to read monthly file %s: %s", fname, e)

    # Read running totals.
    running_total_keys = {
        "daily": sm_cfg.get("daily_usage_conf", "config/system_monitor/daily_usage_running_total.json"),
        "monthly": sm_cfg.get("monthly_usage_conf", "config/system_monitor/monthly_usage_running_total.json"),
        "last_1h": sm_cfg.get("last_1h_data_conf", "config/system_monitor/last_1h_system_monitor.json"),
        "all_time": sm_cfg.get("run_total_data_conf", "config/system_monitor/running_total_system_monitor.json"),
    }
    for key, rel_path in running_total_keys.items():
        fpath = os.path.join(_kiosk, rel_path)
        if os.path.isfile(fpath):
            try:
                with open(fpath) as f:
                    result["running_totals"][key] = _json.load(f)
            except Exception as e:
                keyme.log.error("Failed to read running total %s: %s", key, e)

    return WebsocketSuccess(result).to_json()


def emit_async_request(request_obj):
    """Emit an async IPC to connected clients. Used by ControlPanelParser."""
    event = 'async.{}'.format(request_obj['action'])
    socket.emit(event, {'data': request_obj.get('data'), 'from': request_obj.get('from', 'CONTROL_PANEL')})


def run():
    port = PORTS['python']
    host = '0.0.0.0'
    _write_connection_count(0)
    keyme.log.info(f"Control panel Socket.IO server starting host={host} port={port}")
    socket.run(app, port=port, host=host)

