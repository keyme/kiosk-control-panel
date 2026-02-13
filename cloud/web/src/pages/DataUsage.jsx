import { useState, useMemo, useCallback, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { cn } from '@/lib/utils';
import { BarChart3, Loader2, RefreshCw, ArrowUpDown, Search, Info, Download, Maximize2, X } from 'lucide-react';
import {
  PieChart, Pie, Cell, Tooltip as RTooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as BarTooltip,
} from 'recharts';

// ── Helpers ──────────────────────────────────────────────────────────────────

const EXCLUDED_PROCESSES = ['AUTOCAL'];

const CHART_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
  'var(--chart-4)', 'var(--chart-5)',
  '#6366f1', '#14b8a6', '#f97316', '#8b5cf6', '#ec4899',
  '#06b6d4', '#84cc16', '#f43f5e', '#a78bfa', '#22d3ee',
];

function fmtBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(2) : val < 100 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function processUsage(netData, excludeAutocal) {
  if (!netData) return [];
  const entries = [];
  for (const [proc, val] of Object.entries(netData)) {
    if (proc === 'total_recv_bytes' || proc === 'total_sent_bytes') continue;
    if (excludeAutocal && EXCLUDED_PROCESSES.some((ex) => proc.toUpperCase().includes(ex))) continue;
    const recv = val?.recv_bytes ?? 0;
    const sent = val?.sent_bytes ?? 0;
    entries.push({ process: proc, recv, sent, total: recv + sent });
  }
  entries.sort((a, b) => b.total - a.total);
  return entries;
}

function totalsFromNetData(netData) {
  return {
    recv: netData?.total_recv_bytes ?? 0,
    sent: netData?.total_sent_bytes ?? 0,
  };
}

const TABS = [
  { id: 'daily', label: 'Daily' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'running', label: 'Running Totals' },
];

// ── Sub-components ───────────────────────────────────────────────────────────

