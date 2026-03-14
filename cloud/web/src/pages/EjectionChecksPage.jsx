import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/apiFetch';
import { ERROR_UNSUPPORTED_COMMAND, UNSUPPORTED_FEATURE_MESSAGE } from '@/lib/deviceSocket';

const KEY_HEAD_FILENAME_REGEX = /key[_-]head_check/i;

function filterKeyHeadSections(sections) {
  if (!sections || typeof sections !== 'object') return {};
  return Object.fromEntries(
    Object.entries(sections)
      .map(([name, images]) => {
        const filtered = (images || []).filter(
          (img) => img && typeof img.filename === 'string' && KEY_HEAD_FILENAME_REGEX.test(img.filename)
        );
        return filtered.length > 0 ? [name, filtered] : null;
      })
      .filter(Boolean)
  );
}

function parseMagazineFromFilename(filename) {
  if (!filename || typeof filename !== 'string') return null;
  const m = filename.match(/^[^_]+_(\d+)_/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export default function EjectionChecksPage({ kioskName, socket }) {
  const [startId, setStartId] = useState('');
  const [endId, setEndId] = useState('');
  const [specificIds, setSpecificIds] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null); // [{ id, sections }] or [{ id, error }]

  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [inventoryError, setInventoryError] = useState(null);
  const [magazines, setMagazines] = useState([]);
  const [millings, setMillings] = useState([]);
  const [stylesByMilling, setStylesByMilling] = useState({});

  const [updateModal, setUpdateModal] = useState(null); // { id, image, mag, milling, style, count }
  const [updateLoading, setUpdateLoading] = useState(false);
  const [updateError, setUpdateError] = useState(null);
  const [updateSuccess, setUpdateSuccess] = useState(null);

  const fetchInventory = useCallback(() => {
    if (!socket?.requestIfSupported) return;
    setInventoryError(null);
    Promise.all([
      socket.requestIfSupported('get_inventory_list'),
      socket.requestIfSupported('get_inventory_millings_styles'),
    ])
      .then(([listRes, millingsRes]) => {
        if (listRes?.success && listRes.data) {
          setMagazines(listRes.data.magazines || []);
          setInventoryLoaded(true);
        }
        if (millingsRes?.success && millingsRes.data) {
          setMillings(millingsRes.data.millings || []);
          setStylesByMilling(millingsRes.data.styles_by_milling || {});
        }
      })
      .catch((err) => {
        const msg =
          err?.code === ERROR_UNSUPPORTED_COMMAND
            ? UNSUPPORTED_FEATURE_MESSAGE
            : err?.message || 'Failed to load inventory';
        setInventoryError(msg);
        setInventoryLoaded(false);
      });
  }, [socket]);

  useEffect(() => {
    if (!socket?.requestIfSupported) return;
    fetchInventory();
  }, [socket, fetchInventory]);

  const handleShow = async () => {
    if (!kioskName) {
      setError('Kiosk name not available.');
      return;
    }

    let ids = [];

    // If the user entered specific IDs, use those instead of the range.
    if (specificIds.trim()) {
      ids = specificIds
        .split(/[,\s]+/)
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => parseInt(v, 10))
        .filter((n) => !Number.isNaN(n));
      if (ids.length === 0) {
        setError('Please enter at least one valid test cut ID.');
        return;
      }
    } else {
      const start = parseInt(startId, 10);
      const end = parseInt(endId, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) {
        setError('Please enter valid start and end test cut IDs, or specific IDs.');
        return;
      }
      if (start > end) {
        setError('Start ID must be less than or equal to end ID.');
        return;
      }
      for (let i = start; i <= end; i += 1) ids.push(i);
    }

    // De-duplicate and sort for stable display
    ids = Array.from(new Set(ids)).sort((a, b) => a - b);

    if (ids.length > 50) {
      setError('Please use 50 test cut IDs or fewer.');
      return;
    }

    setError(null);
    setLoading(true);
    setResults(null);

    try {
      const payload = await Promise.all(
        ids.map(async (id) => {
          const res = await apiFetch(
            `/api/calibration/testcuts/images?kiosk=${encodeURIComponent(kioskName)}&id=${id}`
          );
          if (!res.ok) return { id, error: res.statusText || 'Failed to load' };
          const sections = await res.json();
          const keyHeadOnly = filterKeyHeadSections(sections);
          return { id, sections: keyHeadOnly };
        })
      );
      setResults(payload);
    } catch (e) {
      setError(e.message || 'Failed to load images');
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Ejection Checks</CardTitle>
          <p className="text-muted-foreground text-sm">
            Enter a range or list of test cut IDs to view key head check images only.
          </p>
          {inventoryError && (
            <p className="mt-2 text-destructive text-xs">
              Inventory data unavailable: {inventoryError}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Start test cut ID</span>
              <input
                type="number"
                min="1"
                value={startId}
                onChange={(e) => setStartId(e.target.value)}
                placeholder="e.g. 133"
                className="w-32 rounded border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">End test cut ID</span>
              <input
                type="number"
                min="1"
                value={endId}
                onChange={(e) => setEndId(e.target.value)}
                placeholder="e.g. 136"
                className="w-32 rounded border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <span className="text-muted-foreground text-xs">or</span>
            <label className="flex flex-col gap-1 flex-1 min-w-[240px]">
              <span className="text-sm font-medium">Specific IDs (comma or space separated)</span>
              <input
                type="text"
                value={specificIds}
                onChange={(e) => setSpecificIds(e.target.value)}
                placeholder="e.g. 133, 135 140"
                className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <button
              type="button"
              onClick={handleShow}
              disabled={loading}
              className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Show key head images'}
            </button>
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}

          {results && (
            <div className="mt-6 space-y-6">
              <h3 className="text-sm font-medium">Key head check images</h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((item) => (
                  <Card key={item.id}>
                    <CardHeader className="py-3">
                      <CardTitle className="text-base">ID: {item.id}</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      {item.error && (
                        <p className="text-muted-foreground text-sm">{item.error}</p>
                      )}
                      {item.sections && Object.keys(item.sections).length === 0 && (
                        <p className="text-muted-foreground text-sm">
                          No key head image for this ID.
                        </p>
                      )}
                      {item.sections &&
                        Object.entries(item.sections).map(([, images]) =>
                          images.map((img) => {
                            const mag = parseMagazineFromFilename(img.filename);
                            const magInfo =
                              mag != null
                                ? magazines.find((m) => m.magazine === mag) || null
                                : null;
                            return (
                              <div key={img.key} className="mb-3 space-y-2">
                                <img
                                  src={img.url}
                                  alt={img.filename}
                                  className="max-h-64 w-auto max-w-full rounded border border-border object-contain"
                                />
                                <p className="text-muted-foreground text-xs break-all">
                                  {img.filename}
                                </p>
                                {mag != null && (
                                  <p className="text-muted-foreground text-xs">
                                    Magazine: {mag}
                                    {magInfo?.milling && magInfo?.style
                                      ? ` • ${magInfo.milling} / ${magInfo.style}`
                                      : ''}
                                  </p>
                                )}
                                <button
                                  type="button"
                                  disabled={!inventoryLoaded || mag == null || !socket?.requestIfSupported}
                                  className="rounded border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                                  onClick={() => {
                                    if (mag == null) return;
                                    const current =
                                      magazines.find((m) => m.magazine === mag) || {};
                                    setUpdateModal({
                                      id: item.id,
                                      image: img,
                                      mag,
                                      milling:
                                        current.milling != null &&
                                        String(current.milling) !== 'None'
                                          ? String(current.milling)
                                          : '',
                                      style:
                                        current.style != null &&
                                        String(current.style) !== 'None'
                                          ? String(current.style)
                                          : '',
                                      count:
                                        current.count != null
                                          ? String(current.count)
                                          : '',
                                    });
                                    setUpdateError(null);
                                    setUpdateSuccess(null);
                                  }}
                                >
                                  Update inventory for this key
                                </button>
                              </div>
                            );
                          })
                        )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!updateModal} onOpenChange={(open) => !open && setUpdateModal(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Update inventory from key head image</DialogTitle>
            <DialogDescription>
              Apply an inventory change for this magazine based on the audited key head image.
            </DialogDescription>
          </DialogHeader>
          {updateModal && (
            <div className="space-y-4">
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-medium">Kiosk:</span> {kioskName || '—'}
                </p>
                <p>
                  <span className="font-medium">Test cut ID:</span> {updateModal.id}
                </p>
                <p>
                  <span className="font-medium">Magazine:</span> {updateModal.mag}
                </p>
              </div>

              <div className="space-y-3">
                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Milling</span>
                  <select
                    value={updateModal.milling}
                    onChange={(e) =>
                      setUpdateModal((prev) => ({ ...prev, milling: e.target.value }))
                    }
                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Select milling…</option>
                    {millings.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Style</span>
                  <select
                    value={updateModal.style}
                    onChange={(e) =>
                      setUpdateModal((prev) => ({ ...prev, style: e.target.value }))
                    }
                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Select style…</option>
                    {(stylesByMilling[updateModal.milling] || []).map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1">
                  <span className="text-sm font-medium">Count</span>
                  <input
                    type="number"
                    min="0"
                    value={updateModal.count}
                    onChange={(e) =>
                      setUpdateModal((prev) => ({ ...prev, count: e.target.value }))
                    }
                    className="w-32 rounded border border-border bg-background px-3 py-2 text-sm"
                  />
                </label>

                <p className="text-xs text-muted-foreground">
                  This will run the equivalent of updating magazine {updateModal.mag} to
                  the selected milling/style and count on the kiosk.
                </p>
              </div>

              {updateError && (
                <p className="text-xs text-destructive">
                  {updateError}
                </p>
              )}
              {updateSuccess && (
                <p className="text-xs text-emerald-500">
                  {updateSuccess}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  onClick={() => setUpdateModal(null)}
                  disabled={updateLoading}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  disabled={updateLoading || !socket?.requestIfSupported}
                  onClick={() => {
                    if (!updateModal || !socket?.requestIfSupported) return;
                    const n = parseInt(updateModal.count || '0', 10);
                    if (Number.isNaN(n) || n < 0) {
                      setUpdateError('Enter a non-negative count.');
                      setUpdateSuccess(null);
                      return;
                    }
                    if (!updateModal.milling || !updateModal.style) {
                      setUpdateError('Select both milling and style.');
                      setUpdateSuccess(null);
                      return;
                    }
                    setUpdateLoading(true);
                    setUpdateError(null);
                    setUpdateSuccess(null);
                    socket
                      .requestIfSupported('inventory_advanced_action', {
                        action: 'replace_magazine',
                        magazine: updateModal.mag,
                        milling: updateModal.milling,
                        style: updateModal.style,
                        count: n,
                      })
                      .then((res) => {
                        if (res?.success) {
                          setUpdateSuccess('Inventory updated.');
                          fetchInventory();
                        } else {
                          const msg = (res?.errors || ['Request failed']).join('; ');
                          setUpdateError(msg);
                        }
                      })
                      .catch((err) => {
                        const msg =
                          err?.code === ERROR_UNSUPPORTED_COMMAND
                            ? UNSUPPORTED_FEATURE_MESSAGE
                            : err?.message || 'Request failed';
                        setUpdateError(msg);
                      })
                      .finally(() => {
                        setUpdateLoading(false);
                      });
                  }}
                >
                  {updateLoading ? 'Updating…' : 'Apply inventory update'}
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
