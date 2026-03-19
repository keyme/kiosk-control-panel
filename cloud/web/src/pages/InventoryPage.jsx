import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { PageTitle } from '@/components/PageTitle';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/apiFetch';
import { ERROR_UNSUPPORTED_COMMAND, UNSUPPORTED_FEATURE_MESSAGE } from '@/lib/deviceSocket';
import { Camera, ChevronDown, ChevronRight, Download, Loader2, Maximize2, Package, RefreshCw, Upload, X } from 'lucide-react';

/** Extract "YYYY-MM-DD-HH-MM-SS-UTC" from key or filename; return display string or null. */
function formatKeyHeadTaken(keyOrFilename) {
  if (!keyOrFilename || typeof keyOrFilename !== 'string') return null;
  const m = String(keyOrFilename).match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-UTC/);
  if (!m) return null;
  const [, y, mo, d, h, min] = m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[parseInt(mo, 10) - 1] || mo;
  return `${month} ${parseInt(d, 10)}, ${y}, ${h}:${min} UTC`;
}

/** Gen 3 kiosks: strip leading zeros after "ns" (e.g. NS003512 -> NS3512). */
function normalizeKioskName(name) {
  if (name == null || typeof name !== 'string') return '';
  return name.replace(/^(ns)0+/i, '$1');
}

