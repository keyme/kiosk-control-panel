import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { CheckCircle, XCircle, ChevronDown, ChevronRight, ChevronLeft, ZoomIn, ZoomOut, Image as ImageIcon, Ruler } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiUrl } from '@/lib/apiUrl';
import CornerstoneViewer from '@/components/CornerstoneViewer';

const DEWARP_CACHE_MAX = 50;
/** In-memory cache for dewarp results. Key is stable (runId + step + artifact path + homography) so it works when presigned URLs change. */
const dewarpCache = new Map();

function normalizeHomographyForKey(h) {
  if (!h || !Array.isArray(h)) return '';
  return JSON.stringify(
    h.map((row) => (Array.isArray(row) ? row.map((x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x)) : row))
  );
}

function getDewarpCacheKey(runId, stepName, artifactPathOrLabel, homography) {
  const path = artifactPathOrLabel ?? '';
  const hKey = normalizeHomographyForKey(homography);
  return `${runId}\t${stepName ?? ''}\t${path}\t${hKey}`;
}

function getCachedDewarpUrl(runId, stepName, artifactPathOrLabel, homography) {
  const key = getDewarpCacheKey(runId, stepName, artifactPathOrLabel, homography);
  return dewarpCache.get(key) ?? null;
}

function setCachedDewarpUrl(runId, stepName, artifactPathOrLabel, homography, objectUrl) {
  const key = getDewarpCacheKey(runId, stepName, artifactPathOrLabel, homography);
  while (dewarpCache.size >= DEWARP_CACHE_MAX && dewarpCache.size > 0) {
    const firstKey = dewarpCache.keys().next().value;
    const oldUrl = dewarpCache.get(firstKey);
    dewarpCache.delete(firstKey);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
  dewarpCache.set(key, objectUrl);
}

/** Explanations for each trace step so viewers know what they're looking at and what to check. */
const STEP_EXPLANATIONS = {
  prepare: {
    title: 'Prepare',
    whatItIs: 'Pre-run setup (e.g. camera ready, environment).',
    whatToLookFor: 'Step should succeed. If it fails, check the reason — often environment or permissions.',
  },
  init: {
    title: 'Init',
    whatItIs: 'Initializing gripper camera settings (resolution, etc.).',
    whatToLookFor: 'Must succeed. A failure here usually means the camera could not be configured; check hardware and drivers.',
  },
  focus: {
    title: 'Focus',
    whatItIs: 'Focus calibration: the system captures images at several focus positions and picks the sharpest one. The camera is focused on the gripper jaw — the surface where the key will sit.',
    whatToLookFor: 'Artifacts show the focus sweep. The "Selected focus" image is the one chosen. Look for a sharp view of the gripper jaw; blur or poor contrast here can affect later steps.',
  },
  homography: {
    title: 'Homography',
    whatItIs: 'The camera looks at a calibration pattern; a 3×3 homography matrix is computed so images can be dewarped to a flat view.',
    whatToLookFor: 'Pattern must be visible and stable. Use "Apply homography" in fullscreen to check the dewarped image. Toggle "Reference lines" to overlay horizontal and vertical lines — a flat view will have straight edges and chessboard aligned with these lines. Failures usually mean the pattern was not found (obstructed, dirty, or wrong lighting).',
  },
  validate: {
    title: 'Validate',
    whatItIs: 'Automated validation: the system captures a frame and checks that the camera mount is correct and that the homography still fits the scene (e.g. dewarped view looks good).',
    whatToLookFor: 'Step passes if the validation image passes the checks. Artifacts are the validation image(s). If it fails, check the reason (e.g. mount, pattern not found, or homography mismatch).',
  },
};

function formatStartedAt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function ArtifactImage({ artifact, onClick, isSelected, onOpenCornerstone }) {
  const url = artifact?.url;
  const label = artifact?.label ?? '';
  const path = artifact?.path ?? '';
  if (!url) {
    return (
      <div className={cn('flex flex-col gap-1', isSelected && 'ring-2 ring-primary ring-offset-2 rounded-md')}>
        <span className="font-medium text-foreground text-sm">{label}</span>
        <span className="text-muted-foreground text-xs break-all">{path}</span>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', isSelected && 'ring-2 ring-primary ring-offset-2 rounded-md')}>
      <button
        type="button"
        onClick={() => onClick?.(artifact)}
        className={cn(
          'rounded border overflow-hidden bg-muted/30 hover:opacity-90 focus:ring-2 focus:ring-ring focus:ring-offset-2 text-left',
          isSelected ? 'border-primary border-2' : 'border-border'
        )}
      >
        <img
          src={url}
          alt={label}
          className="max-h-48 w-auto max-w-full object-contain cursor-pointer block"
          title="Click to enlarge"
        />
      </button>
      <span className="font-medium text-foreground text-sm">
        {label}
        {isSelected && <span className="ml-1 text-primary text-xs">(selected)</span>}
      </span>
      {onOpenCornerstone && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenCornerstone(artifact); }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus:ring-2 focus:ring-ring rounded"
        >
          <Ruler className="size-3.5" aria-hidden />
          Open with Cornerstone
        </button>
      )}
    </div>
  );
}

