import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { ScrollText, Play, Square, Download, AlertTriangle, Loader2, HelpCircle, Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createAiSocket } from '@/lib/aiSocket';
import { ERROR_UNSUPPORTED_COMMAND, UNSUPPORTED_FEATURE_MESSAGE } from '@/lib/deviceSocket';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  ANALYZE_PRESETS,
  ANALYZE_PROCESS_NAMES,
  ANALYZE_LEVELS,
  ANALYZE_MESSAGE_PRESETS,
  getPresetPayload,
} from './analyzePresets';

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

/** Parse run_log_analyze output for errors_and_restarts: one raw log line per event. Returns { events } or { events: [], parseError: true }. */
function parseErrorsAndRestartsOutput(output) {
  const events = [];
  const lines = String(output ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseKeyMeLine(line);
    if (!parsed) continue;
    const { timestamp, level, process: processName, body } = parsed;
    const isRestart = body.includes('async_STARTED to MANAGER');
    const isError = level === 'e' || level === 'c';
    const type = isRestart ? 'restart' : isError ? 'error' : null;
    if (!type) continue;
    events.push({ timestamp, process: processName, type, raw: line });
  }
  return { events };
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

function getRangeDays(startStr, endStr) {
  const start = new Date(startStr);
  const end = new Date(endStr);
  return (end - start) / (1000 * 60 * 60 * 24);
}

const RANGE_MAX_DAYS = 4;
const CONTEXT_CAP_DEFAULT = 10;
const CONTEXT_CAP = 50;

function ViewTab({ socket }) {
  const [logs, setLogs] = useState([]);
  const [viewLogId, setViewLogId] = useState('');
  const [startDatetime, setStartDatetime] = useState('');
  const [endDatetime, setEndDatetime] = useState('');
  const [fetchedLines, setFetchedLines] = useState([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [levelFilter, setLevelFilter] = useState(() => ({ c: true, e: true, w: true, i: true, d: true, other: true }));
  const [searchQuery, setSearchQuery] = useState('');
  const [beforeContext, setBeforeContext] = useState(0);
  const [afterContext, setAfterContext] = useState(CONTEXT_CAP_DEFAULT);
  const [selectedProcesses, setSelectedProcesses] = useState(null);
  const [processFilterOpen, setProcessFilterOpen] = useState(false);
  const [expandedTracebacks, setExpandedTracebacks] = useState(new Set());
  const [fetchTruncated, setFetchTruncated] = useState(false);
  const [fetchMissingDates, setFetchMissingDates] = useState([]);
  const [fetchProcessFilter, setFetchProcessFilter] = useState([]);
  const [fetchProcessFilterOpen, setFetchProcessFilterOpen] = useState(false);
  const [logStreamFullscreen, setLogStreamFullscreen] = useState(false);
  const viewStreamRef = useRef(null);
  const rangeStreamIdRef = useRef(null);

  const mainLogs = useMemo(() => logs.filter((l) => l.type === 'main' || l.id === 'all'), [logs]);
  const processNamesForAllLog = useMemo(
    () => mainLogs.filter((l) => l.id !== 'all').map((l) => l.id.replace('process/', '')),
    [mainLogs]
  );

  useEffect(() => {
    if (!socket?.connected) return;
    socket.requestIfSupported('get_log_list').then((res) => {
      if (res?.success && res?.data?.logs) {
        setLogs(res.data.logs);
        if (!viewLogId && res.data.logs.length > 0) {
          const main = res.data.logs.filter((l) => l.type === 'main');
          if (main.length > 0) setViewLogId(main[0].id);
        }
      }
    });
  }, [socket, viewLogId]);

  const uniqueProcessNames = useMemo(() => {
    const set = new Set();
    for (const line of fetchedLines) {
      const p = parseKeyMeLine(line)?.process;
      if (p) set.add(p);
    }
    return Array.from(set).sort();
  }, [fetchedLines]);

  const matchIndices = useMemo(() => {
    const qRaw = String(searchQuery || '').trim();
    const hasQuery = qRaw.length > 0;
    const needle = qRaw.toLowerCase();
    const idx = [];
    fetchedLines.forEach((line, i) => {
      const parsed = parseKeyMeLine(line);
      const lvl = parsed?.level ?? 'other';
      if (!levelFilter[lvl]) return;
      if (hasQuery && !String(line).toLowerCase().includes(needle)) return;
      if (selectedProcesses != null && selectedProcesses.length > 0) {
        const proc = parsed?.process;
        if (!proc || !selectedProcesses.includes(proc)) return;
      }
      idx.push(i);
    });
    return idx;
  }, [fetchedLines, searchQuery, levelFilter, selectedProcesses]);

  const contextRanges = useMemo(() => {
    if (beforeContext <= 0 && afterContext <= 0) return matchIndices.map((i) => [i, i]);
    const merged = [];
    for (const i of matchIndices) {
      const low = Math.max(0, i - beforeContext);
      const high = Math.min(fetchedLines.length - 1, i + afterContext);
      merged.push([low, high]);
    }
    merged.sort((a, b) => a[0] - b[0]);
    const out = [];
    let lastEnd = -1;
    for (const [lo, hi] of merged) {
      if (out.length > 0 && lo <= lastEnd + 1) {
        out[out.length - 1][1] = Math.max(out[out.length - 1][1], hi);
      } else {
        out.push([lo, hi]);
      }
      lastEnd = Math.max(lastEnd, hi);
    }
    return out;
  }, [matchIndices, beforeContext, afterContext, fetchedLines.length]);

  const viewEntries = useMemo(() => {
    const entries = [];
    for (const [lo, hi] of contextRanges) {
      for (let i = lo; i <= hi; i++) {
        const line = fetchedLines[i];
        const parsed = parseKeyMeLine(line);
        const lvl = parsed?.level ?? 'other';
        entries.push({ line, parsed, level: lvl, index: i });
      }
    }
    return entries;
  }, [contextRanges, fetchedLines]);

  const errorIndices = useMemo(() => {
    const idx = [];
    viewEntries.forEach((entry, viewIdx) => {
      if (entry.level === 'e' || entry.level === 'c') idx.push({ viewIdx, lineIndex: entry.index });
    });
    return idx;
  }, [viewEntries]);

  const handleFetch = useCallback(() => {
    if (!socket?.connected || !viewLogId) return;
    const start = startDatetime.trim();
    const end = endDatetime.trim();
    if (!start || !end) {
      setFetchError('Enter start and end date/time');
      return;
    }
    const rangeDays = getRangeDays(start, end);
    if (rangeDays <= 0) {
      setFetchError('End must be after start');
      return;
    }
    if (rangeDays > RANGE_MAX_DAYS) {
      setFetchError(`Range must be at most ${RANGE_MAX_DAYS} days`);
      return;
    }
    setFetchError(null);
    setFetchTruncated(false);
    setFetchMissingDates([]);
    setFetchedLines([]);
    setFetchLoading(true);
    const streamId = Date.now();
    rangeStreamIdRef.current = streamId;

    const onBatch = (data) => {
      if (data?.stream_id !== rangeStreamIdRef.current) return;
      setFetchedLines((prev) => [...prev, ...(data.lines || [])]);
    };
    const onDone = (data) => {
      if (data?.stream_id !== rangeStreamIdRef.current) return;
      setFetchLoading(false);
      setFetchTruncated(Boolean(data?.truncated));
      socket.off('log_range_batch', onBatch);
      socket.off('log_range_done', onDone);
    };

    socket.on('log_range_batch', onBatch);
    socket.on('log_range_done', onDone);

    const payload = {
      log_id: viewLogId,
      start_datetime: start,
      end_datetime: end,
      stream_id: streamId,
    };
    if (viewLogId === 'all' && fetchProcessFilter.length > 0) {
      payload.process_filter = fetchProcessFilter;
    }
    socket.requestIfSupported('get_log_range', payload).then((res) => {
      if (!res?.success || !res?.data?.started) {
        setFetchLoading(false);
        setFetchError(res?.errors?.join(', ') || 'Failed to fetch range');
        setFetchMissingDates([]);
        socket.off('log_range_batch', onBatch);
        socket.off('log_range_done', onDone);
      } else {
        const missing = res?.data?.missing_dates;
        setFetchMissingDates(Array.isArray(missing) ? missing : []);
      }
    }).catch((err) => {
      setFetchLoading(false);
      setFetchError(err?.message || 'Failed to fetch range');
      setFetchMissingDates([]);
      socket.off('log_range_batch', onBatch);
      socket.off('log_range_done', onDone);
    });
  }, [socket, viewLogId, startDatetime, endDatetime, fetchProcessFilter]);

  const jumpToError = useCallback((direction) => {
    if (errorIndices.length === 0) return;
    const scrollEl = viewStreamRef.current;
    if (!scrollEl) return;
    const container = scrollEl.querySelector('[data-view-entries]');
    if (!container) return;
    const children = container.children;
    if (children.length === 0) return;
    const currentScroll = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    let targetViewIdx = null;
    if (direction === 'next') {
      for (const { viewIdx } of errorIndices) {
        const el = children[viewIdx];
        if (el && el.offsetTop > currentScroll - 100) {
          targetViewIdx = viewIdx;
          break;
        }
      }
      if (targetViewIdx == null && errorIndices.length > 0) targetViewIdx = errorIndices[0].viewIdx;
    } else {
      for (let i = errorIndices.length - 1; i >= 0; i--) {
        const el = children[errorIndices[i].viewIdx];
        if (el && el.offsetTop < currentScroll + 100) {
          targetViewIdx = errorIndices[i].viewIdx;
          break;
        }
      }
      if (targetViewIdx == null && errorIndices.length > 0) targetViewIdx = errorIndices[errorIndices.length - 1].viewIdx;
    }
    if (targetViewIdx != null && children[targetViewIdx]) {
      children[targetViewIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [errorIndices]);

  const toggleLevel = (lvl) => setLevelFilter((prev) => ({ ...prev, [lvl]: !prev[lvl] }));

  const levelButtonClass = (lvl) => {
    const enabled = !!levelFilter[lvl];
    const s = levelStyle(lvl === 'other' ? '?' : lvl);
    return cn(
      'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium',
      enabled ? s.badge : 'bg-muted text-muted-foreground border-border opacity-60 hover:opacity-90'
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Process</span>
              <select
                value={viewLogId}
                onChange={(e) => setViewLogId(e.target.value)}
                className="min-w-[200px] rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {mainLogs.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Start date/time</span>
              <input
                type="datetime-local"
                value={startDatetime}
                onChange={(e) => setStartDatetime(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">End date/time</span>
              <input
                type="datetime-local"
                value={endDatetime}
                onChange={(e) => setEndDatetime(e.target.value)}
                className="rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </label>
            {viewLogId === 'all' && processNamesForAllLog.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFetchProcessFilterOpen((o) => !o)}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[140px] text-left"
                >
                  Process filter: {fetchProcessFilter.length === 0 ? 'All' : `${fetchProcessFilter.length} selected`}
                </button>
                {fetchProcessFilterOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] max-h-48 overflow-auto rounded-md border border-border bg-popover p-2 shadow-md">
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent"
                      onClick={() => { setFetchProcessFilter([]); setFetchProcessFilterOpen(false); }}
                    >
                      All processes
                    </button>
                    {processNamesForAllLog.map((name) => (
                      <label key={name} className="flex items-center gap-2 px-2 py-1 hover:bg-accent/50 rounded cursor-pointer">
                        <input
                          type="checkbox"
                          checked={fetchProcessFilter.includes(name)}
                          onChange={() => {
                            setFetchProcessFilter((prev) =>
                              prev.includes(name) ? prev.filter((p) => p !== name) : [...prev, name]
                            );
                          }}
                        />
                        <span className="text-sm truncate">{name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleFetch}
              disabled={!socket?.connected || fetchLoading || mainLogs.length === 0}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:pointer-events-none'
              )}
            >
              {fetchLoading ? <Loader2 className="size-4 animate-spin" /> : null}
              Fetch
            </button>
          </div>
          {fetchError && <p className="text-sm text-destructive" role="alert">{fetchError}</p>}
          {fetchTruncated && !fetchError && (
            <p className="text-sm text-muted-foreground">Results truncated to max lines.</p>
          )}
          {fetchMissingDates.length > 0 && !fetchError && (
            <p className="text-sm text-amber-600 dark:text-amber-400" role="status">
              No log files found for: {fetchMissingDates.join(', ')}. Data shown is only for dates that had files.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className={logStreamFullscreen ? 'fixed inset-0 z-50 rounded-none flex flex-col' : ''}>
        <CardHeader className="pb-2 flex-shrink-0 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Log stream</CardTitle>
          <div className="flex items-center gap-2">
            {logStreamFullscreen ? (
              <button
                type="button"
                onClick={() => setLogStreamFullscreen(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
                title="Exit full screen"
              >
                <X className="size-4" />
                Exit full screen
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLogStreamFullscreen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
                title="Full screen"
              >
                <Maximize2 className="size-4" />
                Full screen
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className={cn('flex flex-col gap-3 flex-1 min-h-0', logStreamFullscreen && 'flex-1 overflow-hidden')}>
          <div className="flex flex-wrap items-center gap-2 flex-shrink-0">
            <span className="text-xs font-medium text-muted-foreground">Filters:</span>
            <button type="button" onClick={() => toggleLevel('e')} className={levelButtonClass('e')}>Errors</button>
            <button type="button" onClick={() => toggleLevel('w')} className={levelButtonClass('w')}>Warnings</button>
            <button type="button" onClick={() => toggleLevel('c')} className={levelButtonClass('c')}>Critical</button>
            <button type="button" onClick={() => toggleLevel('i')} className={levelButtonClass('i')}>Info</button>
            <button type="button" onClick={() => toggleLevel('d')} className={levelButtonClass('d')}>Debug</button>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search"
              className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm"
            />
            <label className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">BEFORE</span>
              <input
                type="number"
                min={0}
                max={CONTEXT_CAP}
                value={beforeContext}
                onChange={(e) => setBeforeContext(Math.max(0, Math.min(CONTEXT_CAP, Number(e.target.value) || 0)))}
                className="w-14 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">AFTER</span>
              <input
                type="number"
                min={0}
                max={CONTEXT_CAP}
                value={afterContext}
                onChange={(e) => setAfterContext(Math.max(0, Math.min(CONTEXT_CAP, Number(e.target.value) || 0)))}
                className="w-14 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
            </label>
            {uniqueProcessNames.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProcessFilterOpen((o) => !o)}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                >
                  Process: {selectedProcesses == null || selectedProcesses.length === 0 ? 'All' : `${selectedProcesses.length} selected`}
                </button>
                {processFilterOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[180px] rounded-md border border-border bg-popover p-2 shadow-md">
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent"
                      onClick={() => { setSelectedProcesses(null); setProcessFilterOpen(false); }}
                    >
                      Clear all
                    </button>
                    <div className="max-h-40 overflow-auto mt-1">
                      {uniqueProcessNames.map((name) => (
                        <label key={name} className="flex items-center gap-2 px-2 py-1 hover:bg-accent/50 rounded cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedProcesses != null && selectedProcesses.includes(name)}
                            onChange={() => {
                              setSelectedProcesses((prev) => {
                                const next = prev == null ? [] : [...prev];
                                const i = next.indexOf(name);
                                if (i >= 0) next.splice(i, 1);
                                else next.push(name);
                                return next.length ? next : null;
                              });
                            }}
                          />
                          <span className="text-sm truncate">{name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={() => jumpToError('prev')}
              disabled={errorIndices.length === 0}
              className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Previous error
            </button>
            <button
              type="button"
              onClick={() => jumpToError('next')}
              disabled={errorIndices.length === 0}
              className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              Next error
            </button>
            {fetchedLines.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {viewEntries.length} lines shown
                {matchIndices.length > 0 && ` (${matchIndices.length} matches)`}
              </span>
            )}
          </div>
          <div
            ref={viewStreamRef}
            className={cn(
              'rounded-md border border-input bg-muted/30 overflow-auto flex-1 min-h-[200px]',
              logStreamFullscreen ? 'h-full' : 'h-[60vh]'
            )}
            data-view-entries-container
          >
              <div className="font-mono text-xs leading-relaxed" data-view-entries>
                {viewEntries.map((entry, i) => {
                  const { line, parsed } = entry;
                  if (!parsed) {
                    return (
                      <div key={`${entry.index}-${i}`} className="px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    );
                  }
                  const { timestamp, level, kiosk, process: proc, pid, body } = parsed;
                  const s = levelStyle(level);
                  const badge = String(level || '?').toUpperCase();
                  const bodyStr = String(body ?? '').trimStart();
                  const parts = bodyStr.includes('#012') ? bodyStr.split('#012') : null;
                  const isCollapsed = parts && parts.length > 1 && !expandedTracebacks.has(entry.index);
                  const toggleTraceback = () => {
                    setExpandedTracebacks((prev) => {
                      const next = new Set(prev);
                      if (next.has(entry.index)) next.delete(entry.index);
                      else next.add(entry.index);
                      return next;
                    });
                  };
                  return (
                    <div
                      key={`${entry.index}-${i}`}
                      className={cn(
                        'px-4 py-0.5 border-b border-border/30 last:border-0 whitespace-pre-wrap break-all',
                        s.row
                      )}
                    >
                      <span className="text-muted-foreground">{timestamp}</span>
                      {' '}
                      <span className={cn('inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[0.65rem] leading-none border', s.badge)}>
                        {badge}
                      </span>
                      {' '}
                      <span className="text-violet-300">{kiosk}</span>
                      {' '}
                      <span className="text-cyan-300">KEYMELOG|{proc}[{pid}]</span>
                      <span className="text-muted-foreground">:</span>
                      <span className={cn('ml-1', level === 'd' ? 'text-muted-foreground' : 'text-foreground')}>
                        {parts && parts.length > 1
                          ? (
                              <>
                                {parts[0].trimStart()}
                                {isCollapsed ? (
                                  <button
                                    type="button"
                                    onClick={toggleTraceback}
                                    className="ml-2 text-xs text-primary hover:underline"
                                  >
                                    [+{parts.length - 1} lines]
                                  </button>
                                ) : (
                                  <>
                                    {parts.slice(1).map((p, j) => (
                                      <span key={j} className="block ml-2">{p.trimStart()}</span>
                                    ))}
                                    <button
                                      type="button"
                                      onClick={toggleTraceback}
                                      className="ml-2 text-xs text-primary hover:underline"
                                    >
                                      [collapse]
                                    </button>
                                  </>
                                )}
                              </>
                            )
                          : bodyStr}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
    </div>
  );
}

const CHART_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)',
  '#6366f1', '#14b8a6', '#f97316', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
];

/** Per-hour summary: buckets = { "2026-02-01T00": { count, byProcess: { PROCESS: { count } } }, ... }. Single metric. */
function AnalyzeSummaryView({ buckets }) {
  const [selectedProcesses, setSelectedProcesses] = useState(() => null);
  const [processDropdownOpen, setProcessDropdownOpen] = useState(false);
  const [chartType, setChartType] = useState('area'); // 'area' | 'bar' | 'pie'
  const processDropdownRef = useRef(null);

  const uniqueProcesses = useMemo(() => {
    if (!buckets || typeof buckets !== 'object') return [];
    const set = new Set();
    for (const v of Object.values(buckets)) {
      const byProcess = v?.byProcess;
      if (byProcess && typeof byProcess === 'object') {
        Object.keys(byProcess).forEach((p) => set.add(p));
      }
    }
    return Array.from(set).sort();
  }, [buckets]);

  const chartData = useMemo(() => {
    if (!buckets || typeof buckets !== 'object') return [];
    const entries = Object.entries(buckets).map(([hour, v]) => {
      let count = 0;
      if (selectedProcesses === null) {
        count = v?.count ?? 0;
      } else if (selectedProcesses.size > 0) {
        for (const p of selectedProcesses) {
          const bp = v?.byProcess?.[p];
          if (bp) count += bp.count ?? 0;
        }
      }
      return { hour, count };
    });
    return entries.sort((a, b) => a.hour.localeCompare(b.hour));
  }, [buckets, selectedProcesses]);

  /** Per-process totals (respects process filter) for bar/pie. */
  const perProcessData = useMemo(() => {
    if (!buckets || typeof buckets !== 'object') return [];
    const processes = selectedProcesses === null
      ? uniqueProcesses
      : selectedProcesses.size === 0
        ? []
        : Array.from(selectedProcesses).sort();
    const totals = {};
    for (const p of processes) {
      totals[p] = 0;
    }
    for (const v of Object.values(buckets)) {
      const byProcess = v?.byProcess;
      if (!byProcess || typeof byProcess !== 'object') continue;
      for (const p of processes) {
        totals[p] = (totals[p] ?? 0) + (byProcess[p]?.count ?? 0);
      }
    }
    return processes
      .map((p) => ({ process: p, count: totals[p] ?? 0 }))
      .filter((d) => d.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [buckets, selectedProcesses, uniqueProcesses]);

  const total = chartData.reduce((s, d) => s + d.count, 0);

  const toggleProcess = (p) => {
    setSelectedProcesses((prev) => {
      const next = prev === null ? new Set(uniqueProcesses) : new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      if (next.size === 0) return new Set();
      if (next.size === uniqueProcesses.length) return null;
      return next;
    });
  };

  useEffect(() => {
    if (!processDropdownOpen) return;
    const onDocClick = (e) => {
      if (processDropdownRef.current && !processDropdownRef.current.contains(e.target)) {
        setProcessDropdownOpen(false);
      }
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, [processDropdownOpen]);

  const [chartFullscreen, setChartFullscreen] = useState(false);

  const processLabel =
    selectedProcesses === null
      ? 'All'
      : selectedProcesses.size === 0
        ? 'None'
        : `${selectedProcesses.size} selected`;

  const hasAreaData = chartData.length > 0;
  const hasPerProcessData = perProcessData.length > 0;

  const chartElement = (() => {
    const tooltipStyle = { backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 };
    const labelStyle = { color: 'var(--foreground)' };
    if (chartType === 'area' && hasAreaData) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="hour" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area type="monotone" dataKey="count" name="Matches" fill="var(--chart-1)" stroke="var(--chart-1)" />
          </AreaChart>
        </ResponsiveContainer>
      );
    }
    if (chartType === 'bar' && hasPerProcessData) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={perProcessData} layout="vertical" margin={{ left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" allowDecimals={false} />
            <YAxis type="category" dataKey="process" width={120} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} />
            <Bar dataKey="count" name="Matches" fill="var(--chart-1)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      );
    }
    if (chartType === 'pie' && hasPerProcessData) {
      return (
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={perProcessData}
              dataKey="count"
              nameKey="process"
              cx="50%"
              cy="50%"
              outerRadius="70%"
              label={({ process, percent }) => `${process} ${(percent * 100).toFixed(1)}%`}
              labelLine
              fontSize={11}
            >
              {perProcessData.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} labelStyle={labelStyle} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    return null;
  })();

  const hasChart = chartElement != null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Total: {total}
        </p>
        {hasChart && (
          <button
            type="button"
            onClick={() => setChartFullscreen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs hover:bg-muted/50"
            title="Fullscreen graph"
          >
            <Maximize2 className="size-3.5" aria-hidden />
            Fullscreen
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative" ref={processDropdownRef}>
          <span className="text-xs font-medium text-muted-foreground block mb-1">Processes</span>
          <button
            type="button"
            onClick={() => setProcessDropdownOpen((o) => !o)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm text-left min-w-0 flex items-center justify-between gap-2"
          >
            <span className="truncate">{processLabel}</span>
            <span className="text-muted-foreground shrink-0" aria-hidden>▼</span>
          </button>
          {processDropdownOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] max-h-[280px] overflow-auto rounded-md border border-border bg-popover py-2 shadow-md">
              <div className="flex gap-2 text-xs px-2 pb-2 border-b border-border mb-2">
                <button type="button" onClick={() => { setSelectedProcesses(null); }} className="text-primary hover:underline">
                  All
                </button>
                <span className="text-muted-foreground">·</span>
                <button type="button" onClick={() => { setSelectedProcesses(new Set()); }} className="text-primary hover:underline">
                  None
                </button>
              </div>
              <div className="flex flex-col gap-0.5">
                {uniqueProcesses.map((p) => (
                  <label key={p} className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selectedProcesses === null || selectedProcesses.has(p)}
                      onChange={() => toggleProcess(p)}
                      className="rounded border-input"
                    />
                    <span className="text-sm truncate">{p}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-end gap-1">
          <span className="text-xs font-medium text-muted-foreground block mb-1 mr-2">Chart</span>
          <div className="flex rounded-md border border-input bg-muted/30 p-0.5">
            {[
              { id: 'area', label: 'By hour' },
              { id: 'bar', label: 'Bar (process)' },
              { id: 'pie', label: 'Pie (process)' },
            ].map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => setChartType(id)}
                className={cn(
                  'rounded px-2.5 py-1.5 text-xs font-medium transition-colors',
                  chartType === id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {hasChart ? (
        <div className="h-[300px] w-full">
          {chartElement}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-4">
          {chartType === 'area' ? 'No matches in selected range.' : 'No per-process data for selected processes.'}
        </p>
      )}
      {chartFullscreen && chartElement && createPortal(
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background"
          role="dialog"
          aria-modal="true"
          aria-label="Graph fullscreen"
        >
          <div className="flex items-center justify-end gap-2 p-2 border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => setChartFullscreen(false)}
              className="rounded-md p-2 hover:bg-muted"
              aria-label="Close fullscreen"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-4">
            {chartElement}
          </div>
        </div>,
        document.body
      )}
      <p className="text-sm text-muted-foreground">
        Summary by hour. Narrow the date range to see an event list.
      </p>
    </div>
  );
}

function ErrorsAndRestartsView({ events }) {
  const [processFilter, setProcessFilter] = useState('');
  const uniqueProcesses = useMemo(() => {
    const set = new Set(events.map((e) => e.process));
    return Array.from(set).sort();
  }, [events]);
  const filteredEvents = useMemo(() => {
    if (!processFilter) return events;
    return events.filter((e) => e.process === processFilter);
  }, [events, processFilter]);
  const chartData = useMemo(() => {
    const byDate = {};
    for (const e of filteredEvents) {
      const date = e.timestamp.slice(0, 10);
      if (!byDate[date]) byDate[date] = { date, errors: 0, restarts: 0 };
      if (e.type === 'error') byDate[date].errors += 1;
      else byDate[date].restarts += 1;
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredEvents]);
  const totalErrors = filteredEvents.filter((e) => e.type === 'error').length;
  const totalRestarts = filteredEvents.filter((e) => e.type === 'restart').length;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Total errors: {totalErrors} · Total restarts: {totalRestarts}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Process</span>
          <select
            value={processFilter}
            onChange={(e) => setProcessFilter(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[180px]"
          >
            <option value="">All</option>
            {uniqueProcesses.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      {chartData.length > 0 ? (
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" allowDecimals={false} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }}
                labelStyle={{ color: 'var(--foreground)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="errors" name="Errors" stackId="a" fill="var(--chart-1)" stroke="var(--chart-1)" />
              <Area type="monotone" dataKey="restarts" name="Restarts" stackId="a" fill="var(--chart-2)" stroke="var(--chart-2)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-4">No events in selected range.</p>
      )}
      <div>
        <h3 className="text-sm font-medium mb-2">Events</h3>
        <div className="rounded-md border border-input overflow-auto max-h-[40vh]">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr className="border-b border-border">
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Timestamp</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Process</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Type</th>
              </tr>
            </thead>
            <tbody>
              {filteredEvents.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-muted-foreground text-center">No events</td>
                </tr>
              ) : (
                filteredEvents.map((ev, i) => (
                  <tr key={i} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="px-3 py-1.5 font-mono text-xs">{ev.timestamp}</td>
                    <td className="px-3 py-1.5">{ev.process}</td>
                    <td className="px-3 py-1.5">
                      <span className={cn(
                        'inline-flex rounded px-1.5 py-0.5 text-xs',
                        ev.type === 'error' ? 'bg-red-500/20 text-red-200' : 'bg-amber-500/20 text-amber-200'
                      )}>
                        {ev.type}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function LogTailPage({ socket }) {
  const { kiosk: kioskName } = useParams();
  const [activeTab, setActiveTab] = useState('tail');
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
  const [selectedProcesses, setSelectedProcesses] = useState(null);
  const [processFilterOpen, setProcessFilterOpen] = useState(false);

  const [analyzeStartDatetime, setAnalyzeStartDatetime] = useState('');
  const [analyzeEndDatetime, setAnalyzeEndDatetime] = useState('');
  const [analyzePresetId, setAnalyzePresetId] = useState(() => (ANALYZE_PRESETS[0]?.id ?? 'build'));
  const [analyzeBuilderOpen, setAnalyzeBuilderOpen] = useState(false);
  const [analyzeCombineMode, setAnalyzeCombineMode] = useState('AND_OR');
  const [analyzeBuilder, setAnalyzeBuilder] = useState(() => ({
    processes: [],
    levels: [],
    messagePresetIds: [],
    messageCustom: '',
  }));
  const [analyzeBuckets, setAnalyzeBuckets] = useState(null);
  const [analyzeLoading, setAnalyzeLoading] = useState(false);
  const [analyzeError, setAnalyzeError] = useState(null);
  const analyzeStreamIdRef = useRef(null);

  // AI Log Analysis tab state
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiIdentifiers, setAiIdentifiers] = useState([]);
  const [aiApproximateDate, setAiApproximateDate] = useState('');
  const [aiThreadId, setAiThreadId] = useState(null);
  const [aiMessages, setAiMessages] = useState([]);
  const [aiGetIdsError, setAiGetIdsError] = useState(null);
  const [aiSessionLoading, setAiSessionLoading] = useState(false);
  const [aiSessionError, setAiSessionError] = useState(null);
  const [aiTurnLoading, setAiTurnLoading] = useState(false);
  const [aiConnectionStatus, setAiConnectionStatus] = useState('disconnected');
  const aiSocketRef = useRef(null);
  const aiChatScrollRef = useRef(null);

  const aiMaxDate = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const currentAnalyzePayload = useMemo(() => {
    if (analyzePresetId && analyzePresetId !== 'build') {
      const preset = ANALYZE_PRESETS.find((p) => p.id === analyzePresetId);
      return preset ? getPresetPayload(preset) : { processes: [], levels: [], message_regex: '', combine_mode: 'AND_OR' };
    }
    const { processes, levels, messagePresetIds, messageCustom } = analyzeBuilder;
    const message_regex = messagePresetIds.length
      ? messagePresetIds
          .map((id) => ANALYZE_MESSAGE_PRESETS.find((m) => m.id === id)?.message_regex)
          .filter(Boolean)
          .join('|')
      : (messageCustom || '').trim();
    return { processes: [...processes], levels: [...levels], message_regex, combine_mode: analyzeCombineMode };
  }, [analyzePresetId, analyzeBuilder, analyzeCombineMode]);

  const currentQueryLabel = useMemo(() => {
    if (analyzePresetId && analyzePresetId !== 'build') {
      const preset = ANALYZE_PRESETS.find((p) => p.id === analyzePresetId);
      return preset?.query ?? '';
    }
    const { processes, levels, messagePresetIds, messageCustom } = analyzeBuilder;
    const processPart = processes.length ? `process_name:${processes.length === 1 ? processes[0] : '(' + processes.join(' OR ') + ')'}` : '';
    const levelPart = levels.length ? `log_level:${levels.length === 1 ? levels[0] : '(' + levels.join(' OR ') + ')'}` : '';
    const messagePart = messagePresetIds.length
      ? `message:${messagePresetIds.map((id) => ANALYZE_MESSAGE_PRESETS.find((m) => m.id === id)?.label).filter(Boolean).join(' OR ')}`
      : messageCustom.trim() ? `message:/${messageCustom.replace(/[/\\]/g, '\\$&')}/` : '';
    if (!processPart && !levelPart && !messagePart) return '(no filter)';
    if (analyzeCombineMode === 'AND') {
      return [processPart, levelPart, messagePart].filter(Boolean).join(' AND ');
    }
    if (analyzeCombineMode === 'AND_OR') {
      const rest = [levelPart, messagePart].filter(Boolean);
      if (processPart && rest.length) return `${processPart} AND (${rest.join(' OR ')})`;
      if (processPart) return processPart;
      return rest.length === 2 ? `(${rest.join(' OR ')})` : rest[0];
    }
    return [processPart, levelPart, messagePart].filter(Boolean).join(' OR ');
  }, [analyzePresetId, analyzeBuilder, analyzeCombineMode]);

  // AI socket: connect when on AI tab, disconnect when leaving
  useEffect(() => {
    if (activeTab !== 'ai') {
      if (aiSocketRef.current) {
        aiSocketRef.current.disconnect();
        aiSocketRef.current = null;
      }
      setAiConnectionStatus('disconnected');
      return;
    }
    const sock = createAiSocket();
    aiSocketRef.current = sock;
    setAiConnectionStatus('connecting');
    sock.onConnect(() => setAiConnectionStatus('connected'));
    sock.onDisconnect(() => setAiConnectionStatus('disconnected'));
    sock.connect();
    return () => {
      sock.disconnect();
      aiSocketRef.current = null;
    };
  }, [activeTab]);

  useEffect(() => {
    aiChatScrollRef.current?.scrollTo({ top: aiChatScrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [aiMessages]);

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

  const uniqueProcessNames = useMemo(() => {
    const set = new Set();
    for (const line of renderLines) {
      const p = parseKeyMeLine(line)?.process;
      if (p) set.add(p);
    }
    return Array.from(set).sort();
  }, [renderLines]);

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
      if (isAllLog && selectedProcesses != null && selectedProcesses.length > 0) {
        const proc = parsed?.process;
        if (!proc || !selectedProcesses.includes(proc)) continue;
      }
      out.push({ line, parsed, level: lvl });
    }
    return out;
  }, [renderLines, searchQuery, matchCase, levelFilter, isAllLog, selectedProcesses]);

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
    socket.requestIfSupported('get_log_list').then((res) => {
      if (res?.success && res?.data?.logs) {
        setLogs(res.data.logs);
        if (!logId && res.data.logs.length > 0) {
          setLogId(res.data.logs[0].id);
        }
      } else {
        setError(res?.errors?.join(', ') || 'Failed to load log list');
      }
    }).catch((err) => {
      setError(err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Failed to load log list'));
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
        socket.requestIfSupported('log_tail_stop').catch(() => {});
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
    socket.requestIfSupported('log_tail_stop').catch(() => {});
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
    socket.requestIfSupported('log_tail_start', { log_id: selected, initial_lines: n }).then((res) => {
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
      setError(err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Failed to start tail'));
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
    socket.requestIfSupported('log_tail_stop').catch(() => {});
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

      <div className="flex gap-1 border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('tail')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md border border-b-0 -mb-px',
            activeTab === 'tail'
              ? 'bg-background border-border'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          Tail (Live)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('view')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md border border-b-0 -mb-px',
            activeTab === 'view'
              ? 'bg-background border-border'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          View (Range)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('analyze')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md border border-b-0 -mb-px',
            activeTab === 'analyze'
              ? 'bg-background border-border'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          Analyze (Insights)
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('ai')}
          className={cn(
            'px-4 py-2 text-sm font-medium rounded-t-md border border-b-0 -mb-px',
            activeTab === 'ai'
              ? 'bg-background border-border'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          AI Log Analysis
        </button>
      </div>

      {activeTab === 'tail' && (
        <>
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

            {isAllLog && (
              <div className="relative">
                <span className="text-xs font-medium text-muted-foreground block mb-1">Process filter</span>
                <button
                  type="button"
                  onClick={() => setProcessFilterOpen((o) => !o)}
                  className="min-w-[140px] rounded-md border border-input bg-background px-3 py-2 text-sm text-left flex items-center justify-between gap-2"
                >
                  <span className="truncate">
                    {selectedProcesses == null || selectedProcesses.length === 0
                      ? 'Clear all'
                      : `${selectedProcesses.length} selected`}
                  </span>
                </button>
                {processFilterOpen && (
                  <div className="absolute left-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-border bg-popover p-2 shadow-md">
                    <button
                      type="button"
                      className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent"
                      onClick={() => { setSelectedProcesses(null); setProcessFilterOpen(false); }}
                    >
                      Clear all
                    </button>
                    <div className="border-t border-border mt-2 pt-2 max-h-48 overflow-auto">
                      <p className="text-xs text-muted-foreground px-2 pb-1">Select some:</p>
                      {uniqueProcessNames.map((name) => {
                        const checked = selectedProcesses != null && selectedProcesses.includes(name);
                        return (
                          <label key={name} className="flex items-center gap-2 px-2 py-1 hover:bg-accent/50 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setSelectedProcesses((prev) => {
                                  const next = prev == null ? [] : [...prev];
                                  const i = next.indexOf(name);
                                  if (i >= 0) next.splice(i, 1);
                                  else next.push(name);
                                  return next.length ? next : null;
                                });
                              }}
                            />
                            <span className="text-sm truncate">{name}</span>
                          </label>
                        );
                      })}
                      {uniqueProcessNames.length === 0 && (
                        <p className="text-xs text-muted-foreground px-2 py-1">No processes in buffer</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

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
        </>
      )}

      {activeTab === 'view' && (
        <ViewTab socket={socket} />
      )}

      {activeTab === 'analyze' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Run an analysis on all.log for the selected datetime range. Select a preset or build your own query. Only aggregated output is shown. Query typing or direct editing is not available at this time.
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Start date</span>
                  <input
                    type="datetime-local"
                    value={analyzeStartDatetime}
                    onChange={(e) => setAnalyzeStartDatetime(e.target.value)}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <span className="pb-2 text-muted-foreground">→</span>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">End date</span>
                  <input
                    type="datetime-local"
                    value={analyzeEndDatetime}
                    onChange={(e) => setAnalyzeEndDatetime(e.target.value)}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                  />
                </label>
                <div className="flex-1 min-w-[120px]" />
                <button
                  type="button"
                  onClick={() => {
                    const start = analyzeStartDatetime.trim();
                    const end = analyzeEndDatetime.trim();
                    if (!start || !end) {
                      setAnalyzeError('Enter start and end date/time');
                      return;
                    }
                    setAnalyzeError(null);
                    setAnalyzeBuckets(null);
                    setAnalyzeLoading(true);
                    const streamId = Date.now();
                    analyzeStreamIdRef.current = streamId;

                    const onResult = (data) => {
                      if (data?.stream_id !== analyzeStreamIdRef.current) return;
                      setAnalyzeBuckets(data?.buckets ?? {});
                      setAnalyzeLoading(false);
                      socket.off('log_analyze_result', onResult);
                    };

                    socket.on('log_analyze_result', onResult);

                    socket.requestIfSupported('run_log_analyze', {
                      start_datetime: start,
                      end_datetime: end,
                      ...currentAnalyzePayload,
                      stream_id: streamId,
                    }).then((res) => {
                      if (!res?.success || !res?.data?.started) {
                        setAnalyzeLoading(false);
                        setAnalyzeError(res?.errors?.join(', ') || 'Analysis failed');
                        socket.off('log_analyze_result', onResult);
                      }
                    }).catch((err) => {
                      setAnalyzeLoading(false);
                      setAnalyzeError(err?.message || 'Analysis failed');
                      socket.off('log_analyze_result', onResult);
                    });
                  }}
                  disabled={!socket?.connected || analyzeLoading || !analyzeStartDatetime.trim() || !analyzeEndDatetime.trim()}
                  className={cn(
                    'shrink-0 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                    'bg-primary text-primary-foreground hover:bg-primary/90',
                    'disabled:opacity-50 disabled:pointer-events-none'
                  )}
                >
                  {analyzeLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                  Run analysis
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Query</span>
                <input
                  readOnly
                  value={currentQueryLabel}
                  placeholder="(no filter)"
                  className="w-full rounded-md border border-input bg-muted/30 px-3 py-2 text-sm font-mono placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Mode:</span>
                <select
                  value={analyzePresetId === 'build' ? '' : analyzePresetId}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAnalyzePresetId(v || 'build');
                    if (v) setAnalyzeBuilderOpen(false);
                  }}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm min-w-[180px]"
                >
                  {ANALYZE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="">Custom</option>
                </select>
                <span className="text-muted-foreground text-sm">|</span>
                <button
                  type="button"
                  onClick={() => {
                    setAnalyzePresetId('build');
                    setAnalyzeBuilderOpen(true);
                  }}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    analyzePresetId === 'build'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-input bg-background hover:bg-muted/50'
                  )}
                >
                  Custom
                </button>
              </div>
              {analyzePresetId === 'build' && analyzeBuilderOpen && (
                <div className="rounded-md border border-input bg-muted/20 p-4 space-y-4">
                  <span className="text-xs font-medium text-muted-foreground">Build custom query</span>
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="text-xs text-muted-foreground">Combine:</span>
                    <select
                      value={analyzeCombineMode}
                      onChange={(e) => setAnalyzeCombineMode(e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                      aria-label="Combine clauses"
                    >
                      <option value="AND_OR">Process and (level or message)</option>
                      <option value="OR">Match any (OR)</option>
                      <option value="AND">Match all (AND)</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-6">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">Processes</span>
                      <div className="flex flex-wrap gap-2 max-h-[120px] overflow-auto">
                        {ANALYZE_PROCESS_NAMES.map((p) => (
                          <label key={p} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              checked={analyzeBuilder.processes.includes(p)}
                              onChange={() => {
                                setAnalyzeBuilder((prev) => ({
                                  ...prev,
                                  processes: prev.processes.includes(p)
                                    ? prev.processes.filter((x) => x !== p)
                                    : [...prev.processes, p],
                                }));
                              }}
                              className="rounded border-input"
                            />
                            {p}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">Log level</span>
                      <div className="flex flex-wrap gap-2">
                        {ANALYZE_LEVELS.map(({ value, label }) => (
                          <label key={value} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              checked={analyzeBuilder.levels.includes(value)}
                              onChange={() => {
                                setAnalyzeBuilder((prev) => ({
                                  ...prev,
                                  levels: prev.levels.includes(value)
                                    ? prev.levels.filter((x) => x !== value)
                                    : [...prev.levels, value],
                                }));
                              }}
                              className="rounded border-input"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">Message (presets)</span>
                      <div className="flex flex-wrap gap-2 max-h-[100px] overflow-auto">
                        {ANALYZE_MESSAGE_PRESETS.map((m) => (
                          <label key={m.id} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              checked={analyzeBuilder.messagePresetIds.includes(m.id)}
                              onChange={() => {
                                setAnalyzeBuilder((prev) => ({
                                  ...prev,
                                  messagePresetIds: prev.messagePresetIds.includes(m.id)
                                    ? prev.messagePresetIds.filter((x) => x !== m.id)
                                    : [...prev.messagePresetIds, m.id],
                                }));
                              }}
                              className="rounded border-input"
                            />
                            {m.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">Message (custom regex)</span>
                      <input
                        type="text"
                        value={analyzeBuilder.messageCustom}
                        onChange={(e) => setAnalyzeBuilder((prev) => ({ ...prev, messageCustom: e.target.value }))}
                        placeholder="optional"
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm w-64"
                      />
                    </div>
                  </div>
                </div>
              )}
              {analyzeError && <p className="text-sm text-destructive" role="alert">{analyzeError}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Message count</CardTitle>
            </CardHeader>
            <CardContent>
              {analyzeLoading ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Running…
                </p>
              ) : analyzeBuckets !== null ? (
                <AnalyzeSummaryView buckets={analyzeBuckets} />
              ) : (
                <p className="text-sm text-muted-foreground">Run an analysis to see output.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'ai' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">Kiosk:</span>
                <span className="rounded-md border border-input bg-muted/30 px-2 py-1 font-mono">
                  {kioskName || '(select a kiosk in the URL)'}
                </span>
                <span className="text-muted-foreground">Date:</span>
                <input
                  type="date"
                  value={aiApproximateDate}
                  onChange={(e) => setAiApproximateDate(e.target.value)}
                  max={aiMaxDate}
                  title="Approximate log date (today or earlier)"
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                />
                <span className={cn(
                  'rounded px-2 py-0.5 text-xs',
                  aiConnectionStatus === 'connected' && 'bg-green-500/20 text-green-700 dark:text-green-400',
                  aiConnectionStatus === 'connecting' && 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
                  aiConnectionStatus === 'disconnected' && 'bg-muted text-muted-foreground'
                )}>
                  {aiConnectionStatus === 'connected' ? 'Connected' : aiConnectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
                </span>
              </div>

              <div className="space-y-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Question (must include one of: session ID, scan ID, transaction ID, testcut ID, or date/time — at least the hour)
                  </span>
                  <textarea
                    value={aiQuestion}
                    onChange={(e) => setAiQuestion(e.target.value)}
                    placeholder="e.g. Tell me why session_id 8a6a49b0-e430-11f0-b7d2-7bf5f7dc4479 was send to beta instead of prod"
                    rows={2}
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm w-full placeholder:text-muted-foreground"
                  />
                </label>
                <button
                  type="button"
                  disabled={!aiSocketRef.current?.connected || aiSessionLoading || !kioskName || !aiApproximateDate.trim() || !aiQuestion.trim()}
                  onClick={async () => {
                    setAiSessionError(null);
                    setAiGetIdsError(null);
                    setAiMessages([]);
                    setAiThreadId(null);
                    setAiIdentifiers([]);
                    setAiSessionLoading(true);
                    const question = aiQuestion.trim();
                    try {
                      const idsRes = await aiSocketRef.current.request('ai_get_identifiers', { question });
                      if (!idsRes.success || !idsRes.result?.identifiers?.length) {
                        setAiGetIdsError(idsRes.error || idsRes.result?.error_message || 'No identifiers extracted. Include a session ID, scan ID, transaction ID, testcut ID, or date and time.');
                        setAiSessionLoading(false);
                        return;
                      }
                      const identifiers = idsRes.result.identifiers;
                      setAiIdentifiers(identifiers);
                      setAiMessages((prev) => [
                        ...prev,
                        { role: 'user', text: question },
                        { role: 'assistant', text: '' },
                      ]);
                      const res = await aiSocketRef.current.request(
                        'ai_log_session',
                        {
                          kiosk_name: kioskName,
                          approximate_date: aiApproximateDate.trim(),
                          identifiers,
                          first_question: question,
                        },
                        {
                          onStreamDelta: (delta) => {
                            setAiMessages((prev) => {
                              const next = [...prev];
                              const last = next[next.length - 1];
                              if (last?.role === 'assistant')
                                next[next.length - 1] = { ...last, text: last.text + delta };
                              return next;
                            });
                          },
                        }
                      );
                      if (res.success && res.result) {
                        setAiThreadId(res.result.thread_id);
                        setAiMessages((prev) => {
                          const next = [...prev];
                          const last = next[next.length - 1];
                          if (last?.role === 'assistant' && last.text === '' && res.result?.result != null)
                            next[next.length - 1] = { ...last, text: String(res.result.result) };
                          return next;
                        });
                      } else {
                        setAiSessionError(res.error || 'Session failed');
                        setAiMessages((prev) => {
                          const next = [...prev];
                          if (next.length && next[next.length - 1].role === 'assistant' && next[next.length - 1].text === '')
                            next[next.length - 1] = { ...next[next.length - 1], text: res?.error || 'Session failed' };
                          return next;
                        });
                      }
                    } catch (e) {
                      setAiSessionError(e?.message || 'Failed to start analysis');
                      setAiMessages((prev) => {
                        const next = [...prev];
                        if (next.length && next[next.length - 1].role === 'assistant' && next[next.length - 1].text === '')
                          next[next.length - 1] = { ...next[next.length - 1], text: `Error: ${e?.message ?? 'Failed'}` };
                        return next;
                      });
                    } finally {
                      setAiSessionLoading(false);
                    }
                  }}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium',
                    'bg-primary text-primary-foreground hover:bg-primary/90',
                    'disabled:opacity-50 disabled:pointer-events-none'
                  )}
                >
                  {aiSessionLoading ? <Loader2 className="size-3 animate-spin" /> : null}
                  Start analysis
                </button>
                {(aiGetIdsError || aiSessionError) && (
                  <p className="text-sm text-destructive" role="alert">{aiGetIdsError || aiSessionError}</p>
                )}
                {aiIdentifiers.length > 0 && !aiSessionError && (
                  <p className="text-sm text-muted-foreground">
                    Identifiers used: <span className="font-mono">{aiIdentifiers.join(', ')}</span>
                  </p>
                )}
              </div>

              {(aiThreadId || aiMessages.length > 0) && (
                <div className="space-y-2">
                  <div
                    ref={aiChatScrollRef}
                    className="rounded-md border border-input bg-muted/20 min-h-[200px] max-h-[calc(100vh-280px)] overflow-y-auto p-3 space-y-3 flex flex-col"
                  >
                    {aiMessages.map((m, i) => (
                      <div
                        key={i}
                        className={cn(
                          'rounded px-3 py-2 text-sm shrink-0',
                          m.role === 'user' ? 'bg-primary/10 text-primary-foreground ml-4' : 'bg-muted/50 mr-4'
                        )}
                      >
                        <span className="font-medium text-xs text-muted-foreground">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                        <div className="mt-1 whitespace-pre-wrap">
                          {m.role === 'assistant' && m.text === '' ? (
                            <span className="inline-flex items-center gap-2 text-muted-foreground">
                              <Loader2 className="size-4 animate-spin shrink-0" aria-hidden />
                              Thinking…
                            </span>
                          ) : (
                            m.text
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const input = e.currentTarget.querySelector('input[name="ai-turn-text"]');
                      const text = (input?.value ?? '').trim();
                      if (!text || !aiSocketRef.current?.connected || aiTurnLoading || !aiThreadId) return;
                      input.value = '';
                      setAiMessages((prev) => [
                        ...prev,
                        { role: 'user', text },
                        { role: 'assistant', text: '' },
                      ]);
                      setAiTurnLoading(true);
                      try {
                        const res = await aiSocketRef.current.request(
                          'ai_turn',
                          { thread_id: aiThreadId, text },
                          {
                            onStreamDelta: (delta) => {
                              setAiMessages((prev) => {
                                const next = [...prev];
                                const last = next[next.length - 1];
                                if (last?.role === 'assistant')
                                  next[next.length - 1] = { ...last, text: last.text + delta };
                                return next;
                              });
                            },
                          }
                        );
                        if (res.success && res.result != null) {
                          setAiMessages((prev) => {
                            const next = [...prev];
                            const last = next[next.length - 1];
                            if (last?.role === 'assistant' && last.text === '')
                              next[next.length - 1] = { ...last, text: String(res.result) };
                            return next;
                          });
                        } else {
                          setAiMessages((prev) => {
                            const next = [...prev];
                            if (next.length && next[next.length - 1].role === 'assistant' && next[next.length - 1].text === '')
                              next[next.length - 1] = { ...next[next.length - 1], text: '(No response)' };
                            return next;
                          });
                        }
                      } catch (err) {
                        setAiMessages((prev) => {
                          const next = [...prev];
                          if (next.length && next[next.length - 1].role === 'assistant' && next[next.length - 1].text === '')
                            next[next.length - 1] = { ...next[next.length - 1], text: `Error: ${err?.message ?? 'Request failed'}` };
                          return next;
                        });
                      } finally {
                        setAiTurnLoading(false);
                      }
                    }}
                  >
                    <input
                      type="text"
                      name="ai-turn-text"
                      placeholder="Follow-up question…"
                      className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      disabled={!aiThreadId || aiTurnLoading}
                    />
                    <button
                      type="submit"
                      disabled={!aiThreadId || aiTurnLoading}
                      className={cn(
                        'shrink-0 inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium',
                        'bg-primary text-primary-foreground hover:bg-primary/90',
                        'disabled:opacity-50 disabled:pointer-events-none'
                      )}
                    >
                      {aiTurnLoading ? <Loader2 className="size-4 animate-spin" /> : null}
                      Send
                    </button>
                  </form>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
