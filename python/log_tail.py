# Log list and tail for control panel device.
# One active tail per client; allowlist-only paths.
# Date-range fetch: process main logs and all.log; optional process filter for all.log.

import glob
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta

import pylib as keyme

from control_panel.python import ws_protocol

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------

_LOG_DIR = '/var/log/keyme/processes'
_ALL_LOG_PATH = '/var/log/keyme/all.log'
_TMP_DIR = '/tmp'

_INITIAL_LINES_DEFAULT = 50
_INITIAL_LINES_MAX = 200
_ALL_LOG_RATE_LIMIT = 50  # max lines/sec when tailing all.log

_RANGE_MAX_DAYS = 4
_RANGE_MAX_LINES_DEFAULT = 20000
_RANGE_MAX_LINES_CAP = 50000
_RANGE_READ_CHUNK_SIZE = 65536
_RANGE_BATCH_SIZE_BYTES = 120 * 1024

# Log analyze: allowlisted awk scripts (analysis_id -> .awk filename).
_LOG_ANALYZE_SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'log_analyze_scripts')
ANALYZE_SCRIPTS = {
    'errors_and_restarts': 'errors_and_restarts.awk',
}

# Archived logs: {base_name}-{YYYYMMDD}.gz or {base_name}-{YYYYMMDD} (unarchived).
# Period covered by a file is (previous_archive_date, this_archive_date].

_client_tails = {}
_tails_lock = threading.Lock()


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _terminate_and_wait(proc, timeout=2):
    """Terminate process and wait; kill on timeout. No-op if proc is None."""
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        try:
            proc.kill()
        except OSError:
            pass


def _parse_datetime(s):
    """Parse YYYY-MM-DD, YYYY-MM-DDTHH:MM, or YYYY-MM-DDTHH:MM:SS. Returns datetime or None."""
    s = str(s).strip() if s else ''
    if not s:
        return None
    for fmt, size in (('%Y-%m-%dT%H:%M:%S', 19), ('%Y-%m-%dT%H:%M', 16), ('%Y-%m-%d', 10)):
        if len(s) >= size:
            try:
                return datetime.strptime(s[:size], fmt)
            except ValueError:
                pass
    return None


# -----------------------------------------------------------------------------
# Log list
# -----------------------------------------------------------------------------

def _build_log_list():
    """Return (logs, allowlist). logs: list of {id, label, path, type}; allowlist: id -> path."""
    logs = []
    allowlist = {}

    if os.path.isdir(_LOG_DIR):
        for path in sorted(glob.glob(os.path.join(_LOG_DIR, '*.log'))):
            name = os.path.basename(path)
            if name == 'all.log':
                continue
            pname = name[:-4] if name.endswith('.log') else name
            log_id = f'process/{pname}'
            logs.append({'id': log_id, 'label': f'{pname} (main)', 'path': path, 'type': 'main'})
            allowlist[log_id] = path

    for suffix in ('stdout', 'stderr'):
        for path in sorted(glob.glob(os.path.join(_TMP_DIR, f'*.{suffix}'))):
            name = os.path.basename(path)
            pname = name[: -len(suffix) - 1] if name.endswith('.' + suffix) else name
            log_id = f'process/{pname}/{suffix}'
            logs.append({'id': log_id, 'label': f'{pname} ({suffix})', 'path': path, 'type': suffix})
            allowlist[log_id] = path

    if os.path.isfile(_ALL_LOG_PATH):
        logs.append({'id': 'all', 'label': 'All logs (high volume)', 'path': _ALL_LOG_PATH, 'type': 'all'})
        allowlist['all'] = _ALL_LOG_PATH

    return logs, allowlist


def get_log_list():
    """Return { logs: [...] } for UI."""
    logs, _ = _build_log_list()
    return {'logs': logs}


# -----------------------------------------------------------------------------
# Live tail
# -----------------------------------------------------------------------------