function SummaryCards({ recv, sent }) {
  const total = recv + sent;
  return (
    <div className="grid grid-cols-3 gap-4">
      {[
        { label: 'Total Received', value: recv },
        { label: 'Total Sent', value: sent },
        { label: 'Combined', value: total },
      ].map(({ label, value }) => (
        <Card key={label} className="py-4">
          <CardContent className="flex flex-col items-center gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="text-lg font-semibold">{fmtBytes(value)}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UsagePieChart({ data }) {
  if (!data.length) return <p className="text-sm text-muted-foreground text-center py-8">No data</p>;
  // Combine small slices into "Other"
  const totalAll = data.reduce((s, d) => s + d.total, 0);
  const threshold = totalAll * 0.02;
  const slices = [];
  let otherTotal = 0;
  for (const d of data) {
    if (d.total < threshold) { otherTotal += d.total; } else { slices.push(d); }
  }
  if (otherTotal > 0) slices.push({ process: 'Other', total: otherTotal });

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={300}>
      <PieChart>
        <Pie data={slices} dataKey="total" nameKey="process" cx="50%" cy="50%" outerRadius="70%"
          label={({ process, percent }) => `${process} ${(percent * 100).toFixed(1)}%`}
          labelLine={true} fontSize={11}
        >
          {slices.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <RTooltip formatter={(v) => fmtBytes(v)} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function UsageBarChart({ barData }) {
  if (!barData.length) return <p className="text-sm text-muted-foreground text-center py-8">No data</p>;
  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={300}>
      <BarChart data={barData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
        <YAxis tickFormatter={fmtBytes} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" width={70} />
        <BarTooltip formatter={(v) => fmtBytes(v)} labelStyle={{ color: 'var(--foreground)' }}
          contentStyle={{ backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8 }} />
        <Bar dataKey="recv" name="Received" stackId="a" fill="var(--chart-1)" radius={[0, 0, 0, 0]} />
        <Bar dataKey="sent" name="Sent" stackId="a" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function useFullscreen() {
  const [fs, setFs] = useState(false);

  useEffect(() => {
    if (!fs) return;
    const onKey = (e) => { if (e.key === 'Escape') setFs(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fs]);

  useEffect(() => {
    if (fs) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [fs]);

  return [fs, setFs];
}

function FullscreenButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Fullscreen"
      className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      <Maximize2 className="size-3.5" />
    </button>
  );
}

function FullscreenOverlay({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h2 className="text-sm font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium border border-input hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <X className="size-4" />
          Close
        </button>
      </div>
      <div className="flex-1 p-6 min-h-0">
        {children}
      </div>
    </div>
  );
}

function ProcessTable({ data, search, setSearch, sortCol, sortDir, onSort }) {
  const sorted = useMemo(() => {
    const filtered = search
      ? data.filter((d) => d.process.toLowerCase().includes(search.toLowerCase()))
      : data;
    return [...filtered].sort((a, b) => {
      const m = sortDir === 'asc' ? 1 : -1;
      if (sortCol === 'process') return m * a.process.localeCompare(b.process);
      return m * (a[sortCol] - b[sortCol]);
    });
  }, [data, search, sortCol, sortDir]);

  const thClass = 'px-3 py-2 text-left text-xs font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors';
  const tdClass = 'px-3 py-2 text-sm';

  function SortHeader({ col, children }) {
    const active = sortCol === col;
    return (
      <th className={thClass} onClick={() => onSort(col)}>
        <span className="inline-flex items-center gap-1">
          {children}
          <ArrowUpDown className={cn('size-3', active ? 'text-foreground' : 'text-muted-foreground/40')} />
        </span>
      </th>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search processes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-input bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <div className="overflow-auto rounded-md border">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b bg-muted/50">
              <SortHeader col="process">Process</SortHeader>
              <SortHeader col="recv">Received</SortHeader>
              <SortHeader col="sent">Sent</SortHeader>
              <SortHeader col="total">Total</SortHeader>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">No processes found</td></tr>
            ) : sorted.map((row) => (
              <tr key={row.process} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className={cn(tdClass, 'font-mono text-xs')}>{row.process}</td>
                <td className={tdClass}>{fmtBytes(row.recv)}</td>
                <td className={tdClass}>{fmtBytes(row.sent)}</td>
                <td className={cn(tdClass, 'font-medium')}>{fmtBytes(row.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Date selector ────────────────────────────────────────────────────────────

function DateSelector({ dates, selected, onSelect }) {
  if (!dates.length) return null;
  return (
    <select
      value={selected}
      onChange={(e) => onSelect(e.target.value)}
      className="rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {dates.map((d) => (
        <option key={d} value={d}>{d}</option>
      ))}
    </select>
  );
}

// ── Running totals sub-selector ──────────────────────────────────────────────

const RUNNING_TOTAL_KEYS = [
  { id: 'daily', label: 'Today (running)' },
  { id: 'monthly', label: 'This Month (running)' },
  { id: 'last_1h', label: 'Last 1 Hour' },
  { id: 'currently_tracked', label: 'Currently tracked' },
];

// ── Download helpers ─────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadJSON(rawData) {
  const blob = new Blob([JSON.stringify(rawData, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `data_usage_${new Date().toISOString().slice(0, 10)}.json`);
}

function downloadCSV(rawData) {
  const rows = [['source', 'period', 'process', 'recv_bytes', 'sent_bytes']];

  for (const [source, periods] of Object.entries(rawData)) {
    if (!periods || typeof periods !== 'object') continue;
    for (const [period, fileData] of Object.entries(periods)) {
      const nd = fileData?.NetDataUsage || fileData;
      if (!nd || typeof nd !== 'object') continue;
      for (const [proc, val] of Object.entries(nd)) {
        if (proc === 'total_recv_bytes' || proc === 'total_sent_bytes') continue;
        if (!val || typeof val !== 'object') continue;
        rows.push([source, period, proc, val.recv_bytes ?? 0, val.sent_bytes ?? 0]);
      }
    }
  }

  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  triggerDownload(blob, `data_usage_${new Date().toISOString().slice(0, 10)}.csv`);
}

function DownloadButton({ rawData }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        )}
      >
        <Download className="size-4 shrink-0" aria-hidden />
        Download
      </button>
      {open && (
        <>
          {/* Backdrop to close */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md">
            <button
              type="button"
              className="w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => { downloadJSON(rawData); setOpen(false); }}
            >
              JSON
            </button>
            <button
              type="button"
              className="w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => { downloadCSV(rawData); setOpen(false); }}
            >
              CSV
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ChartCards({ tab, procData, barData }) {
  const [pieFs, setPieFs] = useFullscreen();
  const [barFs, setBarFs] = useFullscreen();
  const barTitle = `${tab === 'daily' ? 'Daily' : 'Monthly'} Usage Over Time`;

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage by Process</CardTitle>
            <CardAction><FullscreenButton onClick={() => setPieFs(true)} /></CardAction>
          </CardHeader>
          <CardContent className="h-[300px]">
            <UsagePieChart data={procData} />
          </CardContent>
        </Card>
        {tab !== 'running' && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{barTitle}</CardTitle>
              <CardAction><FullscreenButton onClick={() => setBarFs(true)} /></CardAction>
            </CardHeader>
            <CardContent className="h-[300px]">
              <UsageBarChart barData={barData} />
            </CardContent>
          </Card>
        )}
      </div>
      {pieFs && (
        <FullscreenOverlay title="Usage by Process" onClose={() => setPieFs(false)}>
          <UsagePieChart data={procData} />
        </FullscreenOverlay>
      )}
      {barFs && (
        <FullscreenOverlay title={barTitle} onClose={() => setBarFs(false)}>
          <UsageBarChart barData={barData} />
        </FullscreenOverlay>
      )}
    </>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function DataUsage({ socket }) {
  const [loading, setLoading] = useState(false);
  const [rawData, setRawData] = useState(null);
  const [error, setError] = useState(null);

  // UI state
  const [tab, setTab] = useState('daily');
  const [excludeAutocal, setExcludeAutocal] = useState(true);
  const [selectedDate, setSelectedDate] = useState('');
  const [runningKey, setRunningKey] = useState('daily');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('total');
  const [sortDir, setSortDir] = useState('desc');

  const fetchData = useCallback(() => {
    if (!socket || loading) return;
    setLoading(true);
    setError(null);
    socket.emit('get_data_usage', (res) => {
      setLoading(false);
      if (!res) {
        setError('No response from device');
        return;
      }
      if (res.success === false) {
        setError(res.errors?.join(', ') || 'Unknown error');
        return;
      }
      const data = res.data || res;
      setRawData(data);
      // Auto-select latest date
      if (data.daily) {
        const keys = Object.keys(data.daily).sort();
        if (keys.length) setSelectedDate((prev) => prev || keys[keys.length - 1]);
      }
    });
  }, [socket, loading]);

  const onSort = useCallback((col) => {
    setSortCol((prev) => {
      if (prev === col) { setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); return col; }
      setSortDir('desc');
      return col;
    });
  }, []);

  // Derive current view data
  const { currentNetData, dates, barData } = useMemo(() => {
    if (!rawData) return { currentNetData: null, dates: [], barData: [] };

    if (tab === 'daily') {
      const allDates = Object.keys(rawData.daily || {}).sort();
      const sel = allDates.includes(selectedDate) ? selectedDate : allDates[allDates.length - 1] || '';
      const nd = rawData.daily?.[sel]?.NetDataUsage || null;
      const bd = allDates.map((d) => {
        const du = rawData.daily[d]?.NetDataUsage || {};
        return { date: d, recv: du.total_recv_bytes || 0, sent: du.total_sent_bytes || 0 };
      });
      return { currentNetData: nd, dates: allDates, barData: bd };
    }

    if (tab === 'monthly') {
      const allDates = Object.keys(rawData.monthly || {}).sort();
      const sel = allDates.includes(selectedDate) ? selectedDate : allDates[allDates.length - 1] || '';
      const nd = rawData.monthly?.[sel]?.NetDataUsage || null;
      const bd = allDates.map((d) => {
        const du = rawData.monthly[d]?.NetDataUsage || {};
        return { date: d, recv: du.total_recv_bytes || 0, sent: du.total_sent_bytes || 0 };
      });
      return { currentNetData: nd, dates: allDates, barData: bd };
    }

    // running totals
    const nd = rawData.running_totals?.[runningKey]?.NetDataUsage || null;
    return { currentNetData: nd, dates: [], barData: [] };
  }, [rawData, tab, selectedDate, runningKey]);

  const procData = useMemo(() => processUsage(currentNetData, excludeAutocal), [currentNetData, excludeAutocal]);
  const totals = useMemo(() => totalsFromNetData(currentNetData), [currentNetData]);

  const runningTotalMeta = useMemo(() => {
    if (tab !== 'running' || !rawData?.running_totals?.[runningKey]) return null;
    const rt = rawData.running_totals[runningKey];
    const first = rt?.first_update ?? null;
    const last = rt?.last_update ?? null;
    if (!first && !last) return null;
    return { first_update: first, last_update: last };
  }, [tab, rawData, runningKey]);

  const hasFetched = rawData !== null;
  const btnLabel = loading ? 'Fetching…' : hasFetched ? 'Refresh' : 'Fetch Data';

  return (
    <div className="space-y-6">
      <PageTitle icon={BarChart3}>Data Usage</PageTitle>

      <p className="text-sm text-muted-foreground leading-relaxed -mt-4 mb-2">
        Network data usage per process, monitored by SYSTEM_MONITOR using{' '}
        <span className="font-mono text-xs">libnethogs</span>. Traffic is captured at the OS level and
        aggregated by process name every 10 seconds. These numbers may not exactly match what Cradlepoint
        or cellular provider reports, as the measurement points differ. Use this data to identify
        which processes are consuming the most bandwidth and to guide optimization of data-heavy services.
      </p>

      {/* Fetch button */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-4 pt-1">
          <button
            type="button"
            onClick={fetchData}
            disabled={loading || !socket?.connected}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              'disabled:opacity-50 disabled:pointer-events-none'
            )}
          >
            {loading ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="size-4 shrink-0" aria-hidden />
            )}
            {btnLabel}
          </button>
          {hasFetched && !loading && <DownloadButton rawData={rawData} />}
          {hasFetched && !loading && (
            <span className="text-xs text-muted-foreground">Data loaded. Click Refresh to update.</span>
          )}
          {!hasFetched && !loading && (
            <span className="text-xs text-muted-foreground">Click to load data usage from the device.</span>
          )}
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!hasFetched && !loading && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            Click <strong>Fetch Data</strong> to load usage information from the device.
          </CardContent>
        </Card>
      )}

      {/* Data view */}
      {hasFetched && (
        <>
          {/* Tabs + controls */}
          <Card>
            <CardContent className="space-y-4">
              {/* Tabs */}
              <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => { setTab(t.id); setSearch(''); }}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      tab === t.id
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Date selector / running total selector */}
              <div className="flex flex-wrap items-center gap-4">
                {tab !== 'running' && dates.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      {tab === 'daily' ? 'Date:' : 'Month:'}
                    </span>
                    <DateSelector dates={dates} selected={selectedDate} onSelect={setSelectedDate} />
                  </div>
                )}
                {tab === 'running' && (
                  <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
                    {RUNNING_TOTAL_KEYS.map((rk) => (
                      <button
                        key={rk.id}
                        type="button"
                        onClick={() => setRunningKey(rk.id)}
                        className={cn(
                          'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                          runningKey === rk.id
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {rk.label}
                      </button>
                    ))}
                  </div>
                )}
                {/* AUTOCAL toggle */}
                <label className="inline-flex items-center gap-2 ml-auto cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={excludeAutocal}
                    onChange={(e) => setExcludeAutocal(e.target.checked)}
                    className="size-4 rounded border-input accent-primary"
                  />
                  <span className="text-sm">Exclude AUTOCAL</span>
                  <span className="relative group">
                    <Info className="size-3.5 text-muted-foreground" />
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-md bg-popover border border-border p-2 text-xs text-popover-foreground shadow-md opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                      AUTOCAL makes requests to the modem that stay within the local network. They should not count toward data usage but cannot be distinguished from outbound traffic in the logs.
                    </span>
                  </span>
                </label>
              </div>
            </CardContent>
          </Card>

          {runningTotalMeta && (
            <p className="text-xs text-muted-foreground">
              Tracking period: {runningTotalMeta.first_update ?? '—'} → {runningTotalMeta.last_update ?? '—'}
            </p>
          )}

          {/* Summary */}
          <SummaryCards recv={totals.recv} sent={totals.sent} />

          {/* Charts */}
          <ChartCards tab={tab} procData={procData} barData={barData} />

          {/* Process table */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Process Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <ProcessTable
                data={procData}
                search={search}
                setSearch={setSearch}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={onSort}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
