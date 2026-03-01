# Log list and tail for control panel device.
# One active tail per client; allowlist-only paths.
# Date-range fetch: process main logs and all.log; optional process filter for all.log.

import glob
import os
import re
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

# Log analyze: generic filter script (structured params -> -v pname, log_level, reg_message).
_LOG_ANALYZE_SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'log_analyze_scripts')
_LOG_FILTER_SCRIPT = 'log_filter.awk'

# Archived logs: {base_name}-{YYYYMMDD}.gz or {base_name}-{YYYYMMDD} (unarchived).
# Period covered by a file is (previous_archive_date, this_archive_date].

_client_tails = {}
_tails_lock = threading.Lock()


# CPU-heavy external commands run with nice so kiosk use is not impacted.
# TODO: think about activating this only when kiosk is in use
_NICE_LEVEL = '19'

def _nice_cmd(cmd):
    """Prepend nice -n 19 to a command list for low CPU priority."""
    return ['nice', '-n', _NICE_LEVEL] + list(cmd)


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


def _parse_range_datetime(data, max_days=None):
    """Parse start/end from data; validate. Returns (start_dt, end_dt, start_ts, end_ts) or (None, None, None, None, error_response)."""
    data = data or {}
    start_raw = data.get('start_datetime') or data.get('start_date')
    end_raw = data.get('end_datetime') or data.get('end_date')
    if not start_raw or not end_raw:
        return None, None, None, None, {'success': False, 'errors': ['Missing start_datetime and end_datetime (or start_date and end_date)']}
    start_dt_parsed = _parse_datetime(start_raw)
    end_dt_parsed = _parse_datetime(end_raw)
    if start_dt_parsed is None or end_dt_parsed is None:
        return None, None, None, None, {'success': False, 'errors': ['Invalid datetime; use YYYY-MM-DD or YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS']}
    if start_dt_parsed >= end_dt_parsed:
        return None, None, None, None, {'success': False, 'errors': ['start must be before end']}
    start_dt, end_dt = start_dt_parsed.date(), end_dt_parsed.date()
    if max_days is not None and (end_dt - start_dt).days >= max_days:
        return None, None, None, None, {'success': False, 'errors': [f'Date range exceeds {max_days} days']}
    return start_dt, end_dt, start_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S'), end_dt_parsed.strftime('%Y-%m-%dT%H:%M:%S'), None


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
        cmd = _nice_cmd(['tail', '-n', str(n), path])
        keyme.log.info(f"log_tail external_cmd={' '.join(cmd)!r}")
        r = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            timeout=10,
        )
        if r.returncode == 0 and r.stdout:
            lines = r.stdout.rstrip('\n').split('\n')
            keyme.log.info(f"log_tail tail -n result lines={len(lines)} bytes={len(r.stdout)} path={path!r}")
            return lines
        return []
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        keyme.log.warning(f"log_tail tail -n failed path={path}: {e}")
        return []


