# Wellness check: reimplementation of tmp_wellness_check.sh logic for the control panel UI.
# Report-only (no restarts). Uses same thresholds and log paths as the reference script.

from __future__ import absolute_import, division, print_function

import glob
import json
import os
import re
import subprocess
import sys

import pylib as keyme

_KIOSK = getattr(keyme.config, 'PATH', None) or '/kiosk'
_LOG_DIR = '/var/log/keyme/processes'
_METRICS_FILES = [
    os.path.join(_KIOSK, 'config', 'autocal', 'connectivity_metrics.json'),
    os.path.join(_KIOSK, 'autocal', 'config', 'connectivity_metrics.json'),
]


def _find_log_files(base):
    """Return [rotated_path?, main_path] for base e.g. 'DEVICE_DIRECTOR.log'."""
    out = []
    pat = os.path.join(_LOG_DIR, base + '-2*')
    candidates = [p for p in glob.glob(pat) if p and not (
        p.endswith('.gz') or '.tar.gz' in p)]
    if candidates:
        candidates.sort(key=os.path.getmtime, reverse=True)
        out.append(candidates[0])
    main_log = os.path.join(_LOG_DIR, base)
    if os.path.isfile(main_log):
        out.append(main_log)
    return out


def _count_log_occurrences(base, pattern):
    """Count grep -c for pattern across main + rotated logs."""
    total = 0
    for path in _find_log_files(base):
        try:
            with open(path, 'r', errors='ignore') as f:
                for line in f:
                    if pattern in line:
                        total += 1
        except (OSError, IOError):
            pass
    return total


def _read_log_lines(base, pattern):
    """Yield lines matching pattern from main + rotated logs."""
    for path in _find_log_files(base):
        try:
            with open(path, 'r', errors='ignore') as f:
                for line in f:
                    if pattern in line:
                        yield line.rstrip('\n')
        except (OSError, IOError):
            pass


def _run_cmd(cmd, timeout=30, cwd=None):
    """Run cmd (list or str for shell=True), return (stdout, stderr)."""
    try:
        if isinstance(cmd, str):
            r = subprocess.run(
                cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=timeout, cwd=cwd or _KIOSK)
        else:
            r = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=timeout, cwd=cwd or _KIOSK)
        return (r.stdout or '', r.stderr or '')
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return ('', 'command failed or timed out')


def _software_version():
    summary = 'Software: Unknown'
    detail_lines = []
    try:
        out, _ = _run_cmd(['git', 'status'], timeout=10, cwd=_KIOSK)
        if not out.strip():
            summary = 'Software: Cannot determine git status'
            return summary, '\n'.join(detail_lines) if detail_lines else summary
        m = re.search(r'HEAD detached at (\S+)', out)
        if not m:
            summary = 'Software: Not in detached HEAD'
            return summary, out.strip() or summary
        current = m.group(1)
        detail_lines.append(out.strip())
        if current.startswith('production_'):
            tags, _ = _run_cmd(
                "git tag -l 'production_*' 2>/dev/null | sort -r", timeout=10, cwd=_KIOSK)
            latest = (tags.splitlines() or [''])[0].strip()
            if latest and latest == current:
                summary = 'Software: At latest production (%s)' % current
            else:
                summary = 'Software: Not latest production (current: %s, latest: %s)' % (
                    current, latest or '?')
        elif current.startswith('canary_'):
            tags, _ = _run_cmd(
                "git tag -l 'canary_*' 2>/dev/null | sort -r", timeout=10, cwd=_KIOSK)
            latest = (tags.splitlines() or [''])[0].strip()
            if latest and latest == current:
                summary = 'Software: At latest canary (%s)' % current
            else:
                summary = 'Software: Not latest canary (current: %s, latest: %s)' % (
                    current, latest or '?')
        else:
            summary = 'Software: Version %s (experiment)' % current
        detail_lines.append(summary)
    except Exception:
        pass
    return summary, '\n'.join(detail_lines) if detail_lines else summary


