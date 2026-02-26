# Log list and tail for control panel device. One active tail per client; allowlist-only paths.

import glob
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta

import pylib as keyme

from control_panel.python import ws_protocol

_LOG_DIR = '/var/log/keyme/processes'
# Archived process logs: {pname}.log-{YYYYMMDD}.gz e.g. ABILITIES_MANAGER.log-20251109.gz
_ALL_LOG_PATH = '/var/log/keyme/all.log'
_TMP_DIR = '/tmp'
_INITIAL_LINES_DEFAULT = 50
_INITIAL_LINES_MAX = 200
_ALL_LOG_RATE_LIMIT = 50  # max lines per second when tailing all.log
_RANGE_MAX_DAYS = 4
_RANGE_MAX_LINES_DEFAULT = 20000
_RANGE_MAX_LINES_CAP = 50000
_RANGE_READ_CHUNK_SIZE = 65536
_RANGE_BATCH_SIZE_BYTES = 120 * 1024  # 120 KB target payload per push

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
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=10,
        )
        if r.returncode == 0 and r.stdout:
            return r.stdout.rstrip('\n').split('\n')
        return []
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.warning(f"log_tail tail -n failed path={path} n={n}: {e}")
        return []


def _tail_follow_thread(client_id, path, send_callback, push_event, is_all_log):
    """Background thread: tail -f path, send each line via send_callback until stop_event is set."""
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
    keyme.log.info(f"log_tail follow thread exiting client_id={client_id} path={path}")


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


def _is_process_main_log(log_id, path):
    """True if log_id is a process main log under _LOG_DIR (not all, not stdout/stderr)."""
    if not log_id or not path:
        return False
    if not path.startswith(_LOG_DIR) or path == _ALL_LOG_PATH:
        return False
    if not log_id.startswith('process/') or '/' in log_id[len('process/'):]:
        return False
    return path.endswith('.log')


def _archived_files_overlapping_range(pname, start_dt, end_dt):
    """Return list of (archive_date, filepath, True) for archives whose period (d_prev, d_i] overlaps [start_dt, end_dt].
    Archive filename date is when the log was rotated (end of period); content is (previous_archive_date, this_archive_date].
    """
    pattern = os.path.join(_LOG_DIR, pname + '.log-*.gz')
    paths = glob.glob(pattern)
    parsed = []
    for filepath in paths:
        name = os.path.basename(filepath)
        if not name.endswith('.gz'):
            continue
        suffix = name[:-3]
        parts = suffix.split('-')
        if len(parts) < 2:
            continue
        yyyymmdd = parts[-1]
        try:
            archive_date = datetime.strptime(yyyymmdd, '%Y%m%d').date()
        except ValueError:
            continue
        parsed.append((archive_date, filepath))
    parsed.sort(key=lambda t: t[0])
    result = []
    for i, (d_i, filepath) in enumerate(parsed):
        d_prev = parsed[i - 1][0] if i > 0 else None
        # Period is (d_prev, d_i] (open left, closed right). Overlaps [start_dt, end_dt] iff d_prev < end_dt and d_i >= start_dt
        if (d_prev is None or d_prev < end_dt) and d_i >= start_dt:
            result.append((d_i, filepath, True))
    return result