def _read_tail_n(path, n):
    """Return last n lines from path (tail -n)."""
    n = max(1, min(n, _INITIAL_LINES_MAX))
    try:
        r = subprocess.run(
            ['tail', '-n', str(n), path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=10,
        )
        if r.returncode == 0 and r.stdout:
            return r.stdout.rstrip('\n').split('\n')
        return []
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.warning(f"log_tail tail -n failed path={path}: {e}")
        return []


def _tail_follow_thread(client_id, path, send_callback, push_event, is_all_log):
    """Background: tail -f path, push lines until stop_event is set. Rate-limit for all.log."""
    try:
        proc = subprocess.Popen(
            ['tail', '-f', path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            universal_newlines=True,
            bufsize=1,
        )
    except OSError as e:
        keyme.log.warning(f"log_tail tail -f failed path={path}: {e}")
        return
    try:
        rate_count, rate_sec = 0, time.time()
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
                    rate_sec, rate_count = now, 0
                if rate_count >= _ALL_LOG_RATE_LIMIT:
                    continue
                rate_count += 1
            send_callback(client_id, {'event': push_event, 'data': {'line': line}})
    finally:
        _terminate_and_wait(proc)
    keyme.log.info(f"log_tail follow thread exit client_id={client_id} path={path}")


def log_tail_stop(client_id):
    """Stop any active tail for client_id. Returns { stopped: True }."""
    with _tails_lock:
        state = _client_tails.pop(client_id, None)
    if state:
        state['stop_event'].set()
        thread = state.get('thread')
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
    return {'stopped': True}


def log_tail_start(client_id, data, send_callback, push_event):
    """Start tailing log_id. data: { log_id, initial_lines? }. Returns { lines, log_id, path } or errors."""
    _, allowlist = _build_log_list()
    log_id = (data or {}).get('log_id')
    if not log_id or log_id not in allowlist:
        return {'success': False, 'errors': ['Invalid or missing log_id']}
    path = allowlist[log_id]

    initial_lines = data.get('initial_lines', _INITIAL_LINES_DEFAULT)
    try:
        initial_lines = max(1, min(int(initial_lines), _INITIAL_LINES_MAX))
    except (TypeError, ValueError):
        initial_lines = _INITIAL_LINES_DEFAULT

    log_tail_stop(client_id)
    lines = _read_tail_n(path, initial_lines)
    stop_event = threading.Event()
    is_all_log = path == _ALL_LOG_PATH

    thread = threading.Thread(
        target=_tail_follow_thread,
        args=(client_id, path, send_callback, push_event, is_all_log),
        daemon=True,
    )
    with _tails_lock:
        _client_tails[client_id] = {'stop_event': stop_event, 'thread': thread}
    thread.start()
    return {'lines': lines, 'log_id': log_id, 'path': path}


# -----------------------------------------------------------------------------
# Date-range fetch: archive discovery
# -----------------------------------------------------------------------------

def _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt):
    """Return (files_to_read, last_archive_date).
    files_to_read: list of (archive_date, filepath, is_gz) for files whose period (d_prev, d_i] overlaps [start_dt, end_dt].
    File period = (previous_archive_date, this_archive_date]; last_archive_date = max dated file (current log covers (last, now]).
    """
    pattern = os.path.join(log_dir, base_name + '-*')
    by_date = {}
    for filepath in glob.glob(pattern):
        name = os.path.basename(filepath)
        is_gz = name.endswith('.gz')
        suffix = name[:-3] if is_gz else name
        parts = suffix.split('-')
        if len(parts) < 2:
            continue
        yyyymmdd = parts[-1]
        if len(yyyymmdd) != 8 or not yyyymmdd.isdigit():
            continue
        try:
            archive_date = datetime.strptime(yyyymmdd, '%Y%m%d').date()
        except ValueError:
            continue
        if archive_date not in by_date or (not by_date[archive_date][1] and is_gz):
            by_date[archive_date] = (filepath, is_gz)

    parsed = sorted(by_date.items(), key=lambda t: t[0])
    last_archive_date = parsed[-1][0] if parsed else None
    result = []
    for i, (d_i, (filepath, is_gz)) in enumerate(parsed):
        d_prev = parsed[i - 1][0] if i > 0 else None
        if (d_prev is None or d_prev < end_dt) and d_i >= start_dt:
            result.append((d_i, filepath, is_gz))
    return result, last_archive_date


# -----------------------------------------------------------------------------
# Date-range fetch: stream thread (awk for timestamp + optional process filter)
# -----------------------------------------------------------------------------

def _awk_script_with_process_filter(process_list):
    """Return awk script: timestamp in [start,end); if process_list non-empty, line must match KEYMELOG|NAME[ for one."""
    if not process_list:
        return r'$1 >= start && $1 < end'
    procs_str = ','.join(str(p).strip() for p in process_list if str(p).strip())
    return (
        r'BEGIN { n = split(procs, p, ",") } '
        r'$1 >= start && $1 < end { '
        r'if (n == 0) { print; next } '
        r'for (i = 1; i <= n; i++) if (index($0, "KEYMELOG|" p[i] "[") > 0) { print; next } '
        r'}'
    )


def _get_log_range_stream_thread(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts, process_filter=None):
    """Background: for each file, pipe through awk (timestamp + optional process match), stream batches."""
    process_list = [str(p).strip() for p in (process_filter or []) if str(p).strip()]
    awk_script = _awk_script_with_process_filter(process_list)
    procs_str = ','.join(process_list) if process_list else ''
    total_emitted = 0
    truncated = False
    start_time = time.time()

    def send_batch(batch):
        if batch:
            send_callback(client_id, {
                'event': ws_protocol.PUSH_LOG_RANGE_BATCH,
                'data': {'stream_id': stream_id, 'lines': batch},
            })

    def send_done(truncated_flag):
        send_callback(client_id, {
            'event': ws_protocol.PUSH_LOG_RANGE_DONE,
            'data': {'stream_id': stream_id, 'truncated': truncated_flag},
        })

    for _day, filepath, is_gz in files_to_read:
        if total_emitted >= max_lines:
            truncated = True
            break
        reader = None
        awk_proc = None
        try:
            reader = subprocess.Popen(
                ['zcat', filepath] if is_gz else ['cat', filepath],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            awk_args = ['awk', '-v', f'start={start_ts}', '-v', f'end={end_ts}', '-v', f'procs={procs_str}', awk_script]
            awk_proc = subprocess.Popen(
                awk_args,
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            reader.stdout.close()
        except OSError as e:
            keyme.log.warning(f"log_tail get_log_range Popen failed path={filepath!r}: {e}")
            _terminate_and_wait(reader)
            continue

        try:
            line_buffer = ''
            batch = []
            batch_bytes = 0
            proc = awk_proc
            while True:
                if time.time() - start_time > 60:
                    truncated = True
                    break
                chunk = proc.stdout.read(_RANGE_READ_CHUNK_SIZE)
                if not chunk:
                    break
                line_buffer += chunk
                while '\n' in line_buffer:
                    line, line_buffer = line_buffer.split('\n', 1)
                    batch.append(line)
                    batch_bytes += len(line) + 1
                    total_emitted += 1
                    if total_emitted >= max_lines:
                        truncated = True
                        break
                    if batch_bytes >= _RANGE_BATCH_SIZE_BYTES:
                        send_batch(batch)
                        batch, batch_bytes = [], 0
                if truncated:
                    break
            if batch:
                send_batch(batch)
        except (OSError, ValueError) as e:
            keyme.log.warning(f"log_tail get_log_range read failed path={filepath!r}: {e}")
        finally:
            _terminate_and_wait(proc)
            _terminate_and_wait(reader)
            if proc.stderr:
                proc.stderr.read()
            if reader.stderr:
                reader.stderr.read()

        if truncated:
            break

    send_done(truncated)
    keyme.log.info(f"log_tail get_log_range done stream_id={stream_id!r} emitted={total_emitted} truncated={truncated}")


# -----------------------------------------------------------------------------
# Date-range fetch: API
# -----------------------------------------------------------------------------

def get_log_range(data, client_id, send_callback):
    """Stream lines for date/datetime range (process main logs or all.log). Max 4 days.
    data: log_id, start_datetime, end_datetime (or start_date, end_date), max_lines?, stream_id?, process_filter? (all.log only).
    Returns { success, data: { started, stream_id, ... } } or { success: False, errors }.
    """
    data = data or {}
    keyme.log.info(f"log_tail get_log_range client_id={client_id!r} keys={list(data.keys())}")

    _, allowlist = _build_log_list()
    log_id = data.get('log_id')
    if not log_id or log_id not in allowlist:
        return {'success': False, 'errors': ['Invalid or missing log_id']}
    path = allowlist[log_id]

    start_raw = data.get('start_datetime') or data.get('start_date')
    end_raw = data.get('end_datetime') or data.get('end_date')
    if not start_raw or not end_raw:
        return {'success': False, 'errors': ['Missing start_datetime and end_datetime (or start_date and end_date)']}

    start_dt_parsed = _parse_datetime(start_raw)
    end_dt_parsed = _parse_datetime(end_raw)
    if start_dt_parsed is None or end_dt_parsed is None:
        return {'success': False, 'errors': ['Invalid datetime; use YYYY-MM-DD or YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS']}
    if start_dt_parsed >= end_dt_parsed:
        return {'success': False, 'errors': ['start must be before end']}
    start_dt = start_dt_parsed.date()
    end_dt = end_dt_parsed.date()
    if (end_dt - start_dt).days >= _RANGE_MAX_DAYS:
        return {'success': False, 'errors': [f'Date range exceeds {_RANGE_MAX_DAYS} days']}

    start_ts = start_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')
    end_ts = end_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')

    max_lines = data.get('max_lines', _RANGE_MAX_LINES_DEFAULT)
    try:
        max_lines = max(1, min(int(max_lines), _RANGE_MAX_LINES_CAP))
    except (TypeError, ValueError):
        max_lines = _RANGE_MAX_LINES_DEFAULT

    if log_id == 'all':
        log_dir = os.path.dirname(_ALL_LOG_PATH)
        base_name = 'all.log'
    else:
        log_dir = _LOG_DIR
        base_name = log_id.replace('process/', '', 1) + '.log'

    files_to_read, last_archive_date = _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt)
    today = datetime.utcnow().date()
    if start_dt <= today and (last_archive_date is None or end_dt > last_archive_date):
        current_path = os.path.join(log_dir, base_name)
        if os.path.isfile(current_path):
            files_to_read.append((today, current_path, False))

    if not files_to_read:
        keyme.log.warning(f"log_tail get_log_range no files for range {start_dt}..{end_dt}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    process_filter = None
    if log_id == 'all':
        pf = data.get('process_filter')
        if isinstance(pf, (list, tuple)) and len(pf) > 0:
            process_filter = [str(p).strip() for p in pf if str(p).strip()]
            if process_filter:
                keyme.log.info(f"log_tail get_log_range process_filter={process_filter}")

    stream_id = data.get('stream_id') or str(time.time())
    dates_with_data = [t[0].isoformat() for t in files_to_read]
    keyme.log.info(f"log_tail get_log_range stream_id={stream_id!r} files={len(files_to_read)} dates={dates_with_data}")

    thread = threading.Thread(
        target=_get_log_range_stream_thread,
        args=(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts, process_filter),
        daemon=True,
    )
    thread.start()

    return {
        'success': True,
        'data': {
            'started': True,
            'stream_id': stream_id,
            'log_id': log_id,
            'path': path,
            'requested_start': start_dt.isoformat(),
            'requested_end': end_dt.isoformat(),
            'dates_with_data': dates_with_data,
            'missing_dates': [] if files_to_read else [f"{start_dt.isoformat()}..{end_dt.isoformat()}"],
        },
    }


# -----------------------------------------------------------------------------
# Log analyze: run awk script on all.log for date range (streaming)
# -----------------------------------------------------------------------------

def _run_log_analyze_stream_thread(client_id, send_callback, stream_id, files_to_read, start_ts, end_ts, script_path):
    """Background: same flow as get_log_range — for each file zcat|awk, read in chunks, push batches via PUSH_LOG_RANGE_*."""
    awk_cmd = ['nice', '-n', '100', 'awk', '-v', f'start={start_ts}', '-v', f'end={end_ts}', '-f', script_path]

    def send_batch(batch):
        if batch:
            send_callback(client_id, {
                'event': ws_protocol.PUSH_LOG_RANGE_BATCH,
                'data': {'stream_id': stream_id, 'lines': batch},
            })

    def send_done(truncated_flag):
        send_callback(client_id, {
            'event': ws_protocol.PUSH_LOG_RANGE_DONE,
            'data': {'stream_id': stream_id, 'truncated': truncated_flag},
        })

    total_emitted = 0
    for _day, filepath, is_gz in files_to_read:
        reader = None
        awk_proc = None
        reader_cmd = (['nice', '-n', '100', 'zcat', filepath] if is_gz else ['nice', '-n', '100', 'cat', filepath])
        cmd_str = ' '.join(reader_cmd) + ' | ' + ' '.join(awk_cmd)
        keyme.log.info(f"log_tail run_log_analyze executing: {cmd_str}")

        try:
            reader = subprocess.Popen(
                reader_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            awk_proc = subprocess.Popen(
                awk_cmd,
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            reader.stdout.close()
        except OSError as e:
            keyme.log.warning(f"log_tail run_log_analyze Popen failed path={filepath!r}: {e}")
            _terminate_and_wait(reader)
            _terminate_and_wait(awk_proc)
            send_done(False)
            return

        try:
            line_buffer = ''
            batch = []
            batch_bytes = 0
            proc = awk_proc
            while True:
                chunk = proc.stdout.read(_RANGE_READ_CHUNK_SIZE)
                if not chunk:
                    break
                line_buffer += chunk
                while '\n' in line_buffer:
                    line, line_buffer = line_buffer.split('\n', 1)
                    batch.append(line)
                    batch_bytes += len(line) + 1
                    total_emitted += 1
                    if batch_bytes >= _RANGE_BATCH_SIZE_BYTES:
                        send_batch(batch)
                        batch, batch_bytes = [], 0
            if batch:
                send_batch(batch)
        except (OSError, ValueError) as e:
            keyme.log.warning(f"log_tail run_log_analyze read failed path={filepath!r}: {e}")
        finally:
            _terminate_and_wait(proc)
            _terminate_and_wait(reader)
            if proc.stderr:
                proc.stderr.read()
            if reader.stderr:
                reader.stderr.read()

    send_done(False)
    keyme.log.info(f"log_tail run_log_analyze stream done stream_id={stream_id!r} emitted={total_emitted}")


def run_log_analyze(data, client_id, send_callback):
    """Run an allowlisted awk analysis on all.log for the given datetime range.
    data: start_datetime, end_datetime, analysis_id, stream_id?.
    Returns { success: True, data: { started, stream_id } } or { success: False, errors }.
    Batches and done are pushed via send_callback. No day limit (analyze only).
    """
    data = data or {}
    start_raw = data.get('start_datetime') or data.get('start_date')
    end_raw = data.get('end_datetime') or data.get('end_date')
    if not start_raw or not end_raw:
        return {'success': False, 'errors': ['Missing start_datetime and end_datetime']}
    start_dt_parsed = _parse_datetime(start_raw)
    end_dt_parsed = _parse_datetime(end_raw)
    if start_dt_parsed is None or end_dt_parsed is None:
        return {'success': False, 'errors': ['Invalid datetime; use YYYY-MM-DD or YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS']}
    if start_dt_parsed >= end_dt_parsed:
        return {'success': False, 'errors': ['start must be before end']}

    analysis_id = (data.get('analysis_id') or '').strip()
    if not analysis_id or analysis_id not in ANALYZE_SCRIPTS:
        return {'success': False, 'errors': [f'Invalid or unknown analysis_id; allowed: {list(ANALYZE_SCRIPTS.keys())}']}
    script_filename = ANALYZE_SCRIPTS[analysis_id]
    script_path = os.path.join(_LOG_ANALYZE_SCRIPTS_DIR, script_filename)
    if not os.path.isfile(script_path):
        return {'success': False, 'errors': [f'Script not found: {script_filename}']}

    start_dt = start_dt_parsed.date()
    end_dt = end_dt_parsed.date()
    start_ts = start_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')
    end_ts = end_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')

    log_dir = os.path.dirname(_ALL_LOG_PATH)
    base_name = 'all.log'
    files_to_read, last_archive_date = _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt)
    today = datetime.utcnow().date()
    if start_dt <= today and (last_archive_date is None or end_dt > last_archive_date):
        current_path = os.path.join(log_dir, base_name)
        if os.path.isfile(current_path):
            files_to_read.append((today, current_path, False))

    if not files_to_read:
        keyme.log.warning(f"log_tail run_log_analyze no files for range {start_dt}..{end_dt}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    stream_id = data.get('stream_id') or str(time.time())
    keyme.log.info(f"log_tail run_log_analyze analysis_id={analysis_id!r} stream_id={stream_id!r} files={len(files_to_read)}")

    thread = threading.Thread(
        target=_run_log_analyze_stream_thread,
        args=(client_id, send_callback, stream_id, files_to_read, start_ts, end_ts, script_path),
        daemon=True,
    )
    thread.start()

    return {'success': True, 'data': {'started': True, 'stream_id': stream_id}}