def _tail_follow_thread(client_id, path, send_callback, push_event, is_all_log):
    """Background: tail -f path, push lines until stop_event is set. Rate-limit for all.log."""
    try:
        cmd = _nice_cmd(['tail', '-f', path])
        keyme.log.info(f"log_tail external_cmd={' '.join(cmd)!r}")
        proc = subprocess.Popen(
            cmd,
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


def _log_files_for_range(log_dir, base_name, start_dt, end_dt):
    """Return list of (day, filepath, is_gz) for base_name and its archives overlapping [start_dt, end_dt]."""
    files_to_read, last_archive_date = _archived_files_overlapping_range(log_dir, base_name, start_dt, end_dt)
    today = datetime.utcnow().date()
    if start_dt <= today and (last_archive_date is None or end_dt > last_archive_date):
        current_path = os.path.join(log_dir, base_name)
        if os.path.isfile(current_path):
            files_to_read.append((today, current_path, False))
    return files_to_read


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
    process_list = process_filter or []
    awk_script = _awk_script_with_process_filter(process_list)
    procs_str = ','.join(_sanitize_awk_var(p).replace(',', '') for p in process_list) if process_list else ''
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
            reader_cmd = _nice_cmd(['zcat', filepath] if is_gz else ['cat', filepath])
            awk_args = _nice_cmd(['awk', '-v', f'start={start_ts}', '-v', f'end={end_ts}', '-v', f'procs={procs_str}', awk_script])
            keyme.log.info(f"log_tail get_log_range external_cmd_reader={' '.join(reader_cmd)!r} awk_args_count={len(awk_args)} file={filepath!r}")
            reader = subprocess.Popen(
                reader_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
            )
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
# AI log analysis: search_log + get_log_around_datetime (all.log only)
# -----------------------------------------------------------------------------

_SEARCH_LOG_MAX_DAYS = 4
_SEARCH_LOG_TIMEOUT_SEC = 120  # Keep in sync with cloud device_log_client.SEARCH_LOG_TIMEOUT
_LINES_BEFORE_CAP = 2000
_LINES_AFTER_CAP = 20000
_LOG_AROUND_CHUNK_SIZE = 8192
_GREP_FIRST_MATCH = ['-a', '-m', '1']  # treat as text, stop at first match

# Leading chars to strip from grep -a lines (binary/control); keep \t\n\r and space for .strip()
_LEADING_BINARY_CHARS = ''.join(
    chr(i) for i in list(range(9)) + list(range(11, 13)) + list(range(14, 32)) + [127]
)


def _extract_timestamp_from_log_line(line):
    """First field (ISO8601) from log line, or None if not parseable."""
    if not line or not isinstance(line, str):
        return None
    # Strip leading binary/control junk so grep -a lines still parse; then strip whitespace
    line = line.lstrip(_LEADING_BINARY_CHARS).replace('\x00', '').strip()
    if not line:
        return None
    parts = line.split(None, 1)
    first = parts[0] if parts else None
    if not first or len(first) < 10 or not first[:4].isdigit():
        return None
    return first


def _resolve_search_date_range(data):
    """Parse date_hint_* from data. Returns (start_dt, end_dt) or (None, None, error_response)."""
    hint_start = data.get('date_hint_start') or data.get('date_hint_end')
    hint_end = data.get('date_hint_end') or data.get('date_hint_start')
    if hint_start and hint_end:
        start_dt, end_dt, _s, _e, err = _parse_range_datetime(
            {'start_datetime': hint_start, 'end_datetime': hint_end},
            max_days=_SEARCH_LOG_MAX_DAYS,
        )
        if err is not None:
            return None, None, err
        return start_dt, end_dt, None
    if hint_start or hint_end:
        dt_parsed = _parse_datetime(hint_start or hint_end)
        if dt_parsed is None:
            return None, None, {'success': False, 'errors': ['Invalid date_hint; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS']}
        d = dt_parsed.date()
        return d, d, None
    end_dt = datetime.utcnow().date()
    return end_dt - timedelta(days=2), end_dt, None


def _run_grep_first_match(filepath, is_gz, query, timeout_sec):
    """Run zcat|grep or grep -F for first match. Returns first line of stdout or None."""
    reader = None
    grep_proc = None
    try:
        if is_gz:
            reader = subprocess.Popen(
                _nice_cmd(['zcat', filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + _GREP_FIRST_MATCH + ['-F', query]),
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            reader.stdout.close()
        else:
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + _GREP_FIRST_MATCH + ['-F', query, filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
        out, _ = grep_proc.communicate(timeout=timeout_sec)
        if out:
            line = out.strip().split('\n')[0]
            keyme.log.info(f"log_tail search_log result path={filepath!r} bytes={len(out)}")
            return line.strip()
        return None
    except subprocess.TimeoutExpired:
        return None
    except (OSError, ValueError) as e:
        keyme.log.warning(f"log_tail search_log path={filepath!r}: {e}")
        return None
    finally:
        _terminate_and_wait(grep_proc)
        _terminate_and_wait(reader)


def _run_grep_first_match_regex(filepath, is_gz, pattern, timeout_sec):
    """Run zcat|grep or grep -E for first match. Returns first line of stdout or None."""
    reader = None
    grep_proc = None
    try:
        if is_gz:
            reader = subprocess.Popen(
                _nice_cmd(['zcat', filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + _GREP_FIRST_MATCH + ['-E', pattern]),
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            reader.stdout.close()
        else:
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + _GREP_FIRST_MATCH + ['-E', pattern, filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
        out, _ = grep_proc.communicate(timeout=timeout_sec)
        if out:
            line = out.strip().split('\n')[0]
            keyme.log.info(f"log_tail search_log result path={filepath!r} bytes={len(out)}")
            return line.strip()
        return None
    except subprocess.TimeoutExpired:
        return None
    except (OSError, ValueError) as e:
        keyme.log.warning(f"log_tail search_log path={filepath!r}: {e}")
        return None
    finally:
        _terminate_and_wait(grep_proc)
        _terminate_and_wait(reader)


def search_log(data):
    """Find exact datetime when query or queries appear in log. data: log_id, query or queries, date_hint_*."""
    data = data or {}
    keyme.log.info(
        f"log_tail search_log request log_id={data.get('log_id')!r} query={data.get('query')!r} \
            queries={data.get('queries')!r} date_hint_start={data.get('date_hint_start')!r} \
                date_hint_end={data.get('date_hint_end')!r}"
    )
    _, allowlist = _build_log_list()
    log_id = (data.get('log_id') or 'all').strip()
    if log_id != 'all' or log_id not in allowlist:
        keyme.log.warning(f"log_tail search_log rejected log_id={log_id!r} allowlist={allowlist}")
        return {'success': False, 'errors': ['search_log only supports log_id "all"']}
    # Prefer queries (list); fall back to single query
    queries_raw = data.get('queries')
    query = (data.get('query') or '').strip()
    if queries_raw is not None:
        queries = [str(q).strip() for q in queries_raw if q is not None and str(q).strip()]
    else:
        queries = [query] if query else []
    if not queries:
        keyme.log.warning("log_tail search_log missing query/queries")
        return {'success': False, 'errors': ['Missing query or queries']}

    start_dt, end_dt, err = _resolve_search_date_range(data)
    if err is not None:
        keyme.log.warning(f"log_tail search_log date range error: {err}")
        return err
    keyme.log.info(f"log_tail search_log date range start_dt={start_dt} end_dt={end_dt}")

    log_dir = os.path.dirname(_ALL_LOG_PATH)
    files_to_read = _log_files_for_range(log_dir, 'all.log', start_dt, end_dt)
    if not files_to_read:
        keyme.log.warning(f"log_tail search_log no log files for range log_dir={log_dir!r} start={start_dt} end={end_dt}")
        return {'success': False, 'errors': ['No log files found for the selected range']}
    keyme.log.info(
        f"log_tail search_log files_to_read={[(d, fp, gz) for d, fp, gz in files_to_read]} (count={len(files_to_read)})"
    )

    use_regex = len(queries) > 1
    pattern = '|'.join(re.escape(q) for q in queries) if use_regex else None
    single_query = queries[0] if queries else ''
    _pattern_str = (pattern[:80] + '...') if pattern and len(pattern) > 80 else pattern
    _query_str = (single_query[:80] + '...') if single_query and len(single_query) > 80 else single_query
    keyme.log.info(
        f"log_tail search_log use_regex={use_regex} queries_count={len(queries)} \
            pattern={_pattern_str!r} single_query={_query_str!r}"
    )

    start_time = time.time()
    for idx, (_day, filepath, is_gz) in enumerate(files_to_read):
        if time.time() - start_time > _SEARCH_LOG_TIMEOUT_SEC:
            keyme.log.warning(f"log_tail search_log timeout after {idx} files")
            return {'success': False, 'errors': ['Search timed out']}
        timeout_remaining = max(1, _SEARCH_LOG_TIMEOUT_SEC - int(time.time() - start_time))
        keyme.log.info(f"log_tail search_log trying file {idx + 1}/{len(files_to_read)} \
            path={filepath!r} is_gz={is_gz}")
        line = (
            _run_grep_first_match_regex(filepath, is_gz, pattern, timeout_remaining)
            if use_regex
            else _run_grep_first_match(filepath, is_gz, single_query, timeout_remaining)
        )
        if line:
            line_clean = line.lstrip(_LEADING_BINARY_CHARS).replace('\x00', '').strip()
            ts = _extract_timestamp_from_log_line(line_clean)
            if ts:
                keyme.log.info(f"log_tail search_log found datetime={ts} in file={filepath!r}")
                return {'success': True, 'data': {'datetime': ts, 'line': line_clean}}
            keyme.log.debug(f"log_tail search_log match had no valid timestamp, continuing: {line!r}")
        else:
            keyme.log.debug(f"log_tail search_log no match in file={filepath!r}")

    keyme.log.warning(
        f"log_tail search_log not found after searching {len(files_to_read)} files \
            queries={queries} start_dt={start_dt} end_dt={end_dt}"
    )
    return {'success': False, 'errors': ['Query not found in logs for the selected range']}


def _stream_grep_context_around(filepath, is_gz, lines_before, lines_after, pattern, chunk_size, on_chunk):
    """Run grep -B -A on file (zcat|grep or grep), stream stdout via on_chunk(chunk). Returns total_bytes or 0 on failure."""
    reader = None
    grep_proc = None
    try:
        grep_args = _GREP_FIRST_MATCH + ['-B', str(lines_before), '-A', str(lines_after), '-E', pattern]
        if is_gz:
            reader = subprocess.Popen(
                _nice_cmd(['zcat', filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + grep_args),
                stdin=reader.stdout,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
            reader.stdout.close()
        else:
            grep_proc = subprocess.Popen(
                _nice_cmd(['grep'] + grep_args + [filepath]),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                universal_newlines=True,
            )
        total = 0
        while True:
            chunk = grep_proc.stdout.read(chunk_size)
            if not chunk:
                break
            total += len(chunk)
            on_chunk(chunk)
        return total
    except (OSError, ValueError) as e:
        keyme.log.warning(f"log_tail get_log_around path={filepath!r}: {e}")
        return 0
    finally:
        _terminate_and_wait(grep_proc)
        _terminate_and_wait(reader)


def _get_log_around_stream_thread(client_id, send_callback, stream_id, files_to_read, lines_before, lines_after, central_str):
    """Background: stream grep -B -A per file in chunks; first file with output wins."""
    pattern = '^' + re.escape(central_str)

    def send_chunk(chunk):
        if chunk:
            send_callback(client_id, {'event': ws_protocol.PUSH_LOG_AROUND_BATCH, 'data': {'stream_id': stream_id, 'chunk': chunk}})

    def send_done():
        send_callback(client_id, {'event': ws_protocol.PUSH_LOG_AROUND_DONE, 'data': {'stream_id': stream_id}})

    for _day, filepath, is_gz in files_to_read:
        keyme.log.info(f"log_tail get_log_around file={filepath!r} is_gz={is_gz}")
        total = _stream_grep_context_around(
            filepath, is_gz, lines_before, lines_after, pattern, _LOG_AROUND_CHUNK_SIZE, send_chunk
        )
        if total > 0:
            keyme.log.info(f"log_tail get_log_around done stream_id={stream_id!r} file={filepath!r} total_bytes={total}")
            send_done()
            return
    send_done()
    keyme.log.info(f"log_tail get_log_around done stream_id={stream_id!r} no match")


def _clamp_int(val, default, cap):
    try:
        return max(0, min(int(val), cap))
    except (TypeError, ValueError):
        return default


def get_log_around_datetime(data, client_id, send_callback):
    """Stream lines_before + match + lines_after around central_datetime. Returns { started, stream_id } or errors."""
    data = data or {}
    if (data.get('log_id') or 'all').strip() != 'all':
        return {'success': False, 'errors': ['get_log_around_datetime only supports log_id "all"']}

    central_raw = (data.get('central_datetime') or '').strip()
    if not central_raw:
        return {'success': False, 'errors': ['Missing central_datetime']}
    central_ts = _parse_datetime(central_raw)
    if central_ts is None:
        return {'success': False, 'errors': ['Invalid central_datetime; use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS']}
    central_str = central_ts.strftime('%Y-%m-%dT%H:%M:%S')
    central_date = central_ts.date()

    lines_before = _clamp_int(data.get('lines_before'), 1000, _LINES_BEFORE_CAP)
    lines_after = _clamp_int(data.get('lines_after'), 10000, _LINES_AFTER_CAP)

    log_dir = os.path.dirname(_ALL_LOG_PATH)
    start_dt = central_date - timedelta(days=1)
    end_dt = central_date + timedelta(days=1)
    files_to_read = _log_files_for_range(log_dir, 'all.log', start_dt, end_dt)
    if not files_to_read:
        return {'success': False, 'errors': ['No log files found for the central datetime']}

    stream_id = data.get('stream_id') or str(time.time())
    thread = threading.Thread(
        target=_get_log_around_stream_thread,
        args=(client_id, send_callback, stream_id, files_to_read, lines_before, lines_after, central_str),
        daemon=True,
    )
    thread.start()
    return {'success': True, 'data': {'started': True, 'stream_id': stream_id}}


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

    start_dt, end_dt, start_ts, end_ts, err = _parse_range_datetime(data, max_days=_RANGE_MAX_DAYS)
    if err is not None:
        return err

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

    files_to_read = _log_files_for_range(log_dir, base_name, start_dt, end_dt)
    if not files_to_read:
        keyme.log.warning(f"log_tail get_log_range no files for range {start_dt}..{end_dt}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    process_filter = None
    if log_id == 'all':
        pf = data.get('process_filter')
        process_filter = [str(p).strip() for p in (pf if isinstance(pf, (list, tuple)) else []) if str(p).strip()]
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
        },
    }


# -----------------------------------------------------------------------------
# Log analyze: generic filter (structured params -> awk -v), per-hour count, one push
# -----------------------------------------------------------------------------

def _sanitize_awk_var(s):
    """Remove chars that break awk -v (e.g. newline, null, =). Allow backslash for regex."""
    if s is None:
        return ''
    s = str(s).strip()
    for c in ('\x00', '\n', '\r', '='):
        s = s.replace(c, '')
    return s


def _parse_analyze_params(data):
    """Parse and validate run_log_analyze payload. Returns (params_dict, None) or (None, error_response)."""
    data = data or {}
    start_dt, end_dt, start_ts, end_ts, err = _parse_range_datetime(data)
    if err is not None:
        return None, err

    processes = data.get('processes')
    processes = [str(p).strip() for p in (processes if isinstance(processes, (list, tuple)) else []) if str(p).strip()]
    levels = data.get('levels')
    levels = [str(l).strip().lower() for l in (levels if isinstance(levels, (list, tuple)) else []) if str(l).strip()]
    message_regex = _sanitize_awk_var((data.get('message_regex') or '').strip())

    combine_raw = (data.get('combine_mode') or 'AND_OR').strip().upper().replace('-', '_')
    combine = 'AND' if combine_raw == 'AND' else ('AND_OR' if combine_raw == 'AND_OR' else 'OR')

    return {
        'start_dt': start_dt,
        'end_dt': end_dt,
        'start_ts': start_ts,
        'end_ts': end_ts,
        'pname': '|'.join(processes) if processes else '',
        'log_level': '|'.join(f'<{l}>' for l in levels) if levels else '',
        'reg_message': message_regex,
        'combine': combine,
    }, None


def _merge_awk_line_into_buckets(buckets, line):
    """Parse one line of awk output (hour\\tprocess\\tcount) and merge into buckets. No-op if invalid."""
    line = (line or '').strip()
    if not line:
        return
    parts = line.split('\t')
    if len(parts) < 3:
        return
    hour_s = parts[0].strip()
    process_s = parts[1].strip()
    try:
        count_n = int(parts[2].strip())
    except ValueError:
        return
    if hour_s not in buckets:
        buckets[hour_s] = {'count': 0, 'byProcess': {}}
    buckets[hour_s]['count'] += count_n
    if process_s:
        if process_s not in buckets[hour_s]['byProcess']:
            buckets[hour_s]['byProcess'][process_s] = {'count': 0}
        buckets[hour_s]['byProcess'][process_s]['count'] += count_n


def _run_log_analyze_filter_thread(client_id, send_callback, stream_id, files_to_read, start_ts, end_ts, pname, log_level, reg_message, combine):
    """Background: for each file zcat|awk, parse hour\\tprocess\\tcount; merge; send one push."""
    script_path = os.path.join(_LOG_ANALYZE_SCRIPTS_DIR, _LOG_FILTER_SCRIPT)
    if not os.path.isfile(script_path):
        keyme.log.warning(f"log_tail run_log_analyze script not found: {script_path}")
        send_callback(client_id, {
            'event': ws_protocol.PUSH_LOG_ANALYZE_RESULT,
            'data': {'stream_id': stream_id, 'buckets': {}},
        })
        return

    awk_cmd = _nice_cmd([
        'awk',
        '-v', f'start={start_ts}', '-v', f'end={end_ts}',
        '-v', f'pname={pname}', '-v', f'log_level={log_level}', '-v', f'reg_message={reg_message}',
        '-v', f'combine={combine}',
        '-f', script_path,
    ])
    buckets = {}

    for _day, filepath, is_gz in files_to_read:
        reader_cmd = _nice_cmd(['zcat', filepath] if is_gz else ['cat', filepath])
        keyme.log.info(f"log_tail run_log_analyze external_cmd_reader={' '.join(reader_cmd)!r} file={filepath!r}")
        reader = awk_proc = None
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
            out, _ = awk_proc.communicate(timeout=300)
            out_size = len(out) if out else 0
            keyme.log.info(f"log_tail run_log_analyze result bytes={out_size} file={filepath!r}")
            for line in (out or '').split('\n'):
                _merge_awk_line_into_buckets(buckets, line)
        except (OSError, subprocess.TimeoutExpired) as e:
            keyme.log.warning(f"log_tail run_log_analyze file {filepath}: {e}")
        finally:
            _terminate_and_wait(awk_proc)
            _terminate_and_wait(reader)

    send_callback(client_id, {
        'event': ws_protocol.PUSH_LOG_ANALYZE_RESULT,
        'data': {'stream_id': stream_id, 'buckets': buckets},
    })
    keyme.log.info(f"log_tail run_log_analyze done stream_id={stream_id!r} buckets={len(buckets)}")


def run_log_analyze(data, client_id, send_callback):
    """Run generic log filter on all.log for the given datetime range.
    data: start_datetime, end_datetime, processes?, levels?, message_regex?, stream_id?.
    Returns { success: True, data: { started, stream_id } } or { success: False, errors }.
    Result pushed via send_callback as log_analyze_result with buckets (count, byProcess).
    """
    params, err = _parse_analyze_params(data)
    if err is not None:
        return err

    log_dir = os.path.dirname(_ALL_LOG_PATH)
    files_to_read = _log_files_for_range(log_dir, 'all.log', params['start_dt'], params['end_dt'])
    if not files_to_read:
        keyme.log.warning(f"log_tail run_log_analyze no files for range {params['start_dt']}..{params['end_dt']}")
        return {'success': False, 'errors': ['No log files found for the selected range']}

    stream_id = (data or {}).get('stream_id') or str(time.time())
    keyme.log.info(f"log_tail run_log_analyze stream_id={stream_id!r} files={len(files_to_read)}")

    thread = threading.Thread(
        target=_run_log_analyze_filter_thread,
        args=(
            client_id, send_callback, stream_id, files_to_read,
            params['start_ts'], params['end_ts'],
            params['pname'], params['log_level'], params['reg_message'],
            params['combine'],
        ),
        daemon=True,
    )
    thread.start()

    return {'success': True, 'data': {'started': True, 'stream_id': stream_id}}
