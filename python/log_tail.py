# Log list and tail for control panel device. One active tail per client; allowlist-only paths.

from __future__ import absolute_import, division, print_function

import glob
import os
import subprocess
import threading
import time

import pylib as keyme

_LOG_DIR = '/var/log/keyme/processes'
_ALL_LOG_PATH = '/var/log/keyme/all.log'
_TMP_DIR = '/tmp'
_INITIAL_LINES_DEFAULT = 50
_INITIAL_LINES_MAX = 200
_ALL_LOG_RATE_LIMIT = 50  # max lines per second when tailing all.log

_client_tails = {}
_tails_lock = threading.Lock()


def _build_log_list():
    """Build list of { id, label, path, type } and allowlist id -> path. Paths only from this list."""
    logs = []
    allowlist = {}

    if os.path.isdir(_LOG_DIR):
        for path in sorted(glob.glob(os.path.join(_LOG_DIR, '*.log'))):
            name = os.path.basename(path)
            if name == 'all.log':
                continue
            pname = name[:-4] if name.endswith('.log') else name
            log_id = 'process/{}'.format(pname)
            logs.append({
                'id': log_id,
                'label': '{} (main)'.format(pname),
                'path': path,
                'type': 'main',
            })
            allowlist[log_id] = path

    for suffix in ('stdout', 'stderr'):
        pattern = os.path.join(_TMP_DIR, '*.{}'.format(suffix))
        for path in sorted(glob.glob(pattern)):
            name = os.path.basename(path)
            pname = name[:-len(suffix) - 1] if name.endswith('.' + suffix) else name
            log_id = 'process/{}/{}'.format(pname, suffix)
            logs.append({
                'id': log_id,
                'label': '{} ({})'.format(pname, suffix),
                'path': path,
                'type': suffix,
            })
            allowlist[log_id] = path

    if os.path.isfile(_ALL_LOG_PATH):
        logs.append({
            'id': 'all',
            'label': 'All logs (high volume)',
            'path': _ALL_LOG_PATH,
            'type': 'all',
        })
        allowlist['all'] = _ALL_LOG_PATH

    return logs, allowlist


def get_log_list():
    """Return { logs: [ { id, label, path, type }, ... ] } for UI. Path is for server allowlist only."""
    logs, _ = _build_log_list()
    return {'logs': logs}


def _read_tail_n(path, n):
    """Return last n lines from path. Uses tail -n for consistency."""
    n = max(1, min(n, _INITIAL_LINES_MAX))
    try:
        r = subprocess.run(
            ['tail', '-n', str(n), path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode == 0 and r.stdout:
            return r.stdout.rstrip('\n').split('\n')
        return []
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.warning('log_tail tail -n failed path=%s n=%s: %s', path, n, e)
        return []


def _tail_follow_thread(client_id, path, send_callback, push_event, is_all_log):
    """Background thread: tail -f path, send each line via send_callback until stop_event is set."""
    try:
        proc = subprocess.Popen(
            ['tail', '-f', path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except OSError as e:
        keyme.log.warning('log_tail tail -f failed path=%s: %s', path, e)
        return
    try:
        rate_count = 0
        rate_sec = time.time()
        for line in iter(proc.stdout.readline, ''):
            if not line:
                break
            with _tails_lock:
                state = _client_tails.get(client_id)
                if not state or state.get('stop_event').is_set():
                    break
            line = line.rstrip('\n\r')
            if is_all_log:
                now = time.time()
                if now - rate_sec >= 1.0:
                    rate_sec = now
                    rate_count = 0
                if rate_count >= _ALL_LOG_RATE_LIMIT:
                    continue
                rate_count += 1
            send_callback(client_id, {'event': push_event, 'data': {'line': line}})
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            try:
                proc.kill()
            except OSError:
                pass
    keyme.log.info('log_tail follow thread exiting client_id=%s path=%s', client_id, path)


def log_tail_stop(client_id):
    """Stop any active tail for client_id. Safe to call from any thread. Returns { stopped: true }."""
    with _tails_lock:
        state = _client_tails.pop(client_id, None)
    if state:
        state['stop_event'].set()
        thread = state.get('thread')
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
    return {'stopped': True}


def log_tail_start(client_id, data, send_callback, push_event):
    """Start tailing log_id for client_id. Stops any existing tail for this client.
    data: { log_id, initial_lines? }. initial_lines capped at _INITIAL_LINES_MAX (200).
    send_callback(client_id, msg) is used to push log_tail_line. push_event is the event name string.
    Returns { lines, log_id, path } or { success: False, errors: [...] }.
    """
    _, allowlist = _build_log_list()
    log_id = (data or {}).get('log_id')
    if not log_id or log_id not in allowlist:
        return {'success': False, 'errors': ['Invalid or missing log_id']}
    path = allowlist[log_id]
    initial_lines = data.get('initial_lines', _INITIAL_LINES_DEFAULT)
    try:
        initial_lines = int(initial_lines)
    except (TypeError, ValueError):
        initial_lines = _INITIAL_LINES_DEFAULT
    initial_lines = max(1, min(initial_lines, _INITIAL_LINES_MAX))

    log_tail_stop(client_id)

    lines = _read_tail_n(path, initial_lines)
    stop_event = threading.Event()
    is_all_log = (path == _ALL_LOG_PATH)

    def send(client_id, obj):
        send_callback(client_id, obj)

    thread = threading.Thread(
        target=_tail_follow_thread,
        args=(client_id, path, send_callback, push_event, is_all_log),
        daemon=True,
    )
    with _tails_lock:
        _client_tails[client_id] = {'stop_event': stop_event, 'thread': thread}
    thread.start()

    return {'lines': lines, 'log_id': log_id, 'path': path}