def _get_log_range_stream_thread(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts):
    """Background thread: read each file, filter by timestamp (awk), send batches (~120 KB) and done via send_callback."""
    total_emitted = 0
    truncated = False
    start_time = time.time()
    # awk: first field $1 is the log timestamp; only output lines in [start_ts, end_ts)
    awk_condition = r'$1 >= start && $1 < end'

    def send_batch(batch):
        if not batch:
            return
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
        try:
            if is_gz:
                reader = subprocess.Popen(
                    ['zcat', filepath],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                )
            else:
                reader = subprocess.Popen(
                    ['cat', filepath],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    universal_newlines=True,
                )
            # Pipe through awk to only pass lines whose first field (timestamp) is in [start_ts, end_ts)
            awk_proc = subprocess.Popen(
                ['awk', '-v', f'start={start_ts}', '-v', f'end={end_ts}', awk_condition],
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
            reader.stdout.close()
            proc = awk_proc
            reader_stderr = reader.stderr
        except OSError as e:
            keyme.log.warning(f"log_tail get_log_range Popen failed path={filepath!r}: {e}")
            continue

        try:
            line_buffer = ''
            batch = []
            batch_bytes = 0

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
                        batch = []
                        batch_bytes = 0
                if truncated:
                    break

            if batch:
                send_batch(batch)
            if truncated:
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        proc.kill()
                    except OSError:
                        pass
                try:
                    reader.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    try:
                        reader.kill()
                    except OSError:
                        pass
                break
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        proc.kill()
                    except OSError:
                        pass
            try:
                reader.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    reader.kill()
                except OSError:
                    pass
            err = (proc.stderr.read() if proc.stderr else '') or (reader_stderr.read() if reader_stderr else '')
            if err and proc.returncode != 0:
                keyme.log.warning(f"log_tail get_log_range read failed path={filepath!r}: {err}")
        except (OSError, ValueError) as e:
            keyme.log.warning(f"log_tail get_log_range failed path={filepath!r}: {e}")
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    proc.kill()
                except OSError:
                    pass
            try:
                reader.terminate()
                reader.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    reader.kill()
                except OSError:
                    pass

    send_done(truncated)
    keyme.log.info(f"log_tail get_log_range stream done stream_id={stream_id!r} emitted={total_emitted} truncated={truncated}")


def get_log_range(data, client_id, send_callback):
    """Stream lines for a date range (process main logs only). Max 4 days per request.
    data: { log_id, start_date, end_date, max_lines?, stream_id? }.
    Returns immediately { started: True, stream_id, log_id, path }; batches and done are pushed via send_callback.
    On validation error returns { success: False, errors: [...] }.
    """
    keyme.log.info(f"log_tail get_log_range entry client_id={client_id!r} data_keys={list((data or {}).keys())}")
    _, allowlist = _build_log_list()
    log_id = (data or {}).get('log_id')
    if not log_id or log_id not in allowlist:
        keyme.log.warning(f"log_tail get_log_range invalid or missing log_id={log_id!r} allowlist_keys={list(allowlist.keys())}")
        return {'success': False, 'errors': ['Invalid or missing log_id']}
    path = allowlist[log_id]
    if not _is_process_main_log(log_id, path):
        keyme.log.warning(f"log_tail get_log_range not process main log log_id={log_id!r} path={path!r}")
        return {'success': False, 'errors': ['Only process main logs support date range']}

    start_s = (data or {}).get('start_date')
    end_s = (data or {}).get('end_date')
    if not start_s or not end_s:
        keyme.log.warning(f"log_tail get_log_range missing dates start_date={start_s!r} end_date={end_s!r}")
        return {'success': False, 'errors': ['Missing start_date or end_date']}
    # Normalize: allow "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS..." (take first 10 chars only)
    start_s = str(start_s).strip()[:10]
    end_s = str(end_s).strip()[:10]
    try:
        start_dt = datetime.strptime(start_s, '%Y-%m-%d').date()
        end_dt = datetime.strptime(end_s, '%Y-%m-%d').date()
    except ValueError as e:
        keyme.log.warning(f"log_tail get_log_range invalid date format start_s={start_s!r} end_s={end_s!r} err={e}")
        return {'success': False, 'errors': ['Invalid date format; use YYYY-MM-DD']}
    if start_dt > end_dt:
        keyme.log.warning(f"log_tail get_log_range start > end start_dt={start_dt} end_dt={end_dt}")
        return {'success': False, 'errors': ['start_date must be <= end_date']}
    if (end_dt - start_dt).days >= _RANGE_MAX_DAYS:
        keyme.log.warning(f"log_tail get_log_range range exceeds max days start_dt={start_dt} end_dt={end_dt} max_days={_RANGE_MAX_DAYS}")
        return {'success': False, 'errors': [f'Date range exceeds {_RANGE_MAX_DAYS} days']}

    keyme.log.info(f"log_tail get_log_range requested start_date={start_s} end_date={end_s} parsed start_dt={start_dt} end_dt={end_dt}")

    max_lines = data.get('max_lines', _RANGE_MAX_LINES_DEFAULT)
    try:
        max_lines = int(max_lines)
    except (TypeError, ValueError):
        max_lines = _RANGE_MAX_LINES_DEFAULT
    max_lines = max(1, min(max_lines, _RANGE_MAX_LINES_CAP))
    keyme.log.info(f"log_tail get_log_range max_lines={max_lines}")

    pname = log_id.replace('process/', '', 1)
    today = datetime.utcnow().date()
    keyme.log.info(f"log_tail get_log_range log_id={log_id!r} pname={pname!r} today={today} _LOG_DIR={_LOG_DIR!r}")

    # Archive filename date = when rotated (end of period). Content = (prev_archive_date, this_archive_date].
    files_to_read = _archived_files_overlapping_range(pname, start_dt, end_dt)
    if start_dt <= today <= end_dt:
        current_log_path = os.path.join(_LOG_DIR, pname + '.log')
        if os.path.isfile(current_log_path):
            files_to_read.append((today, current_log_path, False))
            keyme.log.debug(f"log_tail get_log_range including current .log path={current_log_path!r}")
    dates_with_data = [t[0].isoformat() for t in files_to_read]
    missing_dates = [] if files_to_read else [f"{start_dt.isoformat()}..{end_dt.isoformat()}"]
    keyme.log.info(f"log_tail get_log_range overlap selection: reading {len(files_to_read)} file(s) dates_with_data={dates_with_data}")
    for day_or_archive, filepath, _ in files_to_read:
        keyme.log.debug(f"log_tail get_log_range file day_or_archive={day_or_archive} path={filepath!r}")

    if not files_to_read:
        keyme.log.warning(f"log_tail get_log_range no files found for range start_dt={start_dt} end_dt={end_dt} missing_dates={missing_dates}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    # Timestamp bounds for awk filtering (log line first field is ISO timestamp e.g. 2026-02-22T14:44:16.257483-05:00)
    start_ts = f"{start_dt.isoformat()}T00:00:00"
    end_dt_exclusive = end_dt + timedelta(days=1)
    end_ts = f"{end_dt_exclusive.isoformat()}T00:00:00"
    keyme.log.info(f"log_tail get_log_range timestamp filter start_ts={start_ts!r} end_ts={end_ts!r} (exclusive)")

    stream_id = (data or {}).get('stream_id') or str(time.time())
    keyme.log.info(f"log_tail get_log_range starting stream stream_id={stream_id!r} client_id={client_id!r} file_count={len(files_to_read)}")

    thread = threading.Thread(
        target=_get_log_range_stream_thread,
        args=(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts),
        daemon=True,
    )
    thread.start()

    keyme.log.info(f"log_tail get_log_range success stream_id={stream_id!r} dates_with_data={dates_with_data} missing_dates={missing_dates}")
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
            'missing_dates': missing_dates,
        },
    }
