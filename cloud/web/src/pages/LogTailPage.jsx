import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { ScrollText, Play, Square, Download, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// KeyMe log format from setup/salt/logs/lnav_keyme.json (keymev3 pattern)
const KEYME_LOG_REGEX = /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\d*-\d{2}:\d{2} <(?<level>.)> (?<kiosk>[^ ]+) KEYMELOG\|(?<process>[^[]+)\[(?<pid>\d+)\]: (?<body>.*)/;
const LEVEL_MAP = { e: 'error', c: 'critical', w: 'warning', i: 'info', d: 'debug' };

function parseKeyMeLine(line) {
  const m = String(line).match(KEYME_LOG_REGEX);
  if (!m || !m.groups) return null;
  const { timestamp, level, kiosk, process: proc, pid, body } = m.groups;
  return { timestamp, level, kiosk, process: proc, pid, body };
}

function levelClass(level) {
  if (level === 'e' || level === 'c') return 'text-destructive';
  if (level === 'w') return 'text-amber-600';
  if (level === 'd') return 'text-muted-foreground';
  return '';
}

function LogLine({ line }) {
  const parsed = parseKeyMeLine(line);
  if (!parsed) {
    return <div className="font-mono text-xs text-foreground whitespace-pre-wrap break-all">{line}</div>;
  }
  const { timestamp, level, process: proc, pid, body } = parsed;
  const cls = levelClass(level);
  return (
    <div className={cn('font-mono text-xs whitespace-pre-wrap break-all', cls)}>
      <span className="text-muted-foreground shrink-0">{timestamp}</span>
      {' '}
      <span className="text-muted-foreground shrink-0">{proc}[{pid}]:</span>
      {' '}
      <span>{body}</span>
    </div>
  );
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

const INITIAL_LINES_DEFAULT = 50;
const INITIAL_LINES_MAX = 200;

export default function LogTailPage({ socket }) {
  const [logs, setLogs] = useState([]);
  const [logId, setLogId] = useState('');
  const [initialLines, setInitialLines] = useState(INITIAL_LINES_DEFAULT);
  const [lines, setLines] = useState([]);
  const [tailing, setTailing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentLogLabel, setCurrentLogLabel] = useState('');
  const logEndRef = useRef(null);
  const onTailLineRef = useRef(null);

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

  useEffect(() => {
    fetchLogList();
  }, [fetchLogList]);

  useEffect(() => {
    if (!socket) return;
    return () => {
      if (tailing) {
        socket.request('log_tail_stop').catch(() => {});
      }
      socket.off('log_tail_line', onTailLineRef.current);
    };
  }, [socket, tailing]);

  const startTail = useCallback(() => {
    if (!socket?.connected || tailing || loading) return;
    const selected = logId || (logs[0]?.id);
    if (!selected) return;
    setLoading(true);
    setError(null);
    setLines([]);
    const label = logs.find((l) => l.id === selected)?.label || selected;
    setCurrentLogLabel(label);

    const onTailLine = (data) => {
      if (data?.line != null) {
        setLines((prev) => [...prev, data.line]);
      }
    };
    onTailLineRef.current = onTailLine;
    socket.on('log_tail_line', onTailLine);

    const n = Math.min(INITIAL_LINES_MAX, Math.max(1, Number(initialLines) || INITIAL_LINES_DEFAULT));
    socket.request('log_tail_start', { log_id: selected, initial_lines: n }).then((res) => {
      setLoading(false);
      setTailing(true);
      if (res?.success && res?.data?.lines) {
        setLines(res.data.lines);
      } else if (res && !res.success) {
        setError(res.errors?.join(', ') || 'Failed to start tail');
        socket.off('log_tail_line', onTailLineRef.current);
      }
    }).catch((err) => {
      setLoading(false);
      setError(err?.message || 'Failed to start tail');
      socket.off('log_tail_line', onTailLineRef.current);
    });
  }, [socket, logId, logs, initialLines, tailing, loading]);

  const stopTail = useCallback(() => {
    if (!socket?.connected || !tailing) return;
    socket.off('log_tail_line', onTailLineRef.current);
    onTailLineRef.current = null;
    socket.request('log_tail_stop').catch(() => {});
    setTailing(false);
  }, [socket, tailing]);

  useEffect(() => {
    if (lines.length > 0 && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lines.length]);

  const selectedLog = logs.find((l) => l.id === logId);
  const isAllLog = selectedLog?.type === 'all';
  const canDownload = lines.length > 0;

  return (
    <div className="space-y-6">
      <PageTitle icon={ScrollText}>Device logs</PageTitle>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Tail a log</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Choose a log file and start tailing. Only one log can be tailed at a time. Initial lines (max {INITIAL_LINES_MAX}) are loaded, then new lines stream in.
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground space-y-1.5">
            <p className="font-medium text-foreground">Log types</p>
            <p>
              <strong>/var/log/keyme/processes/[PROCESS_NAME].log</strong> — Main log for each process (KeyMe/syslog format). Use for normal runtime logs.
            </p>
            <p>
              <strong>/tmp/[PROCESS_NAME].stdout</strong> and <strong>/tmp/[PROCESS_NAME].stderr</strong> — Process standard output and standard error. Use when a process fails to start or to see Python tracebacks and uncaught errors.
            </p>
            <p>
              <strong>/var/log/keyme/all.log</strong> — Combined stream of all processes. High volume; use when you need a single chronological view across the kiosk.
            </p>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}
          {isAllLog && (
            <p className="flex items-center gap-2 text-sm text-amber-600" role="status">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              High volume; display may be throttled. Be mindful of data usage costs.
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
                onChange={(e) => setInitialLines(Number(e.target.value) || INITIAL_LINES_DEFAULT)}
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
                onClick={() => downloadLog(lines, currentLogLabel)}
                disabled={!canDownload}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium border border-input hover:bg-accent',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                <Download className="size-4 shrink-0" aria-hidden />
                Download
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {(lines.length > 0 || tailing) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {currentLogLabel || 'Log output'}
              {tailing && <span className="ml-2 text-muted-foreground font-normal">(live)</span>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="rounded-md border border-input bg-muted/30 p-3 max-h-[60vh] overflow-auto font-mono text-xs"
              role="log"
              aria-live={tailing ? 'polite' : 'off'}
            >
              {lines.map((line, i) => (
                <div key={i} className="border-b border-border/50 last:border-0 py-0.5">
                  <LogLine line={line} />
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