function StepRow({ step, defaultOpen, runId }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const hasDetails = (step.artifacts?.length > 0) || (step.scalars && Object.keys(step.scalars).length > 0) || step.reason || (step.homography && step.name === 'homography');
  const SuccessIcon = step.success ? CheckCircle : XCircle;
  const iconClass = step.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';

  const [fullscreen, setFullscreen] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [imgSize, setImgSize] = useState(null);
  const [dewarpedUrl, setDewarpedUrl] = useState(null);
  const [dewarpLoading, setDewarpLoading] = useState(false);
  const [dewarpError, setDewarpError] = useState(null);
  const [showReferenceLines, setShowReferenceLines] = useState(false);
  const [cornerstoneImage, setCornerstoneImage] = useState(null);
  const openFullscreen = useCallback((artifact, artifacts, index, selectedLabel, stepName, stepHomography) => {
    setFullscreen({
      artifacts: artifacts ?? [artifact],
      index: index ?? 0,
      selectedLabel: selectedLabel ?? null,
      stepName: stepName ?? null,
      homography: stepHomography ?? null,
      runId: runId ?? null,
    });
    setZoom(1);
    setImgSize(null);
    setDewarpedUrl(null);
    setDewarpError(null);
  }, []);
  const goPrev = useCallback(() => {
    if (!fullscreen?.artifacts?.length) return;
    setFullscreen((prev) => ({
      ...prev,
      index: (prev.index - 1 + prev.artifacts.length) % prev.artifacts.length,
    }));
    setZoom(1);
    setImgSize(null);
    setDewarpedUrl(null);
    setDewarpError(null);
  }, [fullscreen?.artifacts?.length]);
  const goNext = useCallback(() => {
    if (!fullscreen?.artifacts?.length) return;
    setFullscreen((prev) => ({
      ...prev,
      index: (prev.index + 1) % prev.artifacts.length,
    }));
    setZoom(1);
    setImgSize(null);
    setDewarpedUrl(null);
    setDewarpError(null);
  }, [fullscreen?.artifacts?.length]);
  const closeFullscreen = useCallback(() => {
    setDewarpedUrl(null);
    setFullscreen(null);
  }, []);
  const onFullscreenImgLoad = useCallback((e) => {
    const img = e.target;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const maxH = typeof window !== 'undefined' ? window.innerHeight * 0.85 : 600;
    const maxW = typeof window !== 'undefined' ? window.innerWidth * 0.95 : 800;
    const scale = Math.min(1, maxW / w, maxH / h);
    setImgSize({ w: w * scale, h: h * scale });
  }, []);
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 1.25;
  const zoomIn = useCallback(() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP)), []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e) => {
      if ((fullscreen.artifacts?.length ?? 0) > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goPrev();
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          goNext();
          return;
        }
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP));
      } else if (e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(ZOOM_MIN, z / ZOOM_STEP));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen, goPrev, goNext]);

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium',
          hasDetails && 'hover:bg-muted/50'
        )}
        aria-expanded={open}
      >
        {hasDetails ? (
          open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        <SuccessIcon className={cn('size-4 shrink-0', iconClass)} aria-hidden />
        <span className="capitalize">{step.name}</span>
        {step.scalars && !open && (
          <span className="ml-auto text-muted-foreground font-normal">
            {Object.entries(step.scalars).map(([k, v]) => `${k}: ${v}`).join(', ')}
          </span>
        )}
      </button>
      {open && hasDetails && (
        <div className="border-t border-border bg-muted/30 px-4 py-3 space-y-3">
          {STEP_EXPLANATIONS[step.name] && (
            <div className="rounded-md border border-border bg-background/80 p-3 text-sm space-y-1.5">
              <div className="font-medium text-foreground">
                What is this step?
              </div>
              <p className="text-muted-foreground">
                {STEP_EXPLANATIONS[step.name].whatItIs}
              </p>
              <div className="font-medium text-foreground pt-0.5">
                What to look for
              </div>
              <p className="text-muted-foreground">
                {STEP_EXPLANATIONS[step.name].whatToLookFor}
              </p>
            </div>
          )}
          {step.reason && (
            <p className="text-sm text-muted-foreground">{step.reason}</p>
          )}
          {step.scalars && Object.keys(step.scalars).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {Object.entries(step.scalars).map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
                >
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          )}
          {step.name === 'homography' && step.homography && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1.5">Homography (3×3)</div>
              <pre className="rounded-md border border-border bg-muted/50 p-3 text-xs overflow-auto max-h-48 font-mono whitespace-pre">
                {JSON.stringify(step.homography, null, 2)}
              </pre>
            </div>
          )}
          {step.artifacts?.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <ImageIcon className="size-3.5" aria-hidden />
                Artifacts
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {step.artifacts.map((a, i) => {
                  const selectedLabel =
                    step.name === 'focus' && step.scalars?.focus_absolute != null
                      ? `focus_${step.scalars.focus_absolute}`
                      : null;
                  return (
                    <ArtifactImage
                      key={i}
                      artifact={a}
                      onClick={() => openFullscreen(a, step.artifacts, i, selectedLabel, step.name, step.homography)}
                      isSelected={selectedLabel != null && a.label === selectedLabel}
                      onOpenCornerstone={(art) => art?.url && setCornerstoneImage({ url: art.url, label: art?.label ?? art?.path ?? '' })}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {fullscreen && (() => {
        const artifacts = fullscreen.artifacts ?? [];
        const index = fullscreen.index ?? 0;
        const current = artifacts[index];
        const selectedLabel = fullscreen.selectedLabel ?? null;
        const isSelectedFocus = selectedLabel != null && current?.label === selectedLabel;
        const canNavigate = artifacts.length > 1;
        const homography = fullscreen.homography ?? null;
        const runIdForCache = fullscreen.runId ?? '';
        const stepNameForCache = fullscreen.stepName ?? '';
        const artifactPathOrLabel = current?.path ?? current?.label ?? '';
        const canApplyHomography = homography && current?.url;
        const displayUrl = dewarpedUrl || current?.url;
        const applyHomography = () => {
          if (!current?.url || !homography) return;
          const cached = getCachedDewarpUrl(runIdForCache, stepNameForCache, artifactPathOrLabel, homography);
          if (cached) {
            setDewarpError(null);
            setDewarpedUrl(cached);
            return;
          }
          setDewarpLoading(true);
          setDewarpError(null);
          fetch(apiUrl('/api/calibration/trace/gripper_cam/dewarp'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_url: current.url, homography }),
          })
            .then((res) => {
              if (!res.ok) return res.json().then((d) => Promise.reject(new Error(d.error || res.statusText)));
              return res.blob();
            })
            .then((blob) => {
              const url = URL.createObjectURL(blob);
              setCachedDewarpUrl(runIdForCache, stepNameForCache, artifactPathOrLabel, homography, url);
              setDewarpedUrl(url);
            })
            .catch((e) => setDewarpError(e?.message ?? String(e)))
            .finally(() => setDewarpLoading(false));
        };
        return (
          <Dialog open onOpenChange={(open) => !open && closeFullscreen()}>
            <DialogContent className="max-w-[95vw] max-h-[95vh] w-auto p-2 overflow-auto flex flex-col">
              <div className="relative flex items-center justify-center min-h-[200px] flex-1 overflow-auto">
                {canNavigate && (
                  <button
                    type="button"
                    onClick={goPrev}
                    className="absolute left-0 top-1/2 -translate-y-1/2 z-10 rounded-full bg-background/90 border border-border p-2 shadow-md hover:bg-muted focus:ring-2 focus:ring-ring"
                    aria-label="Previous image"
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                )}
                {displayUrl && (
                  <div
                    className="relative flex items-center justify-center overflow-auto"
                    style={
                      imgSize
                        ? {
                            width: Math.round(imgSize.w * zoom),
                            height: Math.round(imgSize.h * zoom),
                            minWidth: Math.round(imgSize.w * zoom),
                            minHeight: Math.round(imgSize.h * zoom),
                          }
                        : undefined
                    }
                  >
                    <img
                      key={displayUrl}
                      src={displayUrl}
                      alt={current?.label ?? ''}
                      className={imgSize ? 'object-contain' : 'max-h-[85vh] w-auto max-w-full object-contain'}
                      style={imgSize ? { width: Math.round(imgSize.w * zoom), height: Math.round(imgSize.h * zoom) } : undefined}
                      draggable={false}
                      onLoad={dewarpedUrl ? undefined : onFullscreenImgLoad}
                    />
                    {showReferenceLines && imgSize && (
                      <svg
                        className="absolute inset-0 w-full h-full pointer-events-none"
                        style={{ width: Math.round(imgSize.w * zoom), height: Math.round(imgSize.h * zoom) }}
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                      >
                        {[25, 50, 75].map((p) => (
                          <line
                            key={`h-${p}`}
                            x1="0"
                            y1={p}
                            x2="100"
                            y2={p}
                            stroke="rgba(234, 179, 8, 0.85)"
                            strokeWidth="0.3"
                          />
                        ))}
                        {[25, 50, 75].map((p) => (
                          <line
                            key={`v-${p}`}
                            x1={p}
                            y1="0"
                            x2={p}
                            y2="100"
                            stroke="rgba(234, 179, 8, 0.85)"
                            strokeWidth="0.3"
                          />
                        ))}
                      </svg>
                    )}
                  </div>
                )}
                {canNavigate && (
                  <button
                    type="button"
                    onClick={goNext}
                    className="absolute right-0 top-1/2 -translate-y-1/2 z-10 rounded-full bg-background/90 border border-border p-2 shadow-md hover:bg-muted focus:ring-2 focus:ring-ring"
                    aria-label="Next image"
                  >
                    <ChevronRight className="size-6" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-4 shrink-0 pt-2">
                <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
                  <button
                    type="button"
                    onClick={zoomOut}
                    disabled={zoom <= ZOOM_MIN}
                    className="rounded p-1.5 hover:bg-muted focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                    aria-label="Zoom out"
                  >
                    <ZoomOut className="size-5" />
                  </button>
                  <span className="min-w-[3rem] text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
                  <button
                    type="button"
                    onClick={zoomIn}
                    disabled={zoom >= ZOOM_MAX}
                    className="rounded p-1.5 hover:bg-muted focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:pointer-events-none"
                    aria-label="Zoom in"
                  >
                    <ZoomIn className="size-5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowReferenceLines((v) => !v)}
                  className={cn(
                    'rounded-md border px-2 py-1.5 text-sm font-medium focus:ring-2 focus:ring-ring',
                    showReferenceLines ? 'border-amber-500 bg-amber-500/20 text-amber-700 dark:text-amber-400' : 'border-border bg-muted/50 hover:bg-muted text-muted-foreground'
                  )}
                >
                  Reference lines
                </button>
                {displayUrl && (
                  <button
                    type="button"
                    onClick={() => setCornerstoneImage({ url: displayUrl, label: `${current?.label ?? ''}${dewarpedUrl ? ' (dewarped)' : ''}`.trim() })}
                    className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-sm font-medium hover:bg-muted focus:ring-2 focus:ring-ring"
                  >
                    <Ruler className="size-4" aria-hidden />
                    Open with Cornerstone
                  </button>
                )}
                {canApplyHomography && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={applyHomography}
                      disabled={dewarpLoading}
                      className="rounded-md border border-border bg-muted/50 px-2 py-1.5 text-sm font-medium hover:bg-muted focus:ring-2 focus:ring-ring disabled:opacity-50"
                    >
                      {dewarpLoading ? 'Applying…' : dewarpedUrl ? 'Re-apply homography' : 'Apply homography'}
                    </button>
                    {dewarpedUrl && (
                      <button
                        type="button"
                        onClick={() => setDewarpedUrl(null)}
                        className="rounded-md border border-border px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                      >
                        Show original
                      </button>
                    )}
                  </div>
                )}
                {dewarpError && <span className="text-destructive text-sm">{dewarpError}</span>}
                <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                  <span>{current?.label ?? ''}</span>
                  <span>({index + 1} / {artifacts.length})</span>
                  {dewarpedUrl && <span className="text-primary text-xs">dewarped</span>}
                  {isSelectedFocus && (
                    <span className="inline-flex items-center rounded-md bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                      Selected focus
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground text-center max-w-md">
                  Toggle &quot;Reference lines&quot; to overlay horizontal and vertical lines. Use them to check that the image is flat — straight edges and the chessboard should align with the lines.
                </p>
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}
      <Dialog open={!!cornerstoneImage} onOpenChange={(open) => !open && setCornerstoneImage(null)}>
        <DialogContent
          className="fixed inset-0 z-50 h-screen w-screen max-h-none max-w-none translate-x-0 translate-y-0 rounded-none border-0 p-4 overflow-auto"
        >
          <DialogTitle className="sr-only">Image measurement (Esc to close)</DialogTitle>
          <DialogDescription className="sr-only">
            Measure and view the image with Cornerstone tools. Press Escape to close.
          </DialogDescription>
          {cornerstoneImage?.url && (
            <div className="h-full w-full min-h-0 flex flex-col">
              <CornerstoneViewer imageUrl={cornerstoneImage.url} pixelSpacing={1} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function CalibrationTracingGripperCam({ kioskName: kioskNameProp }) {
  const { runId: runIdParam } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const kioskName = searchParams.get('kiosk_name') || kioskNameProp;

  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [trace, setTrace] = useState(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState(null);

  const runId = runIdParam ? decodeURIComponent(runIdParam) : '';

  useEffect(() => {
    if (!kioskName) {
      setRunsLoading(false);
      setRuns([]);
      return;
    }
    setRunsLoading(true);
    fetch(apiUrl(`/api/calibration/trace/gripper_cam/runs?kiosk=${encodeURIComponent(kioskName)}`))
      .then((res) => res.ok ? res.json() : [])
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  }, [kioskName]);

  useEffect(() => {
    if (!kioskName || !runId) {
      setTrace(null);
      setTraceError(null);
      return;
    }
    setTraceLoading(true);
    setTraceError(null);
    fetch(apiUrl(`/api/calibration/trace/gripper_cam?kiosk=${encodeURIComponent(kioskName)}&run_id=${encodeURIComponent(runId)}`))
      .then((res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error('Trace not found');
          throw new Error(res.statusText || 'Failed to load trace');
        }
        return res.json();
      })
      .then(setTrace)
      .catch((e) => {
        setTraceError(e.message);
        setTrace(null);
      })
      .finally(() => setTraceLoading(false));
  }, [kioskName, runId]);

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available. Connect to a device first.</p>
        </CardContent>
      </Card>
    );
  }

  const latestPath = kioskName
    ? `/${kioskName}/calibration/tracing/gripper-cam/latest`
    : '/calibration/tracing/gripper-cam/latest';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <label htmlFor="trace-run-select" className="text-sm font-medium text-muted-foreground">
          Run:
        </label>
        <select
          id="trace-run-select"
          value={runId}
          onChange={(e) => {
            const v = e.target.value;
            const base = kioskName ? `/${kioskName}` : '';
            const path = base ? `${base}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam';
            if (v) navigate(`${path}/${encodeURIComponent(v)}`);
            else navigate(path);
          }}
          disabled={runsLoading}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm min-w-[200px]"
        >
          <option value="">Select a run</option>
          {runs.map((r) => (
            <option key={r.run_id} value={r.run_id}>
              {r.run_id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => navigate(latestPath)}
          className="text-primary text-sm font-medium underline hover:no-underline"
        >
          Open latest
        </button>
        {runsLoading && <span className="text-muted-foreground text-sm">Loading runs…</span>}
        {!runsLoading && runs.length === 0 && (
          <span className="text-muted-foreground text-sm">No trace runs found.</span>
        )}
      </div>

      {traceLoading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">Loading trace…</p>
          </CardContent>
        </Card>
      )}

      {traceError && !traceLoading && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive text-sm">{traceError}</p>
          </CardContent>
        </Card>
      )}

      {trace && !traceLoading && (
        <Card>
          <CardHeader>
            <CardTitle>Gripper Cam calibration trace</CardTitle>
            <p className="text-sm text-muted-foreground max-w-2xl mt-1">
              This trace records each step of a gripper camera calibration run. Expand a step to see what it means,
              what to look for, and any artifacts (images) or scalars. Use this to debug failed runs or verify that
              focus and homography results look correct.
            </p>
            <div className="flex flex-wrap gap-4 text-sm text-muted-foreground mt-2">
              <span>Run ID: <code className="text-foreground font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{trace.run_id}</code></span>
              <span>Started: {formatStartedAt(trace.started_at)}</span>
              <span>Type: {trace.calibration_type}</span>
              {trace.trace_version != null && <span>Trace v{trace.trace_version}</span>}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {trace.steps?.map((step, i) => (
              <StepRow key={i} step={step} defaultOpen={i === 0} runId={trace.run_id} />
            ))}
          </CardContent>
        </Card>
      )}

      {!runId && !runsLoading && runs.length > 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground text-sm">Select a run above to view its trace.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
