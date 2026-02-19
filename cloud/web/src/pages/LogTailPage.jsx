import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { ScrollText, Play, Square, Download, AlertTriangle, Loader2, HelpCircle, Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const INITIAL_LINES_DEFAULT = 50;
const INITIAL_LINES_MAX = 200;
const UI_UPDATE_THROTTLE_MS = 120;
const MAX_LINES_KEEP = 5000;
const SCROLL_BOTTOM_EPS_PX = 12;
const VIM_LINE_SCROLL_PX = 18;

// From setup/salt/logs/lnav_keyme.json (keymev3 pattern)
const KEYME_LOG_REGEX = /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\d*-\d{2}:\d{2} <(?<level>.)> (?<kiosk>[^ ]+) KEYMELOG\|(?<process>[^[]+)\[(?<pid>\d+)\]:(?<body>.*)$/;

function clampInitialLines(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return INITIAL_LINES_DEFAULT;
  return Math.min(INITIAL_LINES_MAX, Math.max(1, Math.floor(n)));
}

function parseKeyMeLine(line) {
  const m = String(line).match(KEYME_LOG_REGEX);
  if (!m?.groups) return null;
  return {
    timestamp: m.groups.timestamp,
    level: m.groups.level,
    kiosk: m.groups.kiosk,
    process: m.groups.process,
    pid: m.groups.pid,
    body: m.groups.body ?? '',
  };
}

function levelStyle(level) {
  switch (level) {
    case 'c':
      return {
        row: 'text-red-200',
        badge: 'bg-red-500/20 text-red-200 border-red-500/40',
      };
    case 'e':
      return {
        row: 'text-red-300',
        badge: 'bg-red-500/15 text-red-200 border-red-500/35',
      };
    case 'w':
      return {
        row: 'text-amber-200',
        badge: 'bg-amber-500/15 text-amber-200 border-amber-500/35',
      };
    case 'i':
      return {
        row: 'text-foreground',
        badge: 'bg-sky-500/12 text-sky-200 border-sky-500/30',
      };
    case 'd':
      return {
        row: 'text-muted-foreground',
        badge: 'bg-slate-500/10 text-slate-200 border-slate-500/25',
      };
    default:
      return {
        row: 'text-foreground',
        badge: 'bg-muted text-muted-foreground border-border',
      };
  }
}

function extractLevel(line) {
  const parsed = parseKeyMeLine(line);
  return parsed?.level ?? 'other';
}

function downloadLog(lines, logLabel) {
  if (!lines || lines.length === 0) return;
  const text = lines.join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const safeLabel = (logLabel || 'logs').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `device-logs-${safeLabel}-${date}.txt`;
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function isNearBottom(el) {
  if (!el) return true;
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= SCROLL_BOTTOM_EPS_PX;
}

export default function LogTailPage({ socket }) {
  const [logs, setLogs] = useState([]);
  const [logId, setLogId] = useState('');
  const [initialLines, setInitialLines] = useState(INITIAL_LINES_DEFAULT);
  const [tailing, setTailing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentLogLabel, setCurrentLogLabel] = useState('');
  const [renderLines, setRenderLines] = useState([]);
  const [renderLineCount, setRenderLineCount] = useState(0);
  const [follow, setFollow] = useState(true);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [levelFilter, setLevelFilter] = useState(() => ({
    c: true,
    e: true,
    w: true,
    i: true,
    d: true,
    other: true,
  }));

  const linesRef = useRef([]);
  const onTailLineRef = useRef(null);
  const fetchLogListRef = useRef(() => {});
  const throttleTimeoutRef = useRef(null);
  const scrollRef = useRef(null);
  const fullscreenScrollRef = useRef(null);
  const fullscreenSearchRef = useRef(null);
  const tailingRef = useRef(false);

  const selectedLog = useMemo(() => logs.find((l) => l.id === logId), [logs, logId]);
  const isAllLog = selectedLog?.type === 'all';
  const canDownload = renderLineCount > 0;

  const viewEntries = useMemo(() => {
    const qRaw = String(searchQuery || '').trim();
    const hasQuery = qRaw.length > 0;
    const needle = matchCase ? qRaw : qRaw.toLowerCase();

    const out = [];
    for (const line of renderLines) {
      const parsed = parseKeyMeLine(line);
      const lvl = parsed?.level ?? 'other';
      if (!levelFilter[lvl]) continue;
      if (hasQuery) {
        const hay = matchCase ? String(line) : String(line).toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      out.push({ line, parsed, level: lvl });
    }
    return out;
  }, [renderLines, searchQuery, matchCase, levelFilter]);

  const shownCount = viewEntries.length;

  const flushRender = useCallback(() => {
    throttleTimeoutRef.current = null;
    const lines = linesRef.current;
    const snapshot = lines.length ? lines.slice() : [];
    setRenderLines(snapshot);
    setRenderLineCount(snapshot.length);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (throttleTimeoutRef.current) return;
    throttleTimeoutRef.current = setTimeout(flushRender, UI_UPDATE_THROTTLE_MS);
  }, [flushRender]);

  const enforceMaxLines = useCallback(() => {
    const lines = linesRef.current;
    if (lines.length <= MAX_LINES_KEEP) return;
    linesRef.current = lines.slice(-MAX_LINES_KEEP);
  }, []);

  const fetchLogList = useCallback(() => {
    if (!socket?.connected) return;
    setError(null);
    socket.request('get_log_list').then((res) => {
      if (res?.success && res?.data?.logs) {
        setLogs(res.data.logs);
        if (!logId && res.data.logs.length > 0) {
          setLogId(res.data.logs[0].id);
        }
      } else {
        setError(res?.errors?.join(', ') || 'Failed to load log list');
      }
    }).catch((err) => {
      setError(err?.message || 'Failed to load log list');
    });
  }, [socket, logId]);

  fetchLogListRef.current = fetchLogList;

  useEffect(() => {
    if (!socket) return;
    const onHello = () => fetchLogListRef.current();
    socket.on('hello', onHello);
    fetchLogList();
    return () => socket.off('hello', onHello);
  }, [socket, fetchLogList]);

  useEffect(() => {
    tailingRef.current = tailing;
  }, [tailing]);

  useEffect(() => {
    if (!socket) return;
    return () => {
      if (tailingRef.current) {
        socket.request('log_tail_stop').catch(() => {});
      }
      socket.off('log_tail_line', onTailLineRef.current);
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
        throttleTimeoutRef.current = null;
      }
    };
  }, [socket]);

  useEffect(() => {
    if (!follow) return;
    const el = fullscreenOpen ? fullscreenScrollRef.current : scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [renderLineCount, follow, fullscreenOpen]);

  useEffect(() => {
    if (!fullscreenOpen) return;

    const isTypingTarget = (target) => {
      const el = target;
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || el.isContentEditable;
    };

    const scrollEl = () => fullscreenScrollRef.current;
    const scrollByPx = (px) => {
      const el = scrollEl();
      if (!el) return;
      el.scrollTop += px;
    };
    const scrollToTop = () => {
      const el = scrollEl();
      if (!el) return;
      el.scrollTop = 0;
    };
    const scrollToBottom = () => {
      const el = scrollEl();
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setFullscreenOpen(false);
        return;
      }

      if (isTypingTarget(e.target)) return;

      if (e.key === '/') {
        e.preventDefault();
        fullscreenSearchRef.current?.focus();
        return;
      }

      if (e.key === 'q') {
        setFullscreenOpen(false);
        return;
      }

      const el = scrollEl();
      const page = el ? Math.max(1, Math.floor(el.clientHeight * 0.85)) : 400;

      switch (e.key) {
        case 'j':
          scrollByPx(VIM_LINE_SCROLL_PX);
          break;
        case 'k':
          scrollByPx(-VIM_LINE_SCROLL_PX);
          break;
        case 'g':
          scrollToTop();
          break;
        case 'G':
          scrollToBottom();
          break;
        default:
          break;
      }

      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (e.key === 'd') {
          e.preventDefault();
          scrollByPx(page / 2);
        } else if (e.key === 'u') {
          e.preventDefault();
          scrollByPx(-page / 2);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreenOpen]);

  const startTail = useCallback(() => {
    if (!socket?.connected || tailing || loading) return;
    const selected = logId || logs[0]?.id;
    if (!selected) return;

    setLoading(true);
    setError(null);

    if (throttleTimeoutRef.current) {
      clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }

    // Best-effort: stop any previous tail if the server still has one.
    socket.request('log_tail_stop').catch(() => {});
    socket.off('log_tail_line', onTailLineRef.current);
    onTailLineRef.current = null;

    setFollow(true);
    setRenderLines([]);
    setRenderLineCount(0);
    linesRef.current = [];

    const label = logs.find((l) => l.id === selected)?.label || selected;
    setCurrentLogLabel(label);

    const onTailLine = (data) => {
      if (data?.line == null) return;
      linesRef.current.push(data.line);
      enforceMaxLines();
      scheduleFlush();
    };
    onTailLineRef.current = onTailLine;
    socket.on('log_tail_line', onTailLine);

    const n = clampInitialLines(initialLines);
    socket.request('log_tail_start', { log_id: selected, initial_lines: n }).then((res) => {
      setLoading(false);
      if (res?.success && Array.isArray(res?.data?.lines)) {
        setTailing(true);
        linesRef.current = res.data.lines.slice(-MAX_LINES_KEEP);
        flushRender();
      } else {
        setTailing(false);
        setError(res?.errors?.join(', ') || 'Failed to start tail');
        socket.off('log_tail_line', onTailLineRef.current);
      }
    }).catch((err) => {
      setLoading(false);
      setTailing(false);
      setError(err?.message || 'Failed to start tail');
      socket.off('log_tail_line', onTailLineRef.current);
    });
  }, [socket, logId, logs, initialLines, tailing, loading, enforceMaxLines, scheduleFlush, flushRender]);

  const stopTail = useCallback(() => {
    if (!socket?.connected || !tailing) return;
    socket.off('log_tail_line', onTailLineRef.current);
    onTailLineRef.current = null;
    if (throttleTimeoutRef.current) {
      clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }
    socket.request('log_tail_stop').catch(() => {});
    setTailing(false);
  }, [socket, tailing]);

  const onScroll = useCallback((e) => {
    const el = e?.currentTarget;
    if (!el) return;
    if (isNearBottom(el)) {
      if (!follow) setFollow(true);
    } else {
      if (follow) setFollow(false);
    }
  }, [follow]);

  const toggleLevel = (lvl) => {
    setLevelFilter((prev) => ({ ...prev, [lvl]: !prev[lvl] }));
  };

  const levelButtonClass = (lvl) => {
    const enabled = !!levelFilter[lvl];
    const s = levelStyle(lvl === 'other' ? '?' : lvl);
    return cn(
      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
      enabled ? s.badge : 'bg-muted text-muted-foreground border-border opacity-60 hover:opacity-90'
    );
  };

  const scrollToBottom = useCallback(() => {
    const el = fullscreenOpen ? fullscreenScrollRef.current : scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setFollow(true);
  }, [fullscreenOpen]);

  return (
    <div className="space-y-6">
      <PageTitle icon={ScrollText}>Device logs</PageTitle>

      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Choose a log file and start tailing. Only one log can be tailed at a time. Initial lines (max {INITIAL_LINES_MAX}) are loaded, then new lines stream in.
          </p>

          <div className="relative inline-flex group">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground cursor-help">
              <HelpCircle className="size-4 shrink-0" aria-hidden />
              Log types
            </span>
            <div
              className="absolute left-0 top-full mt-2 hidden min-w-[22rem] max-w-md rounded-md border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-md group-hover:block z-50 leading-relaxed"
              role="tooltip"
            >
              <p className="font-medium text-foreground mb-2">Log types</p>
              <div className="space-y-2.5 text-muted-foreground">
                <p>
                  <strong className="text-foreground">/var/log/keyme/processes/[PROCESS_NAME].log</strong> — Main log for each process (KeyMe/syslog format). Use for normal runtime logs.
                </p>
                <p>
                  <strong className="text-foreground">/tmp/[PROCESS_NAME].stdout</strong> and <strong className="text-foreground">/tmp/[PROCESS_NAME].stderr</strong> — Process standard output and standard error. Use when a process fails to start or to see Python tracebacks and uncaught errors.
                </p>
                <p>
                  <strong className="text-foreground">/var/log/keyme/all.log</strong> — Combined stream of all processes. High volume; use when you need a single chronological view across the kiosk.
                </p>
              </div>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}

          {isAllLog && (
            <p className="flex items-center gap-2 text-sm text-amber-600" role="status">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              High volume; display may be throttled. <strong>Be mindful of data usage costs.</strong>
            </p>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Log</span>
              <select
                value={logId}
                onChange={(e) => setLogId(e.target.value)}
                disabled={tailing}
                className="min-w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {logs.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Initial lines</span>
              <input
                type="number"
                min={1}
                max={INITIAL_LINES_MAX}
                value={initialLines}
                onChange={(e) => setInitialLines(clampInitialLines(e.target.value))}
                disabled={tailing}
                className="w-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={startTail}
                disabled={!socket?.connected || tailing || loading || logs.length === 0}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                {loading ? (
                  <>
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                    Starting…
                  </>
                ) : (
                  <>
                    <Play className="size-4 shrink-0" aria-hidden />
                    Start tail
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={stopTail}
                disabled={!tailing}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium border border-input hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                <Square className="size-4 shrink-0" aria-hidden />
                Stop tail
              </button>

              <button
                type="button"
                onClick={() => downloadLog(linesRef.current, currentLogLabel)}
                disabled={!canDownload}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium border border-input hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                <Download className="size-4 shrink-0" aria-hidden />
                Download
              </button>

              <button
                type="button"
                onClick={scrollToBottom}
                disabled={!renderLineCount}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium border border-input hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
                title={follow ? 'Following (auto-scroll on)' : 'Not following (you scrolled up)'}
              >
                {follow ? 'Following' : 'Follow'}
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {(renderLineCount > 0 || tailing) && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <CardTitle className="text-base">
                {currentLogLabel || 'Log output'}
                {tailing && <span className="ml-2 text-muted-foreground font-normal">(live)</span>}
                {renderLineCount > 0 && (
                  <span className="ml-2 text-muted-foreground font-normal">({renderLineCount} lines)</span>
                )}
                {searchQuery.trim() && (
                  <span className="ml-2 text-muted-foreground font-normal">showing {shownCount}</span>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFullscreenOpen(true)}
                  disabled={!renderLineCount && !tailing}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium border border-input hover:bg-accent',
                    'disabled:opacity-50 disabled:pointer-events-none'
                  )}
                  title="Fullscreen"
                >
                  <Maximize2 className="size-4 shrink-0" aria-hidden />
                  Fullscreen
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">
              Level tags: <span className="text-foreground">C</span>=critical, <span className="text-foreground">E</span>=error, <span className="text-foreground">W</span>=warning, <span className="text-foreground">I</span>=info, <span className="text-foreground">D</span>=debug.
            </p>
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className="rounded-md border border-input bg-muted/30 h-[60vh] overflow-auto"
            >
              {renderLineCount > 0 ? (
                <div className="font-mono text-xs leading-relaxed">
                  {viewEntries.map((entry, i) => {
                    const { line, parsed } = entry;
                    if (!parsed) {
                      return (
                        <div key={i} className="px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all">
                          {line}
                        </div>
                      );
                    }

                    const { timestamp, level, kiosk, process: proc, pid, body } = parsed;
                    const s = levelStyle(level);
                    const badge = String(level || '?').toUpperCase();
                    return (
                      <div
                        key={i}
                        className={cn(
                          'px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all',
                          s.row
                        )}
                      >
                        <span className="text-muted-foreground">{timestamp}</span>
                        {' '}
                        <span
                          className={cn(
                            'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[0.65rem] leading-none border align-middle',
                            s.badge
                          )}
                          title={
                            level === 'c' ? 'critical' :
                            level === 'e' ? 'error' :
                            level === 'w' ? 'warning' :
                            level === 'i' ? 'info' :
                            level === 'd' ? 'debug' : 'log'
                          }
                        >
                          {badge}
                        </span>
                        {' '}
                        <span className="text-violet-300">{kiosk}</span>
                        {' '}
                        <span className="text-cyan-300">
                          KEYMELOG|{proc}[{pid}]
                        </span>
                        <span className="text-muted-foreground">:</span>
                        <span className={cn('ml-1', level === 'd' ? 'text-muted-foreground' : 'text-foreground')}>
                          {String(body).trimStart()}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  {tailing ? 'Waiting for output…' : 'No output.'}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={fullscreenOpen} onOpenChange={setFullscreenOpen}>
        <DialogContent
          showClose={false}
          className="flex flex-col w-[98vw] h-[96vh] max-w-none max-h-none p-0 overflow-hidden"
        >
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3 sticky top-0 z-10 bg-background">
            <div className="flex items-start gap-3">
              <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 text-base">
                <ScrollText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{currentLogLabel || 'Log output'}</span>
                {tailing && <span className="text-muted-foreground font-normal">(live)</span>}
              </DialogTitle>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-muted-foreground tabular-nums">
                  showing {shownCount} / {renderLineCount}
                </span>
                <button
                  type="button"
                  onClick={() => setFullscreenOpen(false)}
                  className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-accent"
                  title="Close (Esc / q)"
                >
                  <X className="size-4 shrink-0" aria-hidden />
                  Close
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                ref={fullscreenSearchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search (UI filter)…  (/ focuses)"
                className="h-9 w-[min(520px,70vw)] rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                disabled={!searchQuery}
                className={cn(
                  'h-9 rounded-md border border-input px-3 text-sm hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setMatchCase((v) => !v)}
                className={cn(
                  'h-9 rounded-md border border-input px-3 text-sm hover:bg-accent',
                  matchCase && 'bg-accent'
                )}
                title="Match case"
              >
                Aa
              </button>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <button
                type="button"
                onClick={() => setLevelFilter({ c: true, e: true, w: true, i: true, d: true, other: true })}
                className="h-9 rounded-md border border-input px-3 text-sm hover:bg-accent"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setLevelFilter({ c: false, e: false, w: false, i: false, d: false, other: false })}
                className="h-9 rounded-md border border-input px-3 text-sm hover:bg-accent"
              >
                None
              </button>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <button type="button" onClick={() => toggleLevel('c')} className={levelButtonClass('c')} title="critical (&lt;c&gt;)">C</button>
              <button type="button" onClick={() => toggleLevel('e')} className={levelButtonClass('e')} title="error (&lt;e&gt;)">E</button>
              <button type="button" onClick={() => toggleLevel('w')} className={levelButtonClass('w')} title="warning (&lt;w&gt;)">W</button>
              <button type="button" onClick={() => toggleLevel('i')} className={levelButtonClass('i')} title="info (&lt;i&gt;)">I</button>
              <button type="button" onClick={() => toggleLevel('d')} className={levelButtonClass('d')} title="debug (&lt;d&gt;)">D</button>
              <button type="button" onClick={() => toggleLevel('other')} className={levelButtonClass('other')} title="non-KeyMe / unparsed">Other</button>
              <span className="ml-1 text-xs text-muted-foreground whitespace-nowrap">
                C=critical · E=error · W=warning · I=info · D=debug
              </span>
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <button
                type="button"
                onClick={scrollToBottom}
                disabled={!renderLineCount}
                className={cn(
                  'h-9 rounded-md border border-input px-3 text-sm hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
                title={follow ? 'Following (auto-scroll on)' : 'Not following (you scrolled up)'}
              >
                {follow ? 'Following' : 'Follow'}
              </button>
            </div>
          </DialogHeader>

          <div
            ref={fullscreenScrollRef}
            onScroll={onScroll}
            className="flex-1 overflow-auto bg-muted/30"
          >
            {shownCount > 0 ? (
              <div className="font-mono text-xs leading-relaxed">
                {viewEntries.map((entry, i) => {
                  const { line, parsed } = entry;
                  if (!parsed) {
                    return (
                      <div key={i} className="px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    );
                  }

                  const { timestamp, level, kiosk, process: proc, pid, body } = parsed;
                  const s = levelStyle(level);
                  const badge = String(level || '?').toUpperCase();
                  return (
                    <div
                      key={i}
                      className={cn(
                        'px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all',
                        s.row
                      )}
                    >
                      <span className="text-muted-foreground">{timestamp}</span>
                      {' '}
                      <span
                        className={cn(
                          'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[0.65rem] leading-none border align-middle',
                          s.badge
                        )}
                        title={
                          level === 'c' ? 'critical' :
                          level === 'e' ? 'error' :
                          level === 'w' ? 'warning' :
                          level === 'i' ? 'info' :
                          level === 'd' ? 'debug' : 'log'
                        }
                      >
                        {badge}
                      </span>
                      {' '}
                      <span className="text-violet-300">{kiosk}</span>
                      {' '}
                      <span className="text-cyan-300">
                        KEYMELOG|{proc}[{pid}]
                      </span>
                      <span className="text-muted-foreground">:</span>
                      <span className={cn('ml-1', level === 'd' ? 'text-muted-foreground' : 'text-foreground')}>
                        {String(body).trimStart()}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                {renderLineCount === 0 ? (tailing ? 'Waiting for output…' : 'No output.') : 'No matches (adjust search/filters).'}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
