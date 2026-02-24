import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { cn } from '@/lib/utils';
import { ERROR_UNSUPPORTED_COMMAND, UNSUPPORTED_FEATURE_MESSAGE } from '@/lib/deviceSocket';
import { Package, Loader2, X } from 'lucide-react';

const SEGMENT_COUNT = 20;
const DEG_PER_SEG = 360 / SEGMENT_COUNT;

function segmentState(mag, lowThreshold) {
  if (!mag || mag.milling == null || mag.style == null || String(mag.milling) === 'None') return 'empty';
  if (!mag.in_stock) return 'disabled';
  if (mag.count < lowThreshold) return 'low';
  return 'enabled';
}

function segmentColor(state) {
  switch (state) {
    case 'empty': return '#94a3b8';
    case 'disabled': return '#ef4444';
    case 'low': return '#eab308';
    case 'enabled': return '#22c55e';
    default: return '#94a3b8';
  }
}

export default function InventoryPage({ connected, socket }) {
  const [magazines, setMagazines] = useState([]);
  const [lowInventoryThreshold, setLowInventoryThreshold] = useState(10);
  const [disabledReasons, setDisabledReasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedMagazine, setSelectedMagazine] = useState(null);
  const [hoveredMagazine, setHoveredMagazine] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);
  const [disableReason, setDisableReason] = useState('');
  const [newCount, setNewCount] = useState('');

  const isDisabled = !connected || !socket?.connected;

  const fetchInventory = useCallback(() => {
    if (!socket?.requestIfSupported) return;
    setError(null);
    setLoading(true);
    Promise.all([
      socket.requestIfSupported('get_inventory_list'),
      socket.requestIfSupported('get_inventory_disabled_reasons'),
    ])
      .then(([listRes, reasonsRes]) => {
        if (listRes?.success && listRes.data) {
          setMagazines(listRes.data.magazines || []);
          setLowInventoryThreshold(listRes.data.low_inventory_threshold ?? 10);
        }
        if (reasonsRes?.success && reasonsRes.data?.reasons) {
          setDisabledReasons(reasonsRes.data.reasons);
        }
      })
      .catch((err) => {
        const msg = err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Failed to load inventory');
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [socket]);

  useEffect(() => {
    fetchInventory();
  }, [fetchInventory]);

  const handleSelect = (magNum) => {
    setSelectedMagazine(magNum);
    setDrawerOpen(true);
    setActionMessage(null);
    const mag = magazines[magNum - 1];
    setNewCount(mag?.count != null ? String(mag.count) : '');
    setDisableReason('');
  };

  const handleCloseDrawer = () => {
    setDrawerOpen(false);
  };

  const showActionMessage = (message, isError = false) => {
    setActionMessage({ text: message, isError });
  };

  const runAction = (event, data) => {
    if (!socket?.requestIfSupported || actionLoading || isDisabled) return;
    setActionMessage(null);
    setActionLoading(true);
    socket
      .requestIfSupported(event, data)
      .then((res) => {
        if (res?.success) {
          showActionMessage('Success.');
          fetchInventory();
        } else {
          showActionMessage((res?.errors || ['Request failed']).join('; '), true);
        }
      })
      .catch((err) => {
        showActionMessage(
          err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Request failed'),
          true
        );
      })
      .finally(() => setActionLoading(false));
  };

  const handleEnable = () => {
    if (selectedMagazine == null) return;
    runAction('inventory_enable_magazine', { magazine: selectedMagazine });
  };

  const handleDisable = () => {
    if (selectedMagazine == null || !disableReason) return;
    runAction('inventory_disable_magazine', { magazine: selectedMagazine, reason: disableReason });
  };

  const handleSetCount = () => {
    if (selectedMagazine == null) return;
    const n = parseInt(newCount, 10);
    if (isNaN(n) || n < 0) {
      showActionMessage('Enter a non-negative number.', true);
      return;
    }
    runAction('inventory_set_key_count', { magazine: selectedMagazine, new_count: n });
  };

  const selectedMag = selectedMagazine != null ? magazines[selectedMagazine - 1] : null;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <PageTitle icon={Package}>Inventory</PageTitle>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>Loading inventory…</span>
        </div>
      ) : (
        <div className="flex flex-1 gap-8 items-start">
          {/* Donut - larger, with segment gap and clearer labels */}
          <Card className="shrink-0 overflow-visible">
            <CardContent className="p-6">
              <div className="relative h-[420px] w-[420px]">
                <svg viewBox="0 0 100 100" className="size-full drop-shadow-md" aria-label="Magazine donut">
                  <defs>
                    <filter id="donut-shadow" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="1" stdDeviation="0.5" floodOpacity="0.15" />
                    </filter>
                    <linearGradient id="donut-inner" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--card))" />
                      <stop offset="100%" stopColor="hsl(var(--muted))" />
                    </linearGradient>
                  </defs>
                  {/* Inner circle (donut hole) */}
                  <circle cx="50" cy="50" r="24" fill="url(#donut-inner)" filter="url(#donut-shadow)" />
                  {Array.from({ length: SEGMENT_COUNT }, (_, i) => {
                    const magNum = i + 1;
                    const mag = magazines[i];
                    const state = segmentState(mag, lowInventoryThreshold);
                    const fillColor = segmentColor(state);
                    const startAngle = -90 + i * DEG_PER_SEG;
                    const endAngle = startAngle + DEG_PER_SEG;
                    const rad = (deg) => (deg * Math.PI) / 180;
                    const r1 = 24;
                    const r2 = 42;
                    const cx = 50;
                    const cy = 50;
                    const x1 = cx + r2 * Math.cos(rad(startAngle));
                    const y1 = cy + r2 * Math.sin(rad(startAngle));
                    const x2 = cx + r2 * Math.cos(rad(endAngle));
                    const y2 = cy + r2 * Math.sin(rad(endAngle));
                    const x3 = cx + r1 * Math.cos(rad(endAngle));
                    const y3 = cy + r1 * Math.sin(rad(endAngle));
                    const x4 = cx + r1 * Math.cos(rad(startAngle));
                    const y4 = cy + r1 * Math.sin(rad(startAngle));
                    const large = DEG_PER_SEG > 180 ? 1 : 0;
                    const d = `M ${x1} ${y1} A ${r2} ${r2} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r1} ${r1} 0 ${large} 0 ${x4} ${y4} Z`;
                    const midAngle = (startAngle + endAngle) / 2;
                    const labelR = (r1 + r2) / 2;
                    const lx = cx + labelR * Math.cos(rad(midAngle));
                    const ly = cy + labelR * Math.sin(rad(midAngle));
                    const isSelected = selectedMagazine === magNum;
                    const isHovered = hoveredMagazine === magNum;
                    return (
                      <g key={magNum} filter="url(#donut-shadow)">
                        <path
                          d={d}
                          fill={fillColor}
                          stroke="hsl(var(--card))"
                          strokeWidth={0.4}
                          className="cursor-pointer transition-all duration-150"
                          style={{ opacity: isSelected || isHovered ? 1 : 0.92 }}
                          onClick={() => handleSelect(magNum)}
                          onMouseEnter={() => setHoveredMagazine(magNum)}
                          onMouseLeave={() => setHoveredMagazine(null)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSelect(magNum)}
                          role="button"
                          tabIndex={0}
                          aria-label={`Magazine ${magNum}, ${mag?.count ?? 0} keys`}
                        />
                        {(isSelected || isHovered) && (
                          <path
                            d={d}
                            fill="none"
                            stroke="hsl(var(--primary))"
                            strokeWidth={isSelected ? 1.2 : 1}
                            className="pointer-events-none"
                            style={{ opacity: isHovered && !isSelected ? 0.7 : 1 }}
                          />
                        )}
                        <text
                          x={lx}
                          y={ly - 3}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="white"
                          fontSize="3.2"
                          fontWeight="600"
                          style={{ textShadow: '0 0 2px rgba(0,0,0,0.5)' }}
                        >
                          #{String(magNum).padStart(2, '0')}
                        </text>
                        <text
                          x={lx}
                          y={ly + 4.5}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="white"
                          fontSize="4"
                          fontWeight="700"
                          style={{ textShadow: '0 0 2px rgba(0,0,0,0.5)' }}
                        >
                          {mag?.count ?? '—'}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </CardContent>
          </Card>

          {/* Table - natural height, no forced scroll */}
          <Card className="min-w-0 flex-1">
            <CardContent className="p-0">
              <div className="overflow-auto min-h-0">
                <table className="w-full text-sm">
                  <thead className="bg-muted/80">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Magazine</th>
                      <th className="px-3 py-2 text-right font-medium">Stock</th>
                      <th className="px-3 py-2 text-left font-medium">Milling</th>
                      <th className="px-3 py-2 text-left font-medium">Paint Style</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Manufacturer</th>
                      <th className="px-3 py-2 text-right font-medium">Enabled Days</th>
                      <th className="px-3 py-2 text-right font-medium">Disabled Days</th>
                      <th className="px-3 py-2 text-left font-medium">QR Code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(magazines.length ? magazines : Array.from({ length: 20 }, (_, i) => ({ magazine: i + 1, count: 0, in_stock: false }))).map((mag) => {
                      const magNum = mag.magazine ?? 0;
                      const isSelected = selectedMagazine === magNum;
                      const isHovered = hoveredMagazine === magNum;
                      return (
                        <tr
                          key={magNum}
                          className={cn(
                            'border-t border-border cursor-pointer transition-colors',
                            isHovered && 'bg-muted/70',
                            isSelected && 'bg-primary/10'
                          )}
                          onClick={() => handleSelect(magNum)}
                          onMouseEnter={() => setHoveredMagazine(magNum)}
                          onMouseLeave={() => setHoveredMagazine(null)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSelect(magNum)}
                          role="button"
                          tabIndex={0}
                        >
                          <td className="px-3 py-1.5">{magNum}</td>
                          <td className="px-3 py-1.5 text-right">{mag.count ?? 0}</td>
                          <td className="px-3 py-1.5">{mag.milling ?? '—'}</td>
                          <td className="px-3 py-1.5">{mag.display_name ?? mag.style ?? '—'}</td>
                          <td className="px-3 py-1.5">
                            {mag.in_stock ? 'enabled' : `disabled${mag.disabled_reason ? ` (${mag.disabled_reason})` : ''}`}
                          </td>
                          <td className="px-3 py-1.5">{mag.manufacturer ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right">{mag.enabled_days ?? 0}</td>
                          <td className="px-3 py-1.5 text-right">{mag.disabled_days ?? 0}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{mag.qr_code ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Right-side drawer */}
      {drawerOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            aria-hidden
            onClick={handleCloseDrawer}
          />
          <aside
            className="fixed right-0 top-0 z-50 flex h-full w-[320px] flex-col border-l border-border bg-card shadow-lg"
            role="dialog"
            aria-label="Magazine controls"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">
                {selectedMagazine != null ? `Controls – Magazine ${selectedMagazine}` : 'Select a magazine'}
              </h2>
              <button
                type="button"
                onClick={handleCloseDrawer}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close drawer"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-1 flex-col gap-4 overflow-auto p-4">
              {selectedMagazine == null ? (
                <p className="text-sm text-muted-foreground">Click a segment or table row to select a magazine.</p>
              ) : (
                <>
                  {selectedMag && (
                    <p className="text-xs text-muted-foreground">
                      {selectedMag.milling ?? '—'} / {selectedMag.display_name ?? selectedMag.style ?? '—'} · {selectedMag.count ?? 0} keys · {selectedMag.in_stock ? 'enabled' : 'disabled'}
                    </p>
                  )}
                  {actionMessage && (
                    <p className={cn('text-sm', actionMessage.isError ? 'text-destructive' : 'text-emerald-600')}>
                      {actionMessage.text}
                    </p>
                  )}
                  <div className="flex flex-col gap-3">
                    <div>
                      <button
                        type="button"
                        disabled={isDisabled || actionLoading}
                        onClick={handleEnable}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {actionLoading ? <Loader2 className="size-4 animate-spin" /> : 'Enable'}
                      </button>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor="inv-disable-reason" className="text-xs font-medium">
                        Disable reason
                      </label>
                      <select
                        id="inv-disable-reason"
                        value={disableReason}
                        onChange={(e) => setDisableReason(e.target.value)}
                        disabled={isDisabled || actionLoading}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                      >
                        <option value="">Select reason</option>
                        {disabledReasons.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={isDisabled || actionLoading || !disableReason}
                        onClick={handleDisable}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Disable
                      </button>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label htmlFor="inv-new-count" className="text-xs font-medium">
                        Set count
                      </label>
                      <input
                        id="inv-new-count"
                        type="number"
                        min={0}
                        value={newCount}
                        onChange={(e) => setNewCount(e.target.value)}
                        disabled={isDisabled || actionLoading}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={isDisabled || actionLoading}
                        onClick={handleSetCount}
                        className="rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        Update count
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