def _speedtest():
    summary = 'Internet Speed: Unknown'
    detail = ''
    carrier = 'Unknown'
    modem = 'Unknown'
    out = ''
    for mod, cmd in [
        ('speedtest-cli', 'speedtest-cli --simple --secure 2>&1'),
        ('speedtest', 'speedtest --accept-license --accept-gdpr --simple --secure 2>&1'),
    ]:
        out, err = _run_cmd(cmd, timeout=120)
        raw = (out or '').strip() or (err or '').strip()
        if not raw:
            continue
        dl = ul = None
        for line in raw.splitlines():
            if line.startswith('Download:'):
                try:
                    dl = float(line.split()[1])
                except (IndexError, ValueError):
                    pass
            elif line.startswith('Upload:'):
                try:
                    ul = float(line.split()[1])
                except (IndexError, ValueError):
                    pass
        if dl is not None and ul is not None:
            if dl < 2 and ul < 2:
                summary = 'Internet Speed: Poor (Down: %s Mbps, Up: %s Mbps)' % (dl, ul)
            elif dl < 5 or ul < 5:
                summary = 'Internet Speed: Average (Down: %s Mbps, Up: %s Mbps)' % (dl, ul)
            else:
                summary = 'Internet Speed: Good (Down: %s Mbps, Up: %s Mbps)' % (dl, ul)
            detail = raw
            break
        elif mod == 'speedtest':
            summary = 'Internet Speed: no results (speedtest failed)'
            detail = raw or 'No output'
            break
    if not detail and 'speedtest' not in (out or ''):
        summary = 'Internet Speed: no speedtest binary found'

    for fp in _METRICS_FILES:
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, 'r') as f:
                j = json.load(f)
            carrier = j.get('carrier') or carrier
            modem = j.get('model') or modem
        except Exception:
            pass
    _cfg = os.path.join(_KIOSK, 'scripts', 'config.py')
    try:
        out, _ = _run_cmd(
            [sys.executable, _cfg, 'autocal/connectivity_metrics', 'carrier', '--json'], timeout=5)
        v = (out or '').strip().strip('"')
        if v and v != 'null':
            carrier = v
    except Exception:
        pass
    try:
        out, _ = _run_cmd(
            [sys.executable, _cfg, 'autocal/connectivity_metrics', 'model', '--json'], timeout=5)
        v = (out or '').strip().strip('"')
        if v and v != 'null':
            modem = v
    except Exception:
        pass

    extra = '   - Carrier: %s\n   - Modem: %s' % (carrier, modem)
    if detail:
        detail = detail + '\n\n' + extra
    else:
        detail = extra
    return summary, detail, carrier, modem


def _signal():
    summary = 'Signal: Cannot determine'
    detail = ''
    rssi = sinr = None
    for fp in _METRICS_FILES:
        if not os.path.isfile(fp):
            continue
        try:
            with open(fp, 'r') as f:
                j = json.load(f)
            rssi = j.get('rssi_7day_median') if j.get('rssi_7day_median') is not None else j.get('rssi_median')
            sinr = j.get('sinr_7day_median') if j.get('sinr_7day_median') is not None else j.get('sinr_median')
            if rssi is not None and sinr is not None:
                break
        except Exception:
            pass
    if rssi is None or sinr is None:
        return summary, 'Signal data unavailable.'
    try:
        rssi = float(rssi)
        sinr = float(sinr)
    except (TypeError, ValueError):
        return summary, 'Invalid signal data.'
    r_ok = rssi >= -70
    r_avg = rssi >= -85
    s_ok = sinr >= 20
    s_avg = sinr >= 13
    r_status = 'Good' if r_ok else ('Average' if r_avg else 'Poor')
    s_status = 'Good' if s_ok else ('Average' if s_avg else 'Poor')
    detail = 'RSSI Median: %s dBm -> %s\nSINR Median: %s dB -> %s' % (rssi, r_status, sinr, s_status)
    if not r_avg and not s_avg:
        overall = 'Poor'
    elif not r_ok or not s_ok:
        overall = 'Average'
    else:
        overall = 'Good'
    detail += '\nOverall Signal Status: %s' % overall
    summary = 'Signal: %s (RSSI: %s dBm, SINR: %s dB)' % (overall, rssi, sinr)
    return summary, detail


