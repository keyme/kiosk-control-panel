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


def _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt):
    """Return (list of (archive_date, filepath, is_gz), last_archive_date) for dated logs whose period (d_prev, d_i] overlaps [start_dt, end_dt].
    Filename date is when the log was rotated (end of period); content is (previous_date, this_date].
    Includes both archived ({base_name}-{YYYYMMDD}.gz) and unarchived dated ({base_name}-{YYYYMMDD}) files.
    When both exist for the same date, prefer .gz (archived).
    last_archive_date is the max dated file (end of last rotated period); current log covers (last_archive_date, now].
    log_dir: directory for glob (e.g. _LOG_DIR for process logs, or dirname(_ALL_LOG_PATH) for all.log).
    base_name: e.g. 'CUTTER.log' or 'all.log'.
    """
    pattern = os.path.join(log_dir, base_name + '-*')
    paths = glob.glob(pattern)
    # date -> (filepath, is_gz); prefer .gz when same date exists as both .gz and plain
    by_date = {}
    for filepath in paths:
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
        if archive_date not in by_date or (by_date[archive_date][1] is False and is_gz):
            by_date[archive_date] = (filepath, is_gz)
    parsed = sorted(by_date.items(), key=lambda t: t[0])
    last_archive_date = parsed[-1][0] if parsed else None
    result = []
    for i, (d_i, (filepath, is_gz)) in enumerate(parsed):
        d_prev = parsed[i - 1][0] if i > 0 else None
        # Period is (d_prev, d_i] (open left, closed right). Overlaps [start_dt, end_dt] iff d_prev < end_dt and d_i >= start_dt
        if (d_prev is None or d_prev < end_dt) and d_i >= start_dt:
            result.append((d_i, filepath, is_gz))
    return result, last_archive_date


