import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { Heart, Check, ChevronDown, ChevronRight, X, AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const STEPS = [
  'software', 'speedtest', 'signal', 'modem_resets', 'camera_box',
  'cuts', 'card_usage', 'funnel', 'memory',
];

const STEP_LABELS = {
  software: 'Software version',
  speedtest: 'Speedtest',
  signal: 'Signal quality',
  modem_resets: 'Modem resets',
  camera_box: 'Camera box',
  cuts: 'Cuts',
  card_usage: 'Card usage',
  funnel: 'Funnel & payment',
  memory: 'Memory',
};

function SeverityIcon({ severity }) {
  if (severity === 'ok') return <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />;
  if (severity === 'warn') return <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-hidden />;
  return <X className="size-4 shrink-0 text-destructive" aria-hidden />;
}

function worstSeverity(items) {
  if (!items?.length) return 'ok';
  if (items.some((i) => i.severity === 'error')) return 'error';
  if (items.some((i) => i.severity === 'warn')) return 'warn';
  return 'ok';
}

function countsFromProgress(progress) {
  let ok = 0, warn = 0, err = 0;
  for (const p of progress) {
    for (const it of p.summary_items || []) {
      if (it.severity === 'ok') ok += 1;
      else if (it.severity === 'warn') warn += 1;
      else err += 1;
    }
  }
  return { ok, warn, err };
}

export default function WellnessCheck({ socket }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState([]);

  const runCheck = useCallback(() => {
    if (!socket || loading) return;
    setLoading(true);
    setResult(null);
    setProgress([]);

    const onProgress = (payload) => {
      if (payload && payload.step) {
        setProgress((prev) => [...prev, { ...payload }]);
      }
    };

    socket.on('wellness_progress', onProgress);

    socket.request('get_wellness_check').then((res) => {
      socket.off('wellness_progress', onProgress);
      setLoading(false);
      if (res && res.success && res.data && typeof res.data === 'object') {
        setResult(res.data);
      } else if (res && !res.success) {
        setResult({ error: res.errors?.join(', ') || 'Request failed' });
      }
    }).catch(() => {
      socket.off('wellness_progress', onProgress);
      setLoading(false);
    });
  }, [socket, loading]);

  useEffect(() => {
    return () => {
      if (socket) socket.off('wellness_progress');
    };
  }, [socket]);

  const hasError = result && result.error;
  const progressByStep = Object.fromEntries(progress.map((p) => [p.step, p]));
  const currentStep = STEPS.find((s) => !progressByStep[s]);
  const { ok, warn, err } = countsFromProgress(progress);
  const hasProgress = progress.length > 0;
  const runComplete = !loading && hasProgress && !hasError;
  const runLabel = runComplete ? 'Run again' : 'Run wellness check';

  return (
    <div className="space-y-6">
      <PageTitle icon={Heart}>Wellness Check</PageTitle>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Run check</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Run system diagnostics (software, speedtest, signal, modem resets, camera box, cuts, card usage, funnel, memory). Report-only; no restarts.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={runCheck}
              disabled={loading || !socket?.connected}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:pointer-events-none'
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                  Running…
                </>
              ) : (
                runLabel
              )}
            </button>
            {runComplete && (
              <span className="text-xs text-muted-foreground">
                Last run completed. Click to rerun.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {hasError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <X className="size-4 shrink-0" aria-hidden />
              Error
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-foreground/90">{result.error}</p>
            <button
              type="button"
              onClick={runCheck}
              disabled={!socket?.connected}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
                'bg-primary text-primary-foreground hover:bg-primary/90',
                'disabled:opacity-50 disabled:pointer-events-none'
              )}
            >
              Run again
            </button>
          </CardContent>
        </Card>
      )}

      {hasProgress && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="m-0 flex flex-col gap-2 p-0 list-none">
              {STEPS.map((step) => {
                const p = progressByStep[step];
                const label = STEP_LABELS[step] || step;
                const running = loading && currentStep === step;
                return (
                  <li key={step} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-sm">
                      {p ? (
                        <SeverityIcon severity={worstSeverity(p.summary_items)} />
                      ) : running ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                      ) : (
                        <span className="size-4 shrink-0" />
                      )}
                      <span className={cn(
                        running && 'text-muted-foreground',
                        p && 'font-medium'
                      )}>
                        {label}
                        {running && ' — running…'}
                      </span>
                    </div>
                    {p?.summary_items?.length > 0 && (
                      <ul className="ml-6 flex flex-col gap-0.5 text-xs text-muted-foreground list-none">
                        {p.summary_items.map((it, i) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <SeverityIcon severity={it.severity} />
                            <span>{it.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {!loading && hasProgress && !hasError && (ok > 0 || warn > 0 || err > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Health overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-6 text-sm">
              <span className="flex items-center gap-1.5">
                <Check className="size-4 text-emerald-500" aria-hidden />
                {ok} OK
              </span>
              <span className="flex items-center gap-1.5">
                <AlertTriangle className="size-4 text-amber-500" aria-hidden />
                {warn} warnings
              </span>
              <span className="flex items-center gap-1.5">
                <X className="size-4 text-destructive" aria-hidden />
                {err} errors
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && hasProgress && !hasError && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">Results by section</CardTitle>
            <button
              type="button"
              onClick={runCheck}
              disabled={!socket?.connected}
              className={cn(
                'rounded-md border border-border bg-muted/50 px-3 py-1.5 text-sm font-medium',
                'hover:bg-muted hover:text-foreground',
                'disabled:opacity-50 disabled:pointer-events-none'
              )}
            >
              Run again
            </button>
          </CardHeader>
          <CardContent className="space-y-4">
            {STEPS.map((step) => {
              const p = progressByStep[step];
              if (!p) return null;
              const label = STEP_LABELS[step] || step;
              const sev = worstSeverity(p.summary_items);
              return (
                <SectionCard
                  key={step}
                  step={step}
                  label={label}
                  severity={sev}
                  summaryItems={p.summary_items || []}
                  detailedKey={p.detailed_key}
                  detailedValue={p.detailed_value}
                />
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SectionCard({ step, label, severity, summaryItems, detailedKey, detailedValue }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = detailedKey && typeof detailedValue === 'string' && detailedValue.length > 0;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium',
          'hover:bg-muted/50'
        )}
        aria-expanded={expanded}
      >
        {hasDetail ? (
          expanded ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />
        ) : (
          <span className="w-4" />
        )}
        <SeverityIcon severity={severity} />
        <span>{label}</span>
      </button>
      <div className="border-t border-border bg-muted/10 px-3 py-2 space-y-2">
        {summaryItems.length > 0 && (
          <ul className="m-0 flex flex-col gap-1 p-0 list-none text-sm">
            {summaryItems.map((it, i) => (
              <li key={i} className="flex items-start gap-2">
                <SeverityIcon severity={it.severity} />
                <span className={cn(
                  it.severity === 'ok' && 'text-foreground',
                  it.severity === 'warn' && 'text-amber-600 dark:text-amber-400',
                  it.severity === 'error' && 'text-destructive'
                )}>
                  {it.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hasDetail && expanded && (
          <pre className="m-0 max-h-60 overflow-auto rounded bg-muted/30 p-2 whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {detailedValue}
          </pre>
        )}
      </div>
    </div>
  );
}