def _modem_resets():
    n = _count_log_occurrences('DEVICE_DIRECTOR.log', 'Resetting modem')
    if n <= 5:
        summary = 'Modem Resets: %d (normal)' % n
    elif n <= 15:
        summary = 'Modem Resets: %d (elevated)' % n
    else:
        summary = 'Modem Resets: %d (excessive)' % n
    detail = 'Total number of modem resets: %d\n' % n
    lines = []
    for line in _read_log_lines('DEVICE_DIRECTOR.log', 'Resetting modem'):
        m = re.match(r'^([\dT:.\-]+)', line)
        if m:
            lines.append(m.group(1))
    lines = list(reversed(lines))[:25]
    if lines:
        detail += 'Recent modem reset timestamps (newest first, max 25):\n'
        for t in lines:
            detail += '  - %s\n' % t
    else:
        detail += 'No modem resets found in logs\n'
    return summary, detail.strip()


def _camera_box():
    summary = 'Camera Box Health: No recent scans'
    detail = 'No recent scans found.'
    total = _count_log_occurrences('DET.log', '"scan_id":')
    mom_err = 0
    unsupp = 0
    for line in _read_log_lines('DET.log', 'MOM Reason:'):
        if 'MOM Reason: None' not in line:
            mom_err += 1
    for line in _read_log_lines('DET.log', 'Unsupported Key: true'):
        unsupp += 1
    err = mom_err + unsupp
    sev = 'warn'
    if total > 0:
        ok = max(0, total - err)
        rate = min(100, (100 * ok // total) if total else 0)
        summary = 'Camera Box Health: %d scans, %d errors (%d%% success)' % (total, err, rate)
        detail = 'Total scans (scan_id): %d. MOM non-None: %d, Unsupported: %d.' % (total, mom_err, unsupp)
        if rate >= 95:
            sev = 'ok'
        elif rate >= 85:
            sev = 'warn'
        else:
            sev = 'error'
    return summary, detail, sev


def _cuts():
    summary = 'Cuts: No cuts found'
    detail = 'No cut data available.'
    sev = 'warn'
    n_cutter = _count_log_occurrences('AUTOCAL.log', 'async_LOG_EVENT from CUTTER')
    n_fail = _count_log_occurrences('AUTOCAL.log', 'CALIBRATE_FAILURE')
    n_err = _count_log_occurrences('AUTOCAL.log', 'Error ID:')
    if n_cutter == 0:
        return summary, detail, sev
    issues = n_fail + n_err
    pct = min(100, (issues * 100 // n_cutter) if n_cutter else 0)
    if pct <= 10:
        summary = 'Cuts: %d recent, %d with issues (%d%% error rate)' % (n_cutter, issues, pct)
        sev = 'ok'
    elif pct <= 20:
        summary = 'Cuts: %d recent, %d with issues (%d%% error rate)' % (n_cutter, issues, pct)
        sev = 'warn'
    else:
        summary = 'Cuts: %d recent, %d with issues (%d%% error rate)' % (n_cutter, issues, pct)
        sev = 'error'
    detail = 'Cutter events: %d. CALIBRATE_FAILURE: %d. Error ID: %d.' % (n_cutter, n_fail, n_err)
    return summary, detail, sev


def _card_usage():
    summary = 'Card Usage: No recent card usage'
    detail = ''
    n = _count_log_occurrences('CREDIT_CARD.log', '"card_usage_method":')
    cc_err = 0
    for line in _read_log_lines('GUI.log', 'credit_card_error'):
        if 'card_requires_chip_read' in line or 'card_declined' in line or 'invalid_expiry_month' in line:
            continue
        cc_err += 1
    svc_err = 0
    for line in _read_log_lines('GUI.log', 'Sorry, but there was trouble communicating with our server'):
        if 'PATCH' in line or 'POST' in line:
            svc_err += 1
    total_err = cc_err + svc_err
    rate = (total_err / n) if n else 0
    if n == 0:
        sev = 'warn'
    elif rate > 9:
        sev = 'error'
        summary = 'Card Usage: %d transactions (%d errors, %.1f per txn)' % (n, total_err, rate)
    elif rate > 3:
        sev = 'warn'
        summary = 'Card Usage: %d transactions (%d errors, %.1f per txn)' % (n, total_err, rate)
    else:
        sev = 'ok'
        summary = 'Card Usage: %d transactions (%d errors, %.1f per txn)' % (n, total_err, rate)
    detail = 'Total card usage records: %d\nCC errors (excl. chip/decline/expiry): %d\nServer comm errors: %d' % (n, cc_err, svc_err)
    return summary, detail, sev


def _funnel():
    home_ids = set()
    insert_ids = set()
    pay_ids = set()
    order_ids = set()
    for line in _read_log_lines('GUI.log', 'page_view'):
        if '"/home"' in line or '"page_path":"/home"' in line:
            for u in re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', line):
                home_ids.add(u)
        if '/insert_for_copy"' in line or '/vehicle_insert_for_copy"' in line or '/rfid_insert_for_copy"' in line:
            for u in re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', line):
                insert_ids.add(u)
        if '"page_path":"/payment"' in line:
            m = re.search(r'kiosk_session_id":"([0-9a-f\-]+)"', line)
            if m:
                pay_ids.add(m.group(1))
        if '"page_path":"/order_confirmation"' in line:
            m = re.search(r'kiosk_session_id":"([0-9a-f\-]+)"', line)
            if m:
                order_ids.add(m.group(1))
    for line in _read_log_lines('GUI.log', 'GUI: dyk_started'):
        m = re.search(r'kiosk_session_id":"([0-9a-f\-]+)"', line)
        if m:
            order_ids.add(m.group(1))
    fabricated = insert_ids - home_ids
    home_total = len(home_ids) + len(fabricated)
    if home_total:
        funnel_pct = 100.0 * len(insert_ids) / home_total
    else:
        funnel_pct = 0.0
    if pay_ids:
        po_pct = 100.0 * len(pay_ids & order_ids) / len(pay_ids)
    else:
        po_pct = 0.0
    converted = len(pay_ids & order_ids)
    summary_f = 'Home to IP: %.2f%% (%d/%d, %d fabricated)' % (funnel_pct, len(insert_ids), home_total, len(fabricated))
    summary_p = 'Payment to Order: %.2f%% (%d/%d)' % (po_pct, converted, len(pay_ids))
    detail = 'Home sessions: %d\nInsert sessions: %d\nFabricated: %d\nFunnel: %.2f%%\n\nPayment sessions: %d\nOrder sessions: %d\nConverted: %d\nPayment-to-Order: %.2f%%' % (
        len(home_ids), len(insert_ids), len(fabricated), funnel_pct, len(pay_ids), len(order_ids), converted, po_pct)
    if home_total == 0:
        sev_f = 'warn'
    elif funnel_pct >= 30:
        sev_f = 'ok'
    elif funnel_pct >= 10:
        sev_f = 'warn'
    else:
        sev_f = 'error'
    if len(pay_ids) == 0:
        sev_p = 'warn'
    elif po_pct >= 70:
        sev_p = 'ok'
    elif po_pct >= 40:
        sev_p = 'warn'
    else:
        sev_p = 'error'
    return summary_f, summary_p, detail, sev_f, sev_p


def _memory():
    summary = 'Memory: Unknown'
    mem_line = ''
    swap_line = ''
    detail = ''
    try:
        out, _ = _run_cmd('free -m', timeout=5)
        for line in (out or '').splitlines():
            if line.startswith('Mem:'):
                parts = line.split()
                if len(parts) >= 3:
                    t = float(parts[1]) / 1024
                    u = float(parts[2]) / 1024
                    p = 100 - (u / t * 100) if t else 0
                    mem_line = 'Memory Total: %.2fGB Used: %.2fGB (%.0f%% Free)' % (t, u, p)
                    detail += mem_line + '\n'
            elif line.startswith('Swap:'):
                parts = line.split()
                if len(parts) >= 3:
                    t = float(parts[1]) / 1024
                    u = float(parts[2]) / 1024
                    free_pct = 100 - (u / t * 100) if t else 0
                    swap_line = 'Swap Total: %.2fGB Used: %.2fGB (%.0f%% Free)' % (t, u, free_pct)
                    detail += swap_line
                    if t and free_pct <= 10:
                        summary = 'Memory: Low swap (%.0f%% free)' % free_pct
                    else:
                        summary = 'Memory: Swap OK (%.0f%% free)' % (free_pct if t else 0)
    except Exception:
        pass
    if not detail:
        detail = 'Could not read memory info.'
    return summary, mem_line, swap_line, detail


def _severity(text):
    t = text or ''
    if t.startswith('\u2705') or 'Good' in t or 'OK' in t or 'normal' in t:
        return 'ok'
    if 'At latest' in t and 'Not' not in t:
        return 'ok'
    if t.startswith('\u26a0\ufe0f') or 'Average' in t or 'elevated' in t:
        return 'warn'
    return 'error'


_STEPS = [
    'software', 'speedtest', 'signal', 'modem_resets', 'camera_box',
    'cuts', 'card_usage', 'funnel', 'memory',
]


def run_wellness_check_stream():
    """Yield (step, summary_items, detailed_key, detailed_value) for each check."""
    sw_summary, sw_detail = _software_version()
    yield ('software', [{'severity': _severity(sw_summary), 'text': sw_summary}],
           '[Software Version]', sw_detail)

    sp_summary, sp_detail, carrier, modem = _speedtest()
    yield ('speedtest',
           [{'severity': _severity(sp_summary), 'text': sp_summary},
            {'severity': 'ok', 'text': '   - Carrier: %s' % carrier},
            {'severity': 'ok', 'text': '   - Modem: %s' % modem}],
           '[Speedtest Results]', sp_detail)

    sig_summary, sig_detail = _signal()
    yield ('signal', [{'severity': _severity(sig_summary), 'text': sig_summary}],
           '[Signal Quality Check]', sig_detail)

    mod_summary, mod_detail = _modem_resets()
    yield ('modem_resets', [{'severity': _severity(mod_summary), 'text': mod_summary}],
           '[Modem Reset History]', mod_detail)

    cam_summary, cam_detail, cam_sev = _camera_box()
    yield ('camera_box', [{'severity': cam_sev, 'text': cam_summary}],
           '[Recent Scans]', cam_detail)

    cut_summary, cut_detail, cut_sev = _cuts()
    yield ('cuts', [{'severity': cut_sev, 'text': cut_summary}],
           '[Recent Transactions]', cut_detail)

    card_summary, card_detail, card_sev = _card_usage()
    yield ('card_usage', [{'severity': card_sev, 'text': card_summary}],
           '[Card Usage Summary]', card_detail)

    fun_f, fun_p, fun_detail, fun_sev_f, fun_sev_p = _funnel()
    yield ('funnel',
           [{'severity': fun_sev_f, 'text': fun_f}, {'severity': fun_sev_p, 'text': fun_p}],
           '[Funnel and Payment Metrics]', fun_detail)

    mem_summary, mem_line, swap_line, mem_detail = _memory()
    mem_items = [{'severity': _severity(mem_summary), 'text': mem_summary}]
    if mem_line:
        mem_items.append({'severity': 'ok', 'text': '   - ' + mem_line})
    if swap_line:
        mem_items.append({'severity': 'ok', 'text': '   - ' + swap_line})
    yield ('memory', mem_items, '[Memory Leak Check]', mem_detail)


def run_wellness_check():
    """Run all checks. Returns { summary: [ {severity, text} ], detailed: { "[Section]": "..." } }."""
    summary_list = []
    detailed = {}
    for _step, items, dk, dv in run_wellness_check_stream():
        summary_list.extend(items)
        if dk:
            detailed[dk] = dv
    return {'summary': summary_list, 'detailed': detailed}