function escapeCsvCell(val) {
  const s = val == null ? '' : String(val);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const SEGMENT_COUNT = 20;
const DEG_PER_SEG = 360 / SEGMENT_COUNT;

function segmentState(mag, lowThreshold) {
  // Empty slot / no key config loaded.
  if (!mag || mag.milling == null || mag.style == null || String(mag.milling) === 'None') return 'empty';
  // Disabled magazines: mark as disabled (color-coded in legend).
  if (!mag.in_stock) return 'disabled';
  const c = typeof mag.count === 'number' ? mag.count : Number(mag.count);
  if (!Number.isFinite(c)) return 'enabled';
  if (c <= 0) return 'zero';
  if (c < lowThreshold) return 'low';
  return 'enabled';
}

function segmentColor(state) {
  switch (state) {
    case 'empty': return '#94a3b8';
    case 'disabled': return '#ef4444';
    case 'low': return '#eab308';
    case 'zero': return '#ef4444';
    case 'enabled': return '#22c55e';
    default: return '#94a3b8';
  }
}

/** True when slot has no key data / unconfigured (same criteria as donut "empty" state). */
function isEmptySlot(mag) {
  return !mag || mag.milling == null || mag.style == null || String(mag.milling) === 'None';
}

/** Compute overall inventory stats for center summary. */
function inventorySummary(magazines, lowThreshold) {
  let totalKeys = 0;
  let enabledSlots = 0;
  let disabledSlots = 0;
  let lowSlots = 0;
  let emptySlots = 0;
  for (const mag of magazines || []) {
    const state = segmentState(mag, lowThreshold);
    const count = typeof mag.count === 'number' ? mag.count : Number(mag.count) || 0;
    totalKeys += Number.isFinite(count) ? count : 0;
    if (state === 'enabled') enabledSlots += 1;
    else if (state === 'disabled' || state === 'zero') disabledSlots += 1;
    else if (state === 'low') lowSlots += 1;
    else if (state === 'empty') emptySlots += 1;
  }
  return { totalKeys, enabledSlots, disabledSlots, lowSlots, emptySlots };
}

/** Format cost as currency or return dash when missing/invalid. */
function formatCost(cost) {
  const n = typeof cost === 'number' ? cost : Number(cost);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

export default function InventoryPage({ connected, socket }) {
  const { kiosk } = useParams();
  const [magazines, setMagazines] = useState([]);
  const [lowInventoryThreshold, setLowInventoryThreshold] = useState(10);
  const [disabledReasons, setDisabledReasons] = useState([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedMagazine, setSelectedMagazine] = useState(null);
  const [hoveredMagazine, setHoveredMagazine] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState(null);
  const [disableReason, setDisableReason] = useState('');
  const [newCount, setNewCount] = useState('');
  const [millings, setMillings] = useState([]);
  const [stylesByMilling, setStylesByMilling] = useState({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedAction, setAdvancedAction] = useState('add_magazine');
  const [advancedMilling, setAdvancedMilling] = useState('');
  const [advancedStyle, setAdvancedStyle] = useState('');
  const [advancedCount, setAdvancedCount] = useState('');
  const [advancedFixField, setAdvancedFixField] = useState('milling');
  const [advancedFixValue, setAdvancedFixValue] = useState('');
  const [noApiUpdate, setNoApiUpdate] = useState(false);
  const [hasPendingPricingUpdate, setHasPendingPricingUpdate] = useState(false);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef(null);
  const [captureConfirmOpen, setCaptureConfirmOpen] = useState(false);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureError, setCaptureError] = useState(null);
  const [captureImages, setCaptureImages] = useState(null);
  const [captureRunAnyway, setCaptureRunAnyway] = useState(false);
  const [fullscreenImage, setFullscreenImage] = useState(null); // { base64?, url?, label } or null
  const [fullscreenImages, setFullscreenImages] = useState(null); // optional array of { url, filename }
  const [fullscreenIndex, setFullscreenIndex] = useState(null); // index into fullscreenImages when present
  const [restoreFromAdminModalOpen, setRestoreFromAdminModalOpen] = useState(false);
  const [restoreFromAdminKiosk, setRestoreFromAdminKiosk] = useState('');
  const [fetchedStock, setFetchedStock] = useState(null);
  const [fetchStockLoading, setFetchStockLoading] = useState(false);
  const [fetchStockError, setFetchStockError] = useState(null);
  const [uploadToKioskLoading, setUploadToKioskLoading] = useState(false);

  const [ejectionImagesByMag, setEjectionImagesByMag] = useState({});
  const [ejectionLoading, setEjectionLoading] = useState(false);
  const [ejectionError, setEjectionError] = useState(null);

  const [ejectionCheckConfirmOpen, setEjectionCheckConfirmOpen] = useState(false);
  const [ejectionCheckLoading, setEjectionCheckLoading] = useState(false);
  const [ejectionCheckError, setEjectionCheckError] = useState(null);
  const [ejectionCheckOverrideRemote, setEjectionCheckOverrideRemote] = useState(false);
  const [ejectionCheckPolling, setEjectionCheckPolling] = useState(false);
  const [ejectionCheckResult, setEjectionCheckResult] = useState(null); // { id, image }
  const [ejectionCheckImages, setEjectionCheckImages] = useState(null); // array of { url, filename, key }
  const [ejectionCheckImagesLoading, setEjectionCheckImagesLoading] = useState(false);
  const [ejectionCheckImagesFetchError, setEjectionCheckImagesFetchError] = useState(null);
  const ejectionPollAbortRef = useRef(false);
  const ejectionJobResultHandlerRef = useRef(null);
  const lastEjectionJobResultIdRef = useRef(null);

  useEffect(() => {
    if (!hasPendingPricingUpdate) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasPendingPricingUpdate]);

  useEffect(() => {
    if (!fullscreenImage || !fullscreenImages || fullscreenIndex == null) return;
    const handleKey = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        if (!fullscreenImages.length) return;
        const delta = e.key === 'ArrowLeft' ? -1 : 1;
        const nextIndex = (fullscreenIndex + delta + fullscreenImages.length) % fullscreenImages.length;
        setFullscreenIndex(nextIndex);
        const img = fullscreenImages[nextIndex];
        if (img && img.url) {
          setFullscreenImage({
            base64: null,
            url: img.url,
            label: img.filename || fullscreenImage.label,
          });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setFullscreenImage(null);
        setFullscreenImages(null);
        setFullscreenIndex(null);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [fullscreenImage, fullscreenImages, fullscreenIndex]);

  useEffect(() => {
    if (!bulkMenuOpen) return;
    const handleClickOutside = (e) => {
      if (bulkMenuRef.current && !bulkMenuRef.current.contains(e.target)) {
        setBulkMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [bulkMenuOpen]);

  const isSocketDisabled = !connected || !socket?.connected;
  const isDisabled = isSocketDisabled || !hasLoaded;

  const fetchInventory = useCallback(() => {
    if (!socket?.requestIfSupported) return;
    setError(null);
    setLoading(true);
    Promise.all([
      socket.requestIfSupported('get_inventory_list'),
      socket.requestIfSupported('get_inventory_disabled_reasons'),
      socket.requestIfSupported('get_inventory_millings_styles'),
    ])
      .then(([listRes, reasonsRes, millingsRes]) => {
        if (listRes?.success && listRes.data) {
          setMagazines(listRes.data.magazines || []);
          setLowInventoryThreshold(listRes.data.low_inventory_threshold ?? 10);
          setHasLoaded(true);
        }
        if (reasonsRes?.success && reasonsRes.data?.reasons) {
          setDisabledReasons(reasonsRes.data.reasons);
        }
        if (millingsRes?.success && millingsRes.data) {
          setMillings(millingsRes.data.millings || []);
          setStylesByMilling(millingsRes.data.styles_by_milling || {});
        }
      })
      .catch((err) => {
        setHasLoaded(false);
        const msg = err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Failed to load inventory');
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [socket]);

  const handleSelect = (magNumRaw) => {
    const magNum = Number(magNumRaw);
    if (!Number.isFinite(magNum) || magNum < 1) return;
    setSelectedMagazine(magNum);
    setHoveredMagazine(null);
    setDrawerOpen(true);
    setActionMessage(null);
    const mag = magazines[magNum - 1];
    setNewCount(mag?.count != null ? String(mag.count) : '');
    setDisableReason('');
  };

  const handleCloseDrawer = () => {
    setDrawerOpen(false);
    setSelectedMagazine(null);
    setHoveredMagazine(null);
    setActionMessage(null);
  };

  const showActionMessage = (message, isError = false) => {
    setActionMessage({ text: message, isError });
  };

  const openEjectionGalleryForSelected = useCallback(async () => {
    const magNum = selectedMagazine;
    const k = (kiosk || '').trim();
    if (!magNum || !k) return;
    const entry = ejectionImagesByMag[magNum];
    if (!entry) return;
    setEjectionCheckError(null);
    setEjectionCheckLoading(false);
    setEjectionCheckPolling(false);
    setEjectionCheckResult({ id: entry.id, image: entry.image });
    setEjectionCheckImages(null);
    setEjectionCheckImagesLoading(true);
    setEjectionCheckImagesFetchError(null);
    setEjectionCheckConfirmOpen(true);
    try {
      const resp = await apiFetch(
        `/api/calibration/testcuts/images?kiosk=${encodeURIComponent(k)}&id=${encodeURIComponent(
          String(entry.id),
        )}`,
      );
      if (resp.ok) {
        const payload = await resp.json();
        let imgs = [];
        if (payload && typeof payload === 'object') {
          const sectionNames = Object.keys(payload).sort();
          for (const section of sectionNames) {
            const arr = payload[section];
            if (Array.isArray(arr)) {
              imgs = imgs.concat(arr);
            }
          }
        }
        const filtered = imgs.filter((img) => img && img.url);
        setEjectionCheckImages(filtered);
      } else {
        setEjectionCheckImages([]);
      }
    } catch (err) {
      setEjectionCheckImagesFetchError(err?.message || 'Failed to load ejection image gallery');
      setEjectionCheckImages([]);
    } finally {
      setEjectionCheckImagesLoading(false);
    }
  }, [selectedMagazine, kiosk, ejectionImagesByMag]);

  const runAction = (event, data) => {
    if (!socket?.requestIfSupported || actionLoading || isDisabled) return;
    setActionMessage(null);
    setActionLoading(true);
    socket
      .requestIfSupported(event, data ?? {})
      .then((res) => {
        if (res?.success) {
          if (event === 'inventory_update_api_pricing') {
            setHasPendingPricingUpdate(false);
          } else if (data?.no_api_update === true) {
            setHasPendingPricingUpdate(true);
          } else {
            setHasPendingPricingUpdate(false);
          }
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
    runAction('inventory_enable_magazine', { magazine: selectedMagazine, no_api_update: noApiUpdate });
  };

  const handleDisable = () => {
    if (selectedMagazine == null || !disableReason) return;
    runAction('inventory_disable_magazine', { magazine: selectedMagazine, reason: disableReason, no_api_update: noApiUpdate });
  };

  const handleSetCount = () => {
    if (selectedMagazine == null) return;
    const n = parseInt(newCount, 10);
    if (isNaN(n) || n < 0) {
      showActionMessage('Enter a non-negative number.', true);
      return;
    }
    runAction('inventory_set_key_count', { magazine: selectedMagazine, new_count: n, no_api_update: noApiUpdate });
  };

  const handleUpdateApiPricing = () => {
    runAction('inventory_update_api_pricing', {});
  };

  const handleExportCsv = useCallback(() => {
    const kioskCol = normalizeKioskName(kiosk);
    const header = ['Kiosk name', 'Mag number', 'Milling', 'Style', 'Count'].map(escapeCsvCell).join(',');
    const rows = (magazines.length ? magazines : Array.from({ length: 20 }, (_, i) => ({ magazine: i + 1, count: 0, milling: null, style: null })))
      .map((mag, i) => {
        const magNum = mag.magazine ?? i + 1;
        const milling = mag.milling != null && String(mag.milling) !== 'None' ? mag.milling : '';
        const style = mag.style != null && String(mag.style) !== 'None' ? (mag.display_name ?? mag.style) : '';
        const count = typeof mag.count === 'number' ? mag.count : (Number(mag.count) || 0);
        return [kioskCol, magNum, milling, style, count].map(escapeCsvCell).join(',');
      });
    const csv = [header, ...rows].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${kioskCol || 'kiosk'}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [kiosk, magazines]);

  const loadEjectionImages = useCallback(async () => {
    const k = (kiosk || '').trim();
    if (!k) {
      setEjectionError('Kiosk name not available.');
      return;
    }
    setEjectionError(null);
    setEjectionLoading(true);
    try {
      const res = await apiFetch(
        `/api/calibration/ejection_images?kiosk=${encodeURIComponent(k)}&max_ids=500`
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error || res.statusText || 'Failed to load ejection images');
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        setEjectionImagesByMag({});
        return;
      }
      setEjectionImagesByMag(data);
    } catch (err) {
      setEjectionError(err?.message || 'Failed to load ejection images');
    } finally {
      setEjectionLoading(false);
    }
  }, [kiosk]);

  const handleOpenCaptureConfirm = () => {
    setCaptureError(null);
    setCaptureImages(null);
    setCaptureConfirmOpen(true);
  };

  const handleOpenEjectionCheckConfirm = () => {
    setEjectionCheckError(null);
    setEjectionCheckConfirmOpen(true);
  };

  const handleConfirmEjectionCheck = useCallback(async () => {
    if (selectedMagazine == null || !socket?.requestIfSupported) return;
    const magNum = selectedMagazine;
    const previousEntry = ejectionImagesByMag[magNum];
    const previousId = previousEntry?.id ?? null;
    setEjectionCheckError(null);
    setEjectionCheckResult(null);
    setEjectionCheckImagesFetchError(null);
    setEjectionCheckLoading(true);
    try {
      const payload = {
        magazine: selectedMagazine,
      };
      if (ejectionCheckOverrideRemote) {
        payload.override_remote = true;
      }
      const res = await socket.requestIfSupported('inventory_run_ejection_checks', payload);
      if (res?.success) {
        showActionMessage('Ejection check started. Images will appear below once available.');
        console.debug('ejection check started', {
          kiosk,
          magazine: magNum,
          previousEjectionId: previousId,
          overrideRemote: ejectionCheckOverrideRemote,
        });
        const ejectionJobHandler = (jobData) => {
          try {
            const jobName = jobData?.name;
            if (jobName !== 'test_ejections') return;
            if (ejectionPollAbortRef.current) return;
            const jobResultId = jobData?.id ?? null;
            if (jobResultId && lastEjectionJobResultIdRef.current === jobResultId) return;

            const magazineData = jobData?.result?.magazine_data;
            if (!Array.isArray(magazineData)) return;
            const matching = magazineData.filter((m) => Number(m?.magazine_number) === Number(magNum));
            const testCutIds = matching.flatMap((m) => (Array.isArray(m?.test_cut_ids) ? m.test_cut_ids : []));
            const uniqueTestCutIds = [];
            for (const id of testCutIds) {
              const n = Number(id);
              if (!Number.isFinite(n)) continue;
              if (!uniqueTestCutIds.includes(n)) uniqueTestCutIds.push(n);
            }
            if (!uniqueTestCutIds.length) return;
            if (previousId && uniqueTestCutIds.every((id) => Number(id) === Number(previousId))) return;

            lastEjectionJobResultIdRef.current = jobResultId;
            ejectionPollAbortRef.current = true;
            setEjectionCheckPolling(false);
            setEjectionCheckImagesLoading(true);
            setEjectionCheckImages(null);
            setEjectionCheckImagesFetchError(null);

            if (socket && ejectionJobResultHandlerRef.current) {
              socket.off('async.JOB_RESULT', ejectionJobResultHandlerRef.current);
              ejectionJobResultHandlerRef.current = null;
            }

            void (async () => {
              try {
                const kNow = (kiosk || '').trim();

                // Best-effort update the drawer "latest key head" card.
                if (kNow) {
                  try {
                    const keyHeadResp = await apiFetch(
                      `/api/calibration/ejection_images?kiosk=${encodeURIComponent(kNow)}&max_ids=500`
                    );
                    if (keyHeadResp.ok) {
                      const data = await keyHeadResp.json();
                      setEjectionImagesByMag(data);
                      const entry = data?.[magNum];
                      if (entry) setEjectionCheckResult({ id: entry.id, image: entry.image });
                    }
                  } catch (e) {
                    // Not fatal; the full gallery can still render.
                  }
                }

                const flattenSections = (payload) => {
                  const out = [];
                  if (payload && typeof payload === 'object') {
                    const sectionNames = Object.keys(payload).sort();
                    for (const section of sectionNames) {
                      const arr = payload[section];
                      if (Array.isArray(arr)) out.push(...arr);
                    }
                  }
                  return out.filter((img) => img && img.url);
                };

                if (!jobData?.succeeded) {
                  const msg = jobData?.error || jobData?.error_type || 'Ejection check failed';
                  setEjectionCheckError(msg);
                  setEjectionCheckImages([]);
                  return;
                }

                let allImgs = [];
                for (const id of uniqueTestCutIds) {
                  const fullResp = await apiFetch(
                    `/api/calibration/testcuts/images?kiosk=${encodeURIComponent(String(kNow))}&id=${encodeURIComponent(
                      String(id)
                    )}`
                  );
                  if (!fullResp.ok) continue;
                  const payload = await fullResp.json();
                  allImgs = allImgs.concat(flattenSections(payload));
                }
                setEjectionCheckImages(allImgs);
              } catch (err) {
                setEjectionCheckImagesFetchError(err?.message || 'Failed to load ejection image gallery');
                setEjectionCheckImages([]);
              } finally {
                setEjectionCheckImagesLoading(false);
              }
            })();
          } catch {
            // ignore malformed jobData payloads
          }
        };

        if (socket && ejectionJobResultHandlerRef.current) {
          socket.off('async.JOB_RESULT', ejectionJobResultHandlerRef.current);
          ejectionJobResultHandlerRef.current = null;
        }
        ejectionJobResultHandlerRef.current = ejectionJobHandler;
        if (socket) socket.on('async.JOB_RESULT', ejectionJobHandler);
        // Start polling for a newer ejection image for this magazine.
        const k = (kiosk || '').trim();
        if (k) {
          ejectionPollAbortRef.current = false;
          setEjectionCheckPolling(true);
          (async () => {
            console.debug('ejection polling loop started', { kiosk: k, magNum, previousId });
            const maxAttempts = 24; // ~2 minutes at 5s intervals
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
              if (ejectionPollAbortRef.current) return;
              try {
                const resp = await apiFetch(
                  `/api/calibration/ejection_images?kiosk=${encodeURIComponent(k)}&max_ids=500`
                );
                if (resp.ok) {
                  const data = await resp.json();
                  if (data && typeof data === 'object') {
                    const entry = data[magNum];
                    if (entry && (!previousId || entry.id !== previousId)) {
                      setEjectionImagesByMag(data);
                      setEjectionCheckResult({ id: entry.id, image: entry.image });
                      console.debug('new ejection id detected', { magNum, newId: entry.id });
                      break;
                    }
                  }
                }
              } catch {
                // swallow and retry
              }
              // wait 5 seconds before next attempt
              // eslint-disable-next-line no-await-in-loop
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            if (!ejectionPollAbortRef.current) {
              console.debug('ejection polling loop ended (timeout)', { maxAttempts });
              setEjectionCheckPolling(false);
            }
          })();
        }
      } else {
        const msg = (res?.errors && res.errors[0]) || 'Failed to start ejection check';
        setEjectionCheckError(msg);
      }
    } catch (err) {
      setEjectionCheckError(err?.message || 'Failed to start ejection check');
    } finally {
      setEjectionCheckLoading(false);
    }
  }, [selectedMagazine, socket, kiosk, ejectionImagesByMag, showActionMessage, ejectionCheckOverrideRemote, setEjectionImagesByMag]);

  const handleCloseEjectionCheckModal = useCallback(() => {
    console.debug('ejection modal close: abort polling');
    ejectionPollAbortRef.current = true;
    if (socket && ejectionJobResultHandlerRef.current) {
      socket.off('async.JOB_RESULT', ejectionJobResultHandlerRef.current);
      ejectionJobResultHandlerRef.current = null;
    }
    lastEjectionJobResultIdRef.current = null;
    setEjectionCheckConfirmOpen(false);
    setEjectionCheckError(null);
    setEjectionCheckLoading(false);
    setEjectionCheckOverrideRemote(false);
    setEjectionCheckPolling(false);
    setEjectionCheckResult(null);
    setEjectionCheckImages(null);
    setEjectionCheckImagesLoading(false);
    setEjectionCheckImagesFetchError(null);
  }, [socket]);

  const handleConfirmCapture = useCallback(async () => {
    if (selectedMagazine == null || !socket?.requestIfSupported) return;
    setCaptureError(null);
    setCaptureImages(null);
    setCaptureLoading(true);
    try {
      const res = await socket.requestIfSupported('inventory_rotate_and_capture', {
        magazine: selectedMagazine,
        force: captureRunAnyway,
      });
      if (res?.success && res?.data) {
        setCaptureImages({
          overhead: res.data.overheadImageBase64,
          inventory: res.data.inventoryImageBase64,
        });
      } else {
        const msg = (res?.errors && res.errors[0]) || 'Capture failed';
        setCaptureError(msg);
      }
    } catch (err) {
      setCaptureError(err?.message || 'Capture failed');
    } finally {
      setCaptureLoading(false);
    }
  }, [selectedMagazine, socket, captureRunAnyway]);

  const handleCloseCaptureModal = useCallback(() => {
    setCaptureConfirmOpen(false);
    setCaptureError(null);
    setCaptureImages(null);
    setCaptureLoading(false);
  }, []);

  const captureImageDataUrl = (base64) => `data:image/jpeg;base64,${base64}`;
  const handleCaptureImageFullscreen = (base64, label) => setFullscreenImage({ base64, label: label || 'Image' });

  useEffect(() => {
    if (!fullscreenImage) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') setFullscreenImage(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreenImage]);
  const handleCaptureImageDownload = (base64, label) => {
    const a = document.createElement('a');
    a.href = captureImageDataUrl(base64);
    a.download = `inventory-capture-${label.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.jpg`;
    a.click();
  };

  const handleOpenRestoreFromAdminModal = useCallback(() => {
    setBulkMenuOpen(false);
    setRestoreFromAdminModalOpen(true);
    setRestoreFromAdminKiosk(kiosk || '');
    setFetchedStock(null);
    setFetchStockError(null);
  }, [kiosk]);

  const handleCloseRestoreFromAdminModal = useCallback(() => {
    setRestoreFromAdminModalOpen(false);
    setFetchedStock(null);
    setFetchStockError(null);
    setFetchStockLoading(false);
    setUploadToKioskLoading(false);
  }, []);

  const handleFetchFromAdmin = useCallback(async () => {
    const k = (restoreFromAdminKiosk || '').trim();
    if (!k) {
      setFetchStockError('Enter a kiosk ID');
      return;
    }
    setFetchStockError(null);
    setFetchStockLoading(true);
    try {
      const res = await apiFetch(`/api/inventory/stock?kiosk=${encodeURIComponent(k)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setFetchStockError(errData?.error || `Failed to fetch inventory from Admin (${res.status})`);
        setFetchedStock(null);
        return;
      }
      const stock = await res.json();
      if (!Array.isArray(stock) || stock.length === 0) {
        setFetchStockError('No inventory data returned from Admin.');
        setFetchedStock(null);
        return;
      }
      setFetchedStock(stock);
    } catch (err) {
      setFetchStockError(err?.message || 'Failed to fetch from Admin');
      setFetchedStock(null);
    } finally {
      setFetchStockLoading(false);
    }
  }, [restoreFromAdminKiosk]);

  const handleUploadToKiosk = useCallback(async () => {
    if (!fetchedStock || !socket?.requestIfSupported || uploadToKioskLoading || isSocketDisabled) return;
    setUploadToKioskLoading(true);
    setFetchStockError(null);
    try {
      const wsRes = await socket.requestIfSupported('inventory_admin_restore', { stock: fetchedStock });
      if (wsRes?.success) {
        showActionMessage('Restore from Admin completed successfully.');
        handleCloseRestoreFromAdminModal();
        fetchInventory();
      } else {
        setFetchStockError((wsRes?.errors || ['Upload failed']).join('; '));
      }
    } catch (err) {
      const msg = err?.code === ERROR_UNSUPPORTED_COMMAND ? UNSUPPORTED_FEATURE_MESSAGE : (err?.message || 'Upload to kiosk failed');
      setFetchStockError(msg);
    } finally {
      setUploadToKioskLoading(false);
    }
  }, [fetchedStock, socket, uploadToKioskLoading, isSocketDisabled, fetchInventory, handleCloseRestoreFromAdminModal]);

  const handleExecuteAdvanced = () => {
    if (!socket?.requestIfSupported || actionLoading || isDisabled || selectedMagazine == null) return;
    const selectedMag = selectedMagazine != null ? magazines[selectedMagazine - 1] : null;

    if (advancedAction === 'remove_magazine') {
      if (isEmptySlot(selectedMag)) {
        showActionMessage('Slot is empty; nothing to remove.', true);
        return;
      }
    } else if (advancedAction === 'fix_magazine') {
      if (isEmptySlot(selectedMag)) {
        showActionMessage('Slot is empty; nothing to fix.', true);
        return;
      }
      if (!advancedMilling || !advancedStyle) {
        showActionMessage('Select both milling and style.', true);
        return;
      }
    } else if (advancedAction === 'mark_reviewed') {
      if (selectedMag?.in_stock !== false && !selectedMag?.disabled_reason) {
        showActionMessage('Only disabled keys can be marked as reviewed.', true);
        return;
      }
    } else {
      if (!advancedAction || !advancedMilling || !advancedStyle) {
        showActionMessage('Select action, milling, and style.', true);
        return;
      }
      const countNum = parseInt(advancedCount, 10);
      if (advancedCount === '' || isNaN(countNum) || countNum < 0) {
        showActionMessage('Enter a non-negative count.', true);
        return;
      }
    }

    setActionMessage(null);
    setActionLoading(true);

    let payload = { magazine: selectedMagazine, action: advancedAction, no_api_update: noApiUpdate };
    if (advancedAction === 'fix_magazine') {
      payload = { magazine: selectedMagazine, action: 'fix_magazine', milling: advancedMilling, style: advancedStyle, no_api_update: noApiUpdate };
    } else if (advancedAction === 'remove_magazine' || advancedAction === 'mark_reviewed') {
      payload = { magazine: selectedMagazine, action: advancedAction, no_api_update: noApiUpdate };
    } else {
      const countNum = parseInt(advancedCount, 10);
      payload = { magazine: selectedMagazine, action: advancedAction, milling: advancedMilling, style: advancedStyle, count: countNum, no_api_update: noApiUpdate };
    }

    socket
      .requestIfSupported('inventory_advanced_action', payload)
      .then((res) => {
        if (res?.success) {
          showActionMessage('Success.');
          fetchInventory();
          setAdvancedMilling('');
          setAdvancedStyle('');
          setAdvancedCount('');
          setAdvancedFixValue('');
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

  const selectedMag = selectedMagazine != null ? magazines[selectedMagazine - 1] : null;
  const selectedIsEmpty = isEmptySlot(selectedMag);
  const selectedIsDisabled = selectedMag && (selectedMag.in_stock === false || !!selectedMag.disabled_reason);
  const btnLabel = loading ? 'Fetching…' : hasLoaded ? 'Refresh' : 'Fetch Data';
  const hoverEnabled = selectedMagazine == null;
  const highlightMag = selectedMagazine != null ? selectedMagazine : hoveredMagazine;

  return (
    <div className="space-y-6">
      {/* Header row: title + subtitle left; Refresh + Fast edit + Bulk Actions right */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <PageTitle icon={Package}>Inventory</PageTitle>
          <p className="text-sm text-muted-foreground leading-relaxed -mt-2 mb-1">
            Load inventory from the device, then click a <span className="font-medium text-foreground/80">donut segment</span> or a{' '}
            <span className="font-medium text-foreground/80">table row</span> to open controls. Hover to highlight.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={fetchInventory}
            disabled={loading || isSocketDisabled}
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
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={noApiUpdate}
              onChange={(e) => setNoApiUpdate(e.target.checked)}
              className="rounded border-input"
            />
            <span className="text-sm whitespace-nowrap">Fast edit</span>
          </label>
          <div className="relative" ref={bulkMenuRef}>
            <button
              type="button"
              onClick={() => setBulkMenuOpen((o) => !o)}
              aria-expanded={bulkMenuOpen}
              aria-haspopup="menu"
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                'border border-input bg-background hover:bg-accent disabled:opacity-50'
              )}
            >
              Bulk Actions
              <ChevronDown className="size-4 shrink-0" aria-hidden />
            </button>
            {bulkMenuOpen && (
              <div
                className="absolute right-0 top-full z-50 mt-1 min-w-[10rem] rounded-md border border-border bg-background py-1 shadow-md"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleOpenRestoreFromAdminModal}
                >
                  Restore from Admin
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    setBulkMenuOpen(false);
                    handleExportCsv();
                  }}
                >
                  Export CSV
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={loadEjectionImages}
            disabled={ejectionLoading}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
              'border border-input bg-background hover:bg-accent disabled:opacity-50 disabled:pointer-events-none'
            )}
          >
            {ejectionLoading && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />}
            Load all ejections
          </button>
        </div>
      </div>

      {/* Fast Edit Mode Active strip — only when noApiUpdate */}
      {noApiUpdate && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 flex flex-wrap items-center gap-3" role="alert">
          <span className="font-medium text-amber-800 dark:text-amber-200">⚡ Fast Edit Mode Active</span>
          <button
            type="button"
            onClick={handleUpdateApiPricing}
            disabled={actionLoading || isSocketDisabled}
            className={cn(
              'inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
              'bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:pointer-events-none'
            )}
          >
            {actionLoading ? (
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            ) : null}
            Sync Pricing Now
          </button>
          <span className="text-sm text-amber-800/90 dark:text-amber-200/90">
            Use Sync before leaving so pricing and Admin API are updated.
          </span>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {ejectionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {ejectionError}
        </div>
      )}

      {!hasLoaded && !loading && !error && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            Click <strong>Fetch Data</strong> to load inventory from the device.
          </CardContent>
        </Card>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>Loading inventory…</span>
        </div>
      ) : hasLoaded ? (
        <>
        <div className="flex flex-1 gap-8 items-start">
          {/* Donut - larger, with segment gap and clearer labels */}
          <Card className="shrink-0 overflow-visible">
            <CardContent className="p-6">
              <div className="relative h-[420px] w-[420px]">
                <svg
                  viewBox="0 0 100 100"
                  className="size-full drop-shadow-md select-none"
                  aria-label="Magazine donut"
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <defs>
                    <filter id="donut-shadow" x="-20%" y="-20%" width="140%" height="140%">
                      <feDropShadow dx="0" dy="1" stdDeviation="0.5" floodOpacity="0.15" />
                    </filter>
                    <radialGradient id="donut-inner">
                      <stop offset="0%" stopColor="hsl(var(--muted) / 0.85)" />
                      <stop offset="100%" stopColor="hsl(var(--card))" />
                    </radialGradient>
                  </defs>
                  <circle cx="50" cy="50" r="24" fill="url(#donut-inner)" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" filter="url(#donut-shadow)" />
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
                    const numberR = 27;
                    const countR = 37;
                    const numberX = cx + numberR * Math.cos(rad(midAngle));
                    const numberY = cy + numberR * Math.sin(rad(midAngle));
                    const countX = cx + countR * Math.cos(rad(midAngle));
                    const countY = cy + countR * Math.sin(rad(midAngle));

                    const isSelected = selectedMagazine === magNum;
                    const isHovered = hoveredMagazine === magNum;
                    const isActive = highlightMag === magNum;
                    const opacity = highlightMag != null ? (isActive ? 1 : 0.55) : (isHovered ? 1 : 0.75);

                    return (
                      <g key={magNum} filter="url(#donut-shadow)">
                        <path
                          d={d}
                          fill={fillColor}
                          stroke="hsl(var(--card))"
                          strokeWidth={0.4}
                          className="cursor-pointer transition-all duration-150"
                          style={{ opacity }}
                          onClick={() => handleSelect(magNum)}
                          onMouseEnter={() => {
                            if (!hoverEnabled) return;
                            setHoveredMagazine(magNum);
                          }}
                          onMouseLeave={() => {
                            if (!hoverEnabled) return;
                            setHoveredMagazine(null);
                          }}
                          onKeyDown={(e) => e.key === 'Enter' && handleSelect(magNum)}
                          role="button"
                          tabIndex={0}
                          aria-label={`Magazine ${magNum}, ${mag?.count ?? 0} keys`}
                        />
                        <text
                          x={numberX}
                          y={numberY + 0.5}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="white"
                          fontSize="2.8"
                          fontWeight="700"
                          className="pointer-events-none select-none"
                          style={{ textShadow: '0 0 2px rgba(0,0,0,0.5)' }}
                        >
                          #{String(magNum).padStart(2, '0')}
                        </text>
                        <text
                          x={countX}
                          y={countY + 0.5}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="white"
                          fontSize="3.8"
                          fontWeight="700"
                          className="pointer-events-none select-none"
                          style={{ textShadow: '0 0 2px rgba(0,0,0,0.5)' }}
                        >
                          {Number(mag?.count ?? 0)}
                        </text>
                      </g>
                    );
                  })}

                  {/* Separator circle between number (inner) and count (outer) bands */}
                  <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.3" className="pointer-events-none" />

                  {/* Overlay outline on top of all segments (prevents uneven edges). */}
                  {highlightMag != null && (() => {
                    const i = highlightMag - 1;
                    if (i < 0 || i >= SEGMENT_COUNT) return null;
                    const magNum = highlightMag;
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
                    const isSelected = selectedMagazine === magNum;
                    const isHovered = hoverEnabled && hoveredMagazine === magNum && !isSelected;
                    return (
                      <>
                        <path
                          d={d}
                          fill="none"
                          stroke="rgba(255,255,255,0.92)"
                          strokeWidth={isSelected ? 1.8 : 1.4}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          className="pointer-events-none"
                          style={{ opacity: isHovered ? 0.75 : 1 }}
                        />
                        <path
                          d={d}
                          fill="none"
                          stroke="hsl(var(--primary))"
                          strokeWidth={isSelected ? 1.2 : 1.0}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          className="pointer-events-none"
                          style={{ opacity: isHovered ? 0.85 : 1 }}
                        />
                      </>
                    );
                  })()}
                </svg>
                {/* Center: overall status */}
                {(() => {
                  const s = inventorySummary(magazines, lowInventoryThreshold);
                  return (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden>
                      <div
                        className="flex flex-col items-center justify-center text-center rounded-full w-[202px] h-[202px] px-4"
                        style={{
                          background: 'radial-gradient(circle at 50% 50%, hsl(var(--muted) / 0.6), hsl(var(--card)))',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
                        }}
                      >
                        <p className="text-xs font-medium text-muted-foreground">Total keys</p>
                        <p className="text-2xl font-bold tabular-nums text-foreground mt-0.5">{s.totalKeys}</p>
                        <div className="mt-2 flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>✓</span>
                            <span>Enabled: {s.enabledSlots}</span>
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="text-slate-400 dark:text-slate-500" aria-hidden>○</span>
                            <span>
                              Disabled: {s.disabledSlots}
                              {' · '}
                              Low: {s.lowSlots}
                            </span>
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="text-slate-400 dark:text-slate-500" aria-hidden>○</span>
                            <span>Empty: {s.emptySlots}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#22c55e' }} />
                  <span>good (≥ {lowInventoryThreshold})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#eab308' }} />
                  <span>low (1–{lowInventoryThreshold - 1})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#ef4444' }} />
                  <span>disabled or 0</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: '#94a3b8' }} />
                  <span>empty / unconfigured</span>
                </div>
                <div className="col-span-2 text-[11px] text-muted-foreground/90">
                  Disabled reason is shown in the table and in the drawer.
                </div>
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
                      <th className="px-3 py-2 text-right font-medium">Price</th>
                      <th className="px-3 py-2 text-left font-medium">Milling</th>
                      <th className="px-3 py-2 text-left font-medium">Paint Style</th>
                      <th className="px-3 py-2 text-left font-medium">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Manufacturer</th>
                      <th className="px-3 py-2 text-right font-medium">Enabled Days</th>
                      <th className="px-3 py-2 text-right font-medium">Disabled Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(magazines.length ? magazines : Array.from({ length: 20 }, (_, i) => ({ magazine: i + 1, count: 0, in_stock: false }))).map((mag) => {
                      const magNum = Number(mag.magazine ?? 0);
                      const state = segmentState(mag, lowInventoryThreshold);
                      const rowColor = segmentColor(state);
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
                          style={{ borderLeftWidth: 4, borderLeftStyle: 'solid', borderLeftColor: rowColor }}
                          onClick={() => handleSelect(magNum)}
                          onMouseEnter={() => setHoveredMagazine(magNum)}
                          onMouseLeave={() => setHoveredMagazine(null)}
                          onKeyDown={(e) => e.key === 'Enter' && handleSelect(magNum)}
                          role="button"
                          tabIndex={0}
                        >
                          <td className="px-3 py-1.5">{magNum}</td>
                          <td className="px-3 py-1.5 text-right">{mag.count ?? 0}</td>
                          <td className="px-3 py-1.5 text-right">{formatCost(mag.cost)}</td>
                          <td className="px-3 py-1.5">{mag.milling ?? '—'}</td>
                          <td className="px-3 py-1.5">{mag.display_name ?? mag.style ?? '—'}</td>
                          <td className="px-3 py-1.5">
                            {mag.in_stock ? 'enabled' : `disabled${mag.disabled_reason ? ` (${mag.disabled_reason})` : ''}`}
                          </td>
                          <td className="px-3 py-1.5">{mag.manufacturer ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right">{mag.enabled_days ?? 0}</td>
                          <td className="px-3 py-1.5 text-right">{mag.disabled_days ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
        </>
      ) : null}

      {/* Ejection key head images: shown whenever we have images, even if kiosk fetch hasn't run (e.g. offline). */}
      {Object.keys(ejectionImagesByMag || {}).length > 0 && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Ejection key head images</h3>
                <p className="text-xs text-muted-foreground">
                  Showing the most recent key head check image found per magazine from recent test cuts.
                </p>
              </div>
              {ejectionCheckPolling && (
                <div className="flex items-center gap-2 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  <span>Updating after ejection check…</span>
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {Array.from({ length: SEGMENT_COUNT }, (_, i) => {
                const magNum = i + 1;
                const entry = ejectionImagesByMag[magNum];
                const mag = magazines[magNum - 1];
                if (!entry) {
                  return (
                    <button
                      key={magNum}
                      type="button"
                      onClick={() => handleSelect(magNum)}
                      className="w-full rounded-md border border-dashed border-muted-foreground/40 p-3 text-left text-base text-muted-foreground hover:border-muted-foreground/60 hover:bg-muted/30 cursor-pointer transition-colors"
                    >
                      <div className="mb-1 font-medium text-foreground/80">Mag #{magNum}</div>
                      <div>No key head image loaded.</div>
                      <span className="sr-only">Open controls for magazine {magNum}</span>
                    </button>
                  );
                }
                const takenLabel = formatKeyHeadTaken(entry.image.key ?? entry.image.filename);
                const millingStyle = mag
                  ? `${mag.milling ?? '—'} / ${mag.display_name ?? mag.style ?? '—'}`
                  : null;
                return (
                  <button
                    key={magNum}
                    type="button"
                    onClick={() => handleSelect(magNum)}
                    className="w-full space-y-2 rounded-md border border-border p-2 text-left hover:bg-muted/30 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  >
                    <div className="text-base font-medium text-foreground/80">
                      Mag #{magNum} • ID {entry.id}
                    </div>
                    <img
                      src={entry.image.url}
                      alt={entry.image.filename}
                      className="h-32 w-full rounded border border-border object-contain bg-background"
                    />
                    {millingStyle != null && (
                      <p className="text-base font-semibold text-foreground">
                        {millingStyle}
                      </p>
                    )}
                    {takenLabel != null && (
                      <p className="text-base font-bold text-foreground">
                        Taken: {takenLabel}
                      </p>
                    )}
                    <div className="text-base text-muted-foreground break-all">
                      {entry.image.filename}
                    </div>
                    <span className="sr-only">Open controls for magazine {magNum}</span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
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
            className="fixed right-0 top-0 z-50 flex h-full w-[380px] flex-col border-l border-border bg-card shadow-lg"
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
                    <div className="rounded-md border bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-baseline gap-2">
                            <div className="text-2xl font-semibold leading-none tabular-nums">
                              {selectedMag.count ?? 0}
                            </div>
                            <div className="text-sm text-muted-foreground">keys</div>
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">
                            {selectedMag.milling ?? '—'} / {selectedMag.display_name ?? selectedMag.style ?? '—'}
                          </div>
                        </div>
                        <div className="shrink-0">
                          <div
                            className={cn(
                              'rounded-full px-2 py-0.5 text-sm font-medium',
                              selectedMag.in_stock
                                ? 'bg-emerald-500/15 text-emerald-700'
                                : 'bg-red-500/15 text-red-700'
                            )}
                          >
                            {selectedMag.in_stock ? 'enabled' : 'disabled'}
                          </div>
                        </div>
                      </div>
                      {!selectedMag.in_stock && selectedMag.disabled_reason && (
                        <div className="mt-2 text-sm text-muted-foreground">
                          Reason: <span className="font-medium text-foreground/80">{selectedMag.disabled_reason}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {selectedMagazine != null && ejectionImagesByMag[selectedMagazine] && (() => {
                    const selImg = ejectionImagesByMag[selectedMagazine].image;
                    const takenLabel = formatKeyHeadTaken(selImg.key ?? selImg.filename);
                    return (
                      <div className="mt-3 space-y-2 rounded-md border bg-muted/10 p-3">
                        <p className="text-xs font-medium text-foreground/80">
                          Last key head from test cut (ID {ejectionImagesByMag[selectedMagazine].id})
                        </p>
                        <img
                          src={selImg.url}
                          alt={selImg.filename}
                          className="max-h-40 w-full rounded border border-border object-contain bg-background"
                        />
                        {takenLabel != null && (
                          <p className="text-base font-bold text-foreground">
                            Taken: {takenLabel}
                          </p>
                        )}
                        <p className="text-[11px] text-muted-foreground break-all">
                          {selImg.filename}
                        </p>
                        <button
                          type="button"
                          onClick={openEjectionGalleryForSelected}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent"
                        >
                          View ejection run images
                        </button>
                      </div>
                    );
                  })()}
                  {actionMessage && (
                    <p className={cn('text-sm', actionMessage.isError ? 'text-destructive' : 'text-emerald-600')}>
                      {actionMessage.text}
                    </p>
                  )}
                  {actionLoading && (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />
                      Updating…
                    </p>
                  )}
                  <div className="flex flex-col gap-3">
                    <div>
                      {selectedIsEmpty && (
                        <p className="mb-2 text-xs text-muted-foreground">
                          Cannot enable: slot is empty or unconfigured (no key data).
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={isDisabled || actionLoading || selectedIsEmpty}
                        onClick={handleEnable}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {actionLoading && <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />}
                        Enable
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
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {actionLoading && <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />}
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
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                      >
                        {actionLoading && <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />}
                        Update count
                      </button>
                    </div>
                    <div className="border-t border-border pt-3">
                      <button
                        type="button"
                        onClick={() => setAdvancedOpen((o) => !o)}
                        className="flex w-full items-center gap-2 text-left text-sm font-medium"
                      >
                        {advancedOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        Advanced Actions
                      </button>
                      {advancedOpen && (
                        <div className="mt-3 flex flex-col gap-3">
                          <div className="flex flex-col gap-2">
                            <span className="text-xs font-medium">Action</span>
                            <div className="flex flex-col gap-1">
                              {[
                                { value: 'add_magazine', label: 'Add Magazine' },
                                { value: 'replace_keys', label: 'Replace Keys' },
                                { value: 'replace_magazine', label: 'Replace Magazine' },
                                { value: 'remove_magazine', label: 'Remove Magazine' },
                                { value: 'fix_magazine', label: 'Fix Milling/Style' },
                                { value: 'mark_reviewed', label: 'Mark Reviewed' },
                              ].map(({ value, label }) => (
                                <label key={value} className="flex items-center gap-2 text-sm">
                                  <input
                                    type="radio"
                                    name="advanced-action"
                                    value={value}
                                    checked={advancedAction === value}
                                    onChange={() => {
                                      setAdvancedAction(value);
                                      if (value === 'fix_magazine' && selectedMag) {
                                        setAdvancedMilling(selectedMag.milling != null && String(selectedMag.milling) !== 'None' ? String(selectedMag.milling) : '');
                                        setAdvancedStyle(selectedMag.style != null && String(selectedMag.style) !== 'None' ? String(selectedMag.style) : '');
                                      }
                                      if (value !== 'fix_magazine') setAdvancedFixValue('');
                                    }}
                                    disabled={isDisabled || actionLoading}
                                    className="rounded-full border-input"
                                  />
                                  {label}
                                </label>
                              ))}
                            </div>
                          </div>
                          {(advancedAction === 'add_magazine' || advancedAction === 'replace_keys' || advancedAction === 'replace_magazine') && (
                            <>
                              <div className="flex flex-col gap-1">
                                <label htmlFor="inv-advanced-milling" className="text-xs font-medium">
                                  Milling
                                </label>
                                <select
                                  id="inv-advanced-milling"
                                  value={advancedMilling}
                                  onChange={(e) => {
                                    setAdvancedMilling(e.target.value);
                                    setAdvancedStyle('');
                                  }}
                                  disabled={isDisabled || actionLoading}
                                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                >
                                  <option value="">Select milling</option>
                                  {millings.map((m) => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <label htmlFor="inv-advanced-style" className="text-xs font-medium">
                                  Style
                                </label>
                                <select
                                  id="inv-advanced-style"
                                  value={advancedStyle}
                                  onChange={(e) => setAdvancedStyle(e.target.value)}
                                  disabled={isDisabled || actionLoading || !advancedMilling}
                                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                >
                                  <option value="">Select style</option>
                                  {(stylesByMilling[advancedMilling] || []).map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <label htmlFor="inv-advanced-count" className="text-xs font-medium">
                                  Count
                                </label>
                                <input
                                  id="inv-advanced-count"
                                  type="number"
                                  min={0}
                                  value={advancedCount}
                                  onChange={(e) => setAdvancedCount(e.target.value)}
                                  disabled={isDisabled || actionLoading}
                                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                />
                              </div>
                            </>
                          )}
                          {advancedAction === 'fix_magazine' && (
                            <>
                              <div className="flex flex-col gap-1">
                                <label htmlFor="inv-fix-milling" className="text-xs font-medium">
                                  Milling
                                </label>
                                <select
                                  id="inv-fix-milling"
                                  value={advancedMilling}
                                  onChange={(e) => {
                                    setAdvancedMilling(e.target.value);
                                    setAdvancedStyle('');
                                  }}
                                  disabled={isDisabled || actionLoading}
                                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                >
                                  <option value="">Select milling</option>
                                  {millings.map((m) => (
                                    <option key={m} value={m}>
                                      {m}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="flex flex-col gap-1">
                                <label htmlFor="inv-fix-style" className="text-xs font-medium">
                                  Style
                                </label>
                                <select
                                  id="inv-fix-style"
                                  value={advancedStyle}
                                  onChange={(e) => setAdvancedStyle(e.target.value)}
                                  disabled={isDisabled || actionLoading || !advancedMilling}
                                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                                >
                                  <option value="">Select style</option>
                                  {(stylesByMilling[advancedMilling] || []).map((s) => (
                                    <option key={s} value={s}>
                                      {s}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </>
                          )}
                          {advancedAction === 'mark_reviewed' && (
                            <p className="text-xs text-muted-foreground">Only for disabled keys.</p>
                          )}
                          <button
                            type="button"
                            disabled={
                              isDisabled ||
                              actionLoading ||
                              !selectedMagazine ||
                              (advancedAction === 'add_magazine' || advancedAction === 'replace_keys' || advancedAction === 'replace_magazine') &&
                                (!advancedMilling || !advancedStyle || advancedCount === '' || Number(advancedCount) < 0 || !Number.isInteger(Number(advancedCount))) ||
                              (advancedAction === 'remove_magazine' && selectedIsEmpty) ||
                              (advancedAction === 'fix_magazine' && (selectedIsEmpty || !advancedMilling || !advancedStyle)) ||
                              (advancedAction === 'mark_reviewed' && !selectedIsDisabled)
                            }
                            onClick={handleExecuteAdvanced}
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                          >
                            {actionLoading && <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />}
                            {advancedAction === 'remove_magazine' ? 'Remove Magazine' : 'Execute Action'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
            {advancedOpen && selectedMagazine != null && (
              <div className="shrink-0 border-t border-border p-4 space-y-2">
                <button
                  type="button"
                  disabled={isDisabled || actionLoading || captureLoading}
                  onClick={handleOpenCaptureConfirm}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-200"
                >
                  {captureLoading ? <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden /> : <Camera className="size-5 shrink-0" aria-hidden />}
                  Rotate to this magazine & capture
                </button>
                <div className="space-y-1">
                  <button
                    type="button"
                    disabled={isDisabled || actionLoading || ejectionCheckLoading || ejectionCheckPolling}
                    onClick={handleOpenEjectionCheckConfirm}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-indigo-500/50 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-800 hover:bg-indigo-500/20 disabled:opacity-50 dark:text-indigo-200"
                  >
                    {(ejectionCheckLoading || ejectionCheckPolling) ? (
                      <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />
                    ) : (
                      <Camera className="size-5 shrink-0" aria-hidden />
                    )}
                    {ejectionCheckPolling ? 'Running ejection check…' : 'Run ejection check'}
                  </button>
                  {selectedMagazine != null && ejectionImagesByMag[selectedMagazine] && (() => {
                    const selImg = ejectionImagesByMag[selectedMagazine].image;
                    const takenLabel = formatKeyHeadTaken(selImg.key ?? selImg.filename);
                    return (
                      <p className="text-xs text-muted-foreground">
                        Last ejection image{takenLabel ? `: ${takenLabel}` : ''}.
                      </p>
                    );
                  })()}
                  {selectedMagazine != null && !ejectionImagesByMag[selectedMagazine] && (
                    <p className="text-xs text-muted-foreground">
                      No ejection image found yet for this magazine.
                    </p>
                  )}
                </div>
              </div>
            )}
          </aside>
          <Dialog
            open={captureConfirmOpen}
            onOpenChange={(open) => {
              if (!open && !fullscreenImage) handleCloseCaptureModal();
            }}
          >
            <DialogContent
              showClose={true}
              onClose={handleCloseCaptureModal}
              onEscapeKeyDown={(e) => {
                if (fullscreenImage) {
                  e.preventDefault();
                }
              }}
              className="max-w-5xl w-[92vw] max-h-[90vh] overflow-y-auto"
            >
              <DialogHeader>
                <DialogTitle>Rotate to camera &amp; capture</DialogTitle>
                {!captureLoading && !captureImages && !captureError && (
                  <DialogDescription>
                    The carousel will home, then move so magazine {selectedMagazine} faces the inventory camera. Overhead and inventory camera images will be taken. This may take a minute. Continue?
                  </DialogDescription>
                )}
              </DialogHeader>
              <div className="flex flex-col gap-4 pt-2">
                {captureLoading && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8">
                    <Loader2 className="size-10 animate-spin text-muted-foreground" aria-hidden />
                    <p className="text-sm text-muted-foreground">Moving carousel and capturing images…</p>
                    <p className="text-xs text-muted-foreground">This usually takes up to 3 minutes. Please be patient.</p>
                  </div>
                )}
                {captureError && !captureLoading && (
                  <>
                    <p className="text-sm text-destructive">{captureError}</p>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleCloseCaptureModal}
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Close
                      </button>
                    </div>
                  </>
                )}
                {captureImages && !captureLoading && (
                  <>
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-2">
                        <p className="text-xs font-medium text-muted-foreground">Overhead</p>
                        <div className="relative rounded border border-border bg-muted/30">
                          <img
                            src={captureImageDataUrl(captureImages.overhead)}
                            alt="Overhead camera"
                            className="max-h-[45vh] min-h-48 w-full cursor-pointer object-contain"
                            role="button"
                            tabIndex={0}
                            title="Click to view fullscreen"
                            onClick={() => handleCaptureImageFullscreen(captureImages.overhead, 'Overhead')}
                            onKeyDown={(e) => e.key === 'Enter' && handleCaptureImageFullscreen(captureImages.overhead, 'Overhead')}
                          />
                          <div className="absolute bottom-2 right-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleCaptureImageFullscreen(captureImages.overhead, 'Overhead')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background/95 px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                              title="Fullscreen"
                            >
                              <Maximize2 className="size-3.5" aria-hidden />
                              Fullscreen
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCaptureImageDownload(captureImages.overhead, 'Overhead')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background/95 px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                              title="Download"
                            >
                              <Download className="size-3.5" aria-hidden />
                              Download
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <p className="text-xs font-medium text-muted-foreground">Inventory camera</p>
                        <div className="relative rounded border border-border bg-muted/30">
                          <img
                            src={captureImageDataUrl(captureImages.inventory)}
                            alt="Inventory camera"
                            className="max-h-[45vh] min-h-48 w-full cursor-pointer object-contain"
                            role="button"
                            tabIndex={0}
                            title="Click to view fullscreen"
                            onClick={() => handleCaptureImageFullscreen(captureImages.inventory, 'Inventory')}
                            onKeyDown={(e) => e.key === 'Enter' && handleCaptureImageFullscreen(captureImages.inventory, 'Inventory')}
                          />
                          <div className="absolute bottom-2 right-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleCaptureImageFullscreen(captureImages.inventory, 'Inventory')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background/95 px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                              title="Fullscreen"
                            >
                              <Maximize2 className="size-3.5" aria-hidden />
                              Fullscreen
                            </button>
                            <button
                              type="button"
                              onClick={() => handleCaptureImageDownload(captureImages.inventory, 'Inventory')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background/95 px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                              title="Download"
                            >
                              <Download className="size-3.5" aria-hidden />
                              Download
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleCloseCaptureModal}
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Close
                      </button>
                    </div>
                  </>
                )}
                {!captureLoading && !captureImages && !captureError && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={captureRunAnyway}
                        onChange={(e) => setCaptureRunAnyway(e.target.checked)}
                        className="rounded border-input"
                      />
                      Run anyway (kiosk in use)
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCloseCaptureModal}
                        className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmCapture}
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Confirm
                      </button>
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog
            open={ejectionCheckConfirmOpen}
            onOpenChange={(open) => {
              if (!open && !fullscreenImage) handleCloseEjectionCheckModal();
            }}
          >
            <DialogContent
              showClose={true}
              onClose={handleCloseEjectionCheckModal}
              onInteractOutside={(e) => e.preventDefault()}
              onEscapeKeyDown={(e) => {
                if (fullscreenImage) {
                  e.preventDefault();
                }
              }}
              className="max-w-xl w-[92vw]"
            >
              <DialogHeader>
                <DialogTitle>Run ejection check</DialogTitle>
                {!ejectionCheckLoading && !ejectionCheckError && !ejectionCheckPolling && (
                  <DialogDescription>
                    This will run the ejector checks script for magazine {selectedMagazine}. The kiosk will eject one key (with retries)
                    and record test cuts. New key head images will appear in the ejection grid and below once processing completes. Continue?
                  </DialogDescription>
                )}
              </DialogHeader>
              <div className="flex flex-col gap-4 pt-2">
                {ejectionCheckLoading && (
                  <div className="flex flex-col items-center justify-center gap-3 py-6">
                    <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
                    <p className="text-sm text-muted-foreground">Starting ejector checks…</p>
                    <p className="text-xs text-muted-foreground">This can take several minutes. The kiosk may move and eject keys.</p>
                  </div>
                )}
                {ejectionCheckPolling && !ejectionCheckLoading && !ejectionCheckError && !ejectionCheckResult && (
                  <div className="flex flex-col items-center justify-center gap-2 py-4">
                    <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
                    <p className="text-sm text-muted-foreground">Waiting for new ejection image from cloud…</p>
                    <p className="text-xs text-muted-foreground">We refresh recent test cuts every few seconds. This can take up to a couple of minutes.</p>
                  </div>
                )}
                {ejectionCheckResult && (
                  <div className="space-y-2 rounded-md border bg-muted/10 p-3">
                    <p className="text-xs font-medium text-foreground/80">
                      Latest ejection image for magazine {selectedMagazine} (ID {ejectionCheckResult.id})
                    </p>
                    <img
                      src={ejectionCheckResult.image.url}
                      alt={ejectionCheckResult.image.filename}
                      className="max-h-48 w-full rounded border border-border object-contain bg-background"
                    />
                    <p className="text-[11px] text-muted-foreground break-all">
                      {ejectionCheckResult.image.filename}
                    </p>
                  </div>
                )}
                {ejectionCheckImagesLoading && (
                  <div className="flex flex-col items-center justify-center gap-2 py-4">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
                    <p className="text-xs text-muted-foreground">Loading all images for this ejection run…</p>
                  </div>
                )}
                {ejectionCheckImages && ejectionCheckImages.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground/80">All images for this ejection run</p>
                    <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                      {ejectionCheckImages.map((img, idx) => (
                        <button
                          key={`${img.key || img.filename || idx}`}
                          type="button"
                          className="group flex flex-col gap-1 rounded-md border border-border bg-background p-1 text-left"
                          onClick={() => {
                            setFullscreenImages(ejectionCheckImages);
                            setFullscreenIndex(idx);
                            setFullscreenImage({
                              base64: null,
                              label: img.filename || 'Image',
                              url: img.url,
                            });
                          }}
                        >
                          <img
                            src={img.url}
                            alt={img.filename}
                            className="h-28 w-full rounded border border-border object-contain bg-muted/40"
                          />
                          <span className="line-clamp-2 break-all text-[11px] text-muted-foreground group-hover:text-foreground">
                            {img.filename}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {ejectionCheckImagesFetchError && !ejectionCheckImagesLoading && (
                  <p className="text-xs text-destructive">{ejectionCheckImagesFetchError}</p>
                )}
                {ejectionCheckImages && ejectionCheckImages.length === 0 && !ejectionCheckImagesLoading && (
                  <p className="text-xs text-muted-foreground">
                    No additional images were returned for this ejection run from the cloud API.
                  </p>
                )}
                {ejectionCheckError && !ejectionCheckLoading && (
                  <>
                    <p className="text-sm text-destructive">{ejectionCheckError}</p>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCloseEjectionCheckModal}
                        className="rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
                      >
                        Close
                      </button>
                    </div>
                  </>
                )}
                {!ejectionCheckLoading && !ejectionCheckError && (
                  <>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={ejectionCheckOverrideRemote}
                        onChange={(e) => setEjectionCheckOverrideRemote(e.target.checked)}
                        className="rounded border-input"
                      />
                      Allow while developer/fab session is connected (override safety check)
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={handleCloseEjectionCheckModal}
                        className="rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmEjectionCheck}
                        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Run ejection check
                      </button>
                    </div>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
          {fullscreenImage && (
            <div
              className="fixed inset-0 z-[100] pointer-events-auto flex flex-col items-center justify-center bg-black/95 p-4"
              role="dialog"
              aria-modal="true"
              aria-label={`Fullscreen: ${fullscreenImage.label}`}
              onClick={(e) => {
                // Prevent accidental background clicks from interacting with underlying modals.
                e.stopPropagation();
              }}
            >
              <p className="absolute left-4 top-4 text-sm text-white/90">{fullscreenImage.label}</p>
              <button
                type="button"
                onClick={() => {
                  setFullscreenImage(null);
                  setFullscreenImages(null);
                  setFullscreenIndex(null);
                }}
                className="absolute right-4 top-4 rounded-md bg-white/10 p-2 text-white hover:bg-white/20"
                aria-label="Close fullscreen"
              >
                <X className="size-5" />
              </button>
              {fullscreenImages && fullscreenImages.length > 1 && fullscreenIndex != null && (
                <>
                  <button
                    type="button"
                    className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                    aria-label="Previous image"
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextIndex =
                        (fullscreenIndex - 1 + fullscreenImages.length) % fullscreenImages.length;
                      setFullscreenIndex(nextIndex);
                      const img = fullscreenImages[nextIndex];
                      setFullscreenImage({
                        base64: null,
                        url: img.url,
                        label: img.filename || fullscreenImage.label,
                      });
                    }}
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
                    aria-label="Next image"
                    onClick={(e) => {
                      e.stopPropagation();
                      const nextIndex = (fullscreenIndex + 1) % fullscreenImages.length;
                      setFullscreenIndex(nextIndex);
                      const img = fullscreenImages[nextIndex];
                      setFullscreenImage({
                        base64: null,
                        url: img.url,
                        label: img.filename || fullscreenImage.label,
                      });
                    }}
                  >
                    ›
                  </button>
                </>
              )}
              <img
                src={fullscreenImage.url || (fullscreenImage.base64 ? captureImageDataUrl(fullscreenImage.base64) : '')}
                alt={fullscreenImage.label}
                className="max-h-[90vh] max-w-full object-contain"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!fullscreenImages || fullscreenImages.length <= 1 || fullscreenIndex == null) return;
                  const nextIndex = (fullscreenIndex + 1) % fullscreenImages.length;
                  setFullscreenIndex(nextIndex);
                  const img = fullscreenImages[nextIndex];
                  if (!img?.url) return;
                  setFullscreenImage({
                    base64: null,
                    url: img.url,
                    label: img.filename || fullscreenImage.label,
                  });
                }}
              />
              <p className="mt-2 text-xs text-white/70">Esc or X closes. Click image or use Left/Right arrows to cycle.</p>
            </div>
          )}
        </>
      )}
      <Dialog open={restoreFromAdminModalOpen} onOpenChange={(open) => !open && handleCloseRestoreFromAdminModal()}>
        <DialogContent showClose={true} onClose={handleCloseRestoreFromAdminModal} className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Restore from Admin</DialogTitle>
            <DialogDescription>
              Fetch inventory from Admin for any kiosk, then upload it to the connected kiosk.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex flex-col gap-2">
              <label htmlFor="restore-admin-kiosk" className="text-sm font-medium">
                Kiosk ID
              </label>
              <div className="flex gap-2">
                <input
                  id="restore-admin-kiosk"
                  type="text"
                  value={restoreFromAdminKiosk}
                  onChange={(e) => setRestoreFromAdminKiosk(e.target.value)}
                  placeholder="e.g. NS3512"
                  className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={!restoreFromAdminKiosk.trim() || fetchStockLoading}
                  onClick={handleFetchFromAdmin}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {fetchStockLoading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <RefreshCw className="size-4 shrink-0" aria-hidden />}
                  Fetch from Admin
                </button>
              </div>
            </div>
            {fetchStockError && (
              <p className="text-sm text-destructive">{fetchStockError}</p>
            )}
            {fetchedStock && (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">Inventory data</p>
                  <pre className="overflow-auto max-h-64 rounded border border-border bg-muted/30 p-3 text-xs">
                    {JSON.stringify(fetchedStock, null, 2)}
                  </pre>
                </div>
                <button
                  type="button"
                  disabled={uploadToKioskLoading || isSocketDisabled}
                  onClick={handleUploadToKiosk}
                  className="inline-flex items-center justify-center gap-2 self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploadToKioskLoading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <Upload className="size-4 shrink-0" aria-hidden />}
                  {uploadToKioskLoading ? 'Uploading…' : 'Upload to this kiosk'}
                </button>
                {isSocketDisabled && (
                  <p className="text-xs text-muted-foreground">Connect to a kiosk to upload.</p>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