def _get_log_range_stream_thread(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts, process_filter=None):
    """Background thread: read each file, filter by timestamp (awk), optionally by process (KEYMELOG|NAME[), send batches via send_callback.
    process_filter: optional list of process names; only used for all.log. Lines must match KEYMELOG|NAME[ for one of them.
    """
    total_emitted = 0
    truncated = False
    start_time = time.time()
    process_list = process_filter if process_filter else []
    if process_list:
        procs_str = ','.join(str(p).strip() for p in process_list if str(p).strip())
        # awk: timestamp in range and (no filter or line contains KEYMELOG|PROCESS[)
        awk_script = (
            r'BEGIN { n = split(procs, p, ",") } '
            r'$1 >= start && $1 < end { '
            r'if (n == 0) { print; next } '
            r'for (i = 1; i <= n; i++) if (index($0, "KEYMELOG|" p[i] "[") > 0) { print; next } '
            r'}'
        )
    else:
        procs_str = ''
        awk_script = r'$1 >= start && $1 < end'

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
            # Pipe through awk: timestamp in [start_ts, end_ts) and optionally process match (KEYMELOG|NAME[)
            awk_args = ['awk', '-v', f'start={start_ts}', '-v', f'end={end_ts}', '-v', f'procs={procs_str}', awk_script]
            awk_proc = subprocess.Popen(
                awk_args,
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
    """Stream lines for a date range (process main logs or all.log). Max 4 days per request.
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

    data = data or {}
    start_raw = data.get('start_datetime') or data.get('start_date')
    end_raw = data.get('end_datetime') or data.get('end_date')
    if not start_raw or not end_raw:
        keyme.log.warning(f"log_tail get_log_range missing start/end start_raw={start_raw!r} end_raw={end_raw!r}")
        return {'success': False, 'errors': ['Missing start_datetime and end_datetime (or start_date and end_date)']}

    def parse_datetime(s):
        s = str(s).strip()
        if not s:
            return None
        for fmt, size in (('%Y-%m-%dT%H:%M:%S', 19), ('%Y-%m-%dT%H:%M', 16), ('%Y-%m-%d', 10)):
            if len(s) >= size:
                try:
                    return datetime.strptime(s[:size], fmt)
                except ValueError:
                    pass
        return None

    start_dt_parsed = parse_datetime(start_raw)
    end_dt_parsed = parse_datetime(end_raw)
    if start_dt_parsed is None or end_dt_parsed is None:
        keyme.log.warning(f"log_tail get_log_range invalid datetime start_raw={start_raw!r} end_raw={end_raw!r}")
        return {'success': False, 'errors': ['Invalid datetime format; use YYYY-MM-DD or YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS']}
    start_dt = start_dt_parsed.date()
    end_dt = end_dt_parsed.date()
    if start_dt_parsed >= end_dt_parsed:
        keyme.log.warning(f"log_tail get_log_range start >= end start={start_dt_parsed} end={end_dt_parsed}")
        return {'success': False, 'errors': ['start must be before end']}
    if (end_dt - start_dt).days >= _RANGE_MAX_DAYS:
        keyme.log.warning(f"log_tail get_log_range range exceeds max days start_dt={start_dt} end_dt={end_dt} max_days={_RANGE_MAX_DAYS}")
        return {'success': False, 'errors': [f'Date range exceeds {_RANGE_MAX_DAYS} days']}

    start_ts = start_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')
    end_ts = end_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S')
    keyme.log.info(f"log_tail get_log_range requested start_ts={start_ts!r} end_ts={end_ts!r} start_dt={start_dt} end_dt={end_dt}")

    max_lines = data.get('max_lines', _RANGE_MAX_LINES_DEFAULT)
    try:
        max_lines = int(max_lines)
    except (TypeError, ValueError):
        max_lines = _RANGE_MAX_LINES_DEFAULT
    max_lines = max(1, min(max_lines, _RANGE_MAX_LINES_CAP))
    keyme.log.info(f"log_tail get_log_range max_lines={max_lines}")

    today = datetime.utcnow().date()
    if log_id == 'all':
        log_dir = os.path.dirname(_ALL_LOG_PATH)
        base_name = 'all.log'
    else:
        pname = log_id.replace('process/', '', 1)
        log_dir = _LOG_DIR
        base_name = pname + '.log'
    keyme.log.info(f"log_tail get_log_range log_id={log_id!r} log_dir={log_dir!r} base_name={base_name!r} today={today}")

    # Archive filename date = when rotated (end of period). Content = (prev_archive_date, this_archive_date].
    files_to_read, last_archive_date = _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt)
    # Current log covers (last_archive_date, now]. Include it when [start_dt, end_dt] overlaps that period.
    if start_dt <= today and (last_archive_date is None or end_dt > last_archive_date):
        current_log_path = os.path.join(log_dir, base_name)
        if os.path.isfile(current_log_path):
            files_to_read.append((today, current_log_path, False))
            keyme.log.debug(f"log_tail get_log_range including current .log path={current_log_path!r} (overlaps (last_archive={last_archive_date}, now])")
    dates_with_data = [t[0].isoformat() for t in files_to_read]
    missing_dates = [] if files_to_read else [f"{start_dt.isoformat()}..{end_dt.isoformat()}"]
    keyme.log.info(f"log_tail get_log_range overlap selection: reading {len(files_to_read)} file(s) dates_with_data={dates_with_data}")
    for day_or_archive, filepath, _ in files_to_read:
        keyme.log.debug(f"log_tail get_log_range file day_or_archive={day_or_archive} path={filepath!r}")

    if not files_to_read:
        keyme.log.warning(f"log_tail get_log_range no files found for range start_dt={start_dt} end_dt={end_dt} missing_dates={missing_dates}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    # start_ts/end_ts already set above from parsed datetime; awk uses $1 >= start_ts && $1 < end_ts (exclusive end)
    keyme.log.info(f"log_tail get_log_range timestamp filter start_ts={start_ts!r} end_ts={end_ts!r} (exclusive)")

    stream_id = (data or {}).get('stream_id') or str(time.time())
    process_filter = None
    if log_id == 'all':
        pf = data.get('process_filter')
        if pf is not None and (isinstance(pf, (list, tuple)) and len(pf) > 0):
            process_filter = [str(p).strip() for p in pf if str(p).strip()]
            keyme.log.info(f"log_tail get_log_range all.log process_filter={process_filter}")
    keyme.log.info(f"log_tail get_log_range starting stream stream_id={stream_id!r} client_id={client_id!r} file_count={len(files_to_read)}")

    thread = threading.Thread(
        target=_get_log_range_stream_thread,
        args=(client_id, send_callback, stream_id, files_to_read, max_lines, start_ts, end_ts, process_filter),
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
