import { useState, useCallback, useEffect, useRef } from 'react';
import { Stage, Layer, Image, Rect, Transformer } from 'react-konva';
import useImage from 'use-image';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, RotateCcw, Play, Maximize2, Minimize2, ImageIcon, AlertTriangle, ChevronDown, ChevronRight, CheckCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import leftGoodCropUrl from '@/assets/left_good_crop.jpg';
import rightGoodCropUrl from '@/assets/right_good_crop.jpg';

const RESIZE_FACTOR = 0.5;
const PREVIEW_RESIZE_FACTOR = 0.3;
const STAGE_MAX = { width: 800, height: 600 };
const STAGE_MAX_SIDE = { width: 480, height: 360 };
const PREVIEW_MAX_SIZE = { width: 400, height: 300 };

const RESTART_PROCESS_OPTIONS = [
  { value: 'det', label: 'DETs (DET, DET_BITTING_LEFT, DET_BITTING_RIGHT)' },
  { value: 'det_bitting_left', label: 'DET_BITTING_LEFT' },
  { value: 'det_bitting_right', label: 'DET_BITTING_RIGHT' },
];

function RoiCanvas({
  imageSrc,
  imageSize,
  roiRect,
  onRoiChange,
  disabled,
  fullscreen,
  containerRef,
  maxSize = STAGE_MAX,
  onScaleChange,
  flip = 0,
}) {
  const [image] = useImage(imageSrc ?? '');
  const stageRef = useRef(null);
  const rectRef = useRef(null);
  const [rectNode, setRectNode] = useState(null);
  const [stageSize, setStageSize] = useState({ width: maxSize.width, height: maxSize.height });

  useEffect(() => {
    if (fullscreen && containerRef?.current) {
      const el = containerRef.current;
      const update = () => {
        const w = el.offsetWidth || window.innerWidth;
        const h = el.offsetHeight || window.innerHeight;
        if (w > 0 && h > 0) setStageSize({ width: w, height: h });
      };
      update();
      const ro = new ResizeObserver(update);
      ro.observe(el);
      window.addEventListener('resize', update);
      return () => {
        ro.disconnect();
        window.removeEventListener('resize', update);
      };
    }
    if (!stageRef.current?.container()) return;
    const container = stageRef.current.container();
    const update = () => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        setStageSize({
          width: Math.min(container.offsetWidth, maxSize.width),
          height: Math.min(container.offsetHeight, maxSize.height),
        });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => ro.disconnect();
  }, [imageSrc, fullscreen, containerRef, maxSize]);

  const scale =
    imageSize?.width && imageSize?.height
      ? Math.min(
          stageSize.width / imageSize.width,
          stageSize.height / imageSize.height,
          1
        )
      : 1;
  const stageW = imageSize ? imageSize.width * scale : stageSize.width;
  const stageH = imageSize ? imageSize.height * scale : stageSize.height;

  const flipH = flip === 1 || flip === -1;
  const flipV = flip === 0 || flip === -1;
  const imageScaleX = flipH ? -scale : scale;
  const imageScaleY = flipV ? -scale : scale;
  const imageX = flipH && imageSize ? imageSize.width * scale : 0;
  const imageY = flipV && imageSize ? imageSize.height * scale : 0;

  useEffect(() => {
    if (onScaleChange && imageSize?.width && imageSize?.height) onScaleChange(scale);
  }, [scale, imageSize, onScaleChange]);

  const handleRectDragEnd = useCallback(
    (e) => {
      const r = e.target;
      onRoiChange({
        x: r.x(),
        y: r.y(),
        width: r.width(),
        height: r.height(),
      });
    },
    [onRoiChange]
  );

  const handleRectTransformEnd = useCallback(
    () => {
      const node = rectRef.current;
      if (!node) return;
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();
      node.scaleX(1);
      node.scaleY(1);
      onRoiChange({
        x: node.x(),
        y: node.y(),
        width: Math.max(5, node.width() * scaleX),
        height: Math.max(5, node.height() * scaleY),
      });
    },
    [onRoiChange]
  );

  if (!imageSrc) return null;

  return (
    <Stage
      ref={stageRef}
      width={stageW}
      height={stageH}
      style={{ border: fullscreen ? 'none' : '1px solid var(--border)', borderRadius: fullscreen ? 0 : 8 }}
    >
      <Layer>
        <Image
          image={image}
          width={imageSize?.width ?? 0}
          height={imageSize?.height ?? 0}
          x={imageX}
          y={imageY}
          scaleX={imageScaleX}
          scaleY={imageScaleY}
          listening={false}
        />
        {roiRect && (
          <>
            <Rect
              ref={(n) => {
                rectRef.current = n;
                setRectNode(n);
              }}
              x={roiRect.x}
              y={roiRect.y}
              width={roiRect.width}
              height={roiRect.height}
              fill="rgba(0,0,255,0.2)"
              stroke="blue"
              strokeWidth={2}
              draggable={!disabled}
              onDragEnd={handleRectDragEnd}
              onTransformEnd={handleRectTransformEnd}
              dragBoundFunc={(pos) => ({
                x: Math.max(0, Math.min(pos.x, stageW - roiRect.width)),
                y: Math.max(0, Math.min(pos.y, stageH - roiRect.height)),
              })}
            />
            {!disabled && rectNode && (
              <Transformer
                nodes={[rectNode]}
                boundBoxFunc={(oldBox, newBox) => {
                  if (newBox.width < 5 || newBox.height < 5) return oldBox;
                  return {
                    ...newBox,
                    x: Math.max(0, Math.min(newBox.x, stageW - 5)),
                    y: Math.max(0, Math.min(newBox.y, stageH - 5)),
                    width: Math.min(newBox.width, stageW - newBox.x),
                    height: Math.min(newBox.height, stageH - newBox.y),
                  };
                }}
              />
            )}
          </>
        )}
      </Layer>
    </Stage>
  );
}

export default function CalibrationRoiPage({ socket, kioskName }) {
  const [side, setSide] = useState('left');
  const [imagesBySide, setImagesBySide] = useState({ left: null, right: null });
  const [roiBySide, setRoiBySide] = useState({ left: null, right: null });
  const [flipBySide, setFlipBySide] = useState({ left: 0, right: 0 });
  const [loadingImageBySide, setLoadingImageBySide] = useState({ left: false, right: false });
  const [saving, setSaving] = useState({ left: false, right: false });
  const [restarting, setRestarting] = useState(false);
  const [status, setStatus] = useState({ text: '', isError: false });
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [restartProcess, setRestartProcess] = useState('det');
  const [submitResult, setSubmitResult] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(null);
  const [restartProgress, setRestartProgress] = useState(null);
  const restartTimeoutRef = useRef(null);
  const restartStoppedRef = useRef(null);
  const restartStartedRef = useRef(null);
  const restartLogEndRef = useRef(null);
  const [fullscreen, setFullscreen] = useState(null);
  const [previewBySide, setPreviewBySide] = useState({ left: null, right: null });
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewFullscreen, setPreviewFullscreen] = useState(null);
  const [previewSectionOpen, setPreviewSectionOpen] = useState(true);
  const fullscreenScaleRef = useRef(1);
  const convertedToFullscreenRef = useRef(false);
  const fullscreenContainerRef = useRef(null);
  const leftContainerRef = useRef(null);
  const rightContainerRef = useRef(null);

  const handleExitFullscreen = useCallback(() => {
    const s = fullscreen;
    if (s) {
      const img = imagesBySide[s];
      const rect = roiBySide[s];
      const el = fullscreenContainerRef.current;
      if (img && rect && (el?.offsetWidth > 0 && el?.offsetHeight > 0 || fullscreenScaleRef.current > 0)) {
        const panelScale = Math.min(
          STAGE_MAX_SIDE.width / img.width,
          STAGE_MAX_SIDE.height / img.height,
          1
        );
        const fsScale =
          el?.offsetWidth > 0 && el?.offsetHeight > 0
            ? Math.min(el.offsetWidth / img.width, el.offsetHeight / img.height, 1)
            : fullscreenScaleRef.current;
        if (fsScale > 0) {
          setRoiBySide((prev) => ({
            ...prev,
            [s]: {
              x: (rect.x * panelScale) / fsScale,
              y: (rect.y * panelScale) / fsScale,
              width: (rect.width * panelScale) / fsScale,
              height: (rect.height * panelScale) / fsScale,
            },
          }));
        }
      }
    }
    convertedToFullscreenRef.current = false;
    setFullscreen(null);
  }, [fullscreen, imagesBySide, roiBySide]);

  const parseImageData = useCallback((data) => {
    if (!data?.imageBase64) return null;
    return new Promise((resolve) => {
      const img = new window.Image();
      img.onload = () =>
        resolve({
          base64: data.imageBase64,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      img.onerror = () => resolve(null);
      img.src = `data:image/jpeg;base64,${data.imageBase64}`;
    });
  }, []);

  const loadPreviews = useCallback(() => {
    if (!socket?.connected || loadingPreviews) return;
    setLoadingPreviews(true);
    setStatus((prev) => (prev.text ? prev : { text: '', isError: false }));
    Promise.all([
      socket.request('take_image', { camera: 'bitting_video_left_roi_box', resize_factor: PREVIEW_RESIZE_FACTOR }),
      socket.request('take_image', { camera: 'bitting_video_right_roi_box', resize_factor: PREVIEW_RESIZE_FACTOR }),
    ])
      .then(([resLeft, resRight]) => {
        if (resLeft && !resLeft.success && resLeft.errors?.some((e) => String(e).toLowerCase().includes('permission'))) {
          setPermissionDenied(true);
        }
        if (resRight && !resRight.success && resRight.errors?.some((e) => String(e).toLowerCase().includes('permission'))) {
          setPermissionDenied(true);
        }
        const dataLeft = resLeft?.success ? resLeft.data : resLeft;
        const dataRight = resRight?.success ? resRight.data : resRight;
        return Promise.all([
          dataLeft?.imageBase64 ? parseImageData(dataLeft) : Promise.resolve(null),
          dataRight?.imageBase64 ? parseImageData(dataRight) : Promise.resolve(null),
        ]).then(([left, right]) => {
          setPreviewBySide({ left, right });
        });
      })
      .catch((err) => {
        setStatus({ text: err?.message || 'Failed to load previews', isError: true });
      })
      .finally(() => setLoadingPreviews(false));
  }, [socket, loadingPreviews, parseImageData]);

  const loadRoiForSide = useCallback(
    (s, img) => {
      if (!img || !socket?.connected) return;
      const scale = Math.min(
        STAGE_MAX_SIDE.width / img.width,
        STAGE_MAX_SIDE.height / img.height,
        1
      );
      const s2 = RESIZE_FACTOR * scale;
      return socket.request('get_roi', { side: s }).then((res) => {
        if (res && res.success === false && res.errors?.length) {
          if (res.errors.some((e) => String(e).toLowerCase().includes('permission'))) {
            setPermissionDenied(true);
          }
          return;
        }
        const data = res?.data ?? res;
        if (data) {
          if (typeof data.flip === 'number') {
            setFlipBySide((prev) => ({ ...prev, [s]: data.flip }));
          }
          if (data.blade_channel_top != null) {
            setRoiBySide((prev) => ({
              ...prev,
              [s]: {
                x: (data.blade_channel_left ?? 0) * s2,
                y: (data.blade_channel_top ?? 0) * s2,
                width: ((data.blade_channel_right ?? 0) - (data.blade_channel_left ?? 0)) * s2,
                height: ((data.blade_channel_bottom ?? 0) - (data.blade_channel_top ?? 0)) * s2,
              },
            }));
          } else {
            setRoiBySide((prev) => ({ ...prev, [s]: null }));
          }
        }
      });
    },
    [socket]
  );

  const loadImageForSide = useCallback(
    (s) => {
      if (!socket?.connected || loadingImageBySide[s]) return;
      const camera = s === 'left' ? 'bitting_video_left' : 'bitting_video_right';
      setLoadingImageBySide((prev) => ({ ...prev, [s]: true }));
      setStatus({ text: '', isError: false });
      socket
        .request('take_image', { camera, resize_factor: RESIZE_FACTOR })
        .then((res) => {
          if (res && !res.success && res.errors?.some((e) => String(e).toLowerCase().includes('permission'))) {
            setPermissionDenied(true);
          }
          const data = res?.success ? res.data : null;
          if (data?.error) {
            setLoadingImageBySide((prev) => ({ ...prev, [s]: false }));
            setStatus({ text: `${s}: ${data.error}`, isError: true });
            return;
          }
          return parseImageData(data).then((img) => {
            setLoadingImageBySide((prev) => ({ ...prev, [s]: false }));
            if (!img) return;
            setImagesBySide((prev) => ({ ...prev, [s]: img }));
            if (socket?.connected) loadRoiForSide(s, img);
          });
        })
        .catch((err) => {
          setLoadingImageBySide((prev) => ({ ...prev, [s]: false }));
          setStatus({ text: err?.message || 'Failed to load image', isError: true });
        });
    },
    [socket, loadingImageBySide, parseImageData, loadRoiForSide]
  );

  // When entering fullscreen, convert panel ROI to fullscreen coords once container has layout
  useEffect(() => {
    if (!fullscreen || !imagesBySide[fullscreen] || !roiBySide[fullscreen] || convertedToFullscreenRef.current)
      return;
    let cancelled = false;
    const run = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (cancelled || convertedToFullscreenRef.current) return;
          const el = fullscreenContainerRef.current;
          if (!el?.offsetWidth || !el?.offsetHeight) return;
          const img = imagesBySide[fullscreen];
          const rect = roiBySide[fullscreen];
          const panelScale = Math.min(
            STAGE_MAX_SIDE.width / img.width,
            STAGE_MAX_SIDE.height / img.height,
            1
          );
          const fsScale = Math.min(el.offsetWidth / img.width, el.offsetHeight / img.height, 1);
          if (fsScale <= 0) return;
          convertedToFullscreenRef.current = true;
          setRoiBySide((prev) => ({
            ...prev,
            [fullscreen]: {
              x: (rect.x * fsScale) / panelScale,
              y: (rect.y * fsScale) / panelScale,
              width: (rect.width * fsScale) / panelScale,
              height: (rect.height * fsScale) / panelScale,
            },
          }));
        });
      });
    };
    run();
    return () => { cancelled = true; };
  }, [fullscreen, imagesBySide[fullscreen]]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (previewFullscreen) setPreviewFullscreen(null);
        else handleExitFullscreen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExitFullscreen, previewFullscreen]);

  const getScaleForSide = useCallback(
    (s) => {
      if (fullscreen === s) return fullscreenScaleRef.current || 1;
      const img = imagesBySide[s];
      if (!img?.width || !img?.height) return 1;
      return Math.min(
        STAGE_MAX_SIDE.width / img.width,
        STAGE_MAX_SIDE.height / img.height,
        1
      );
    },
    [imagesBySide, fullscreen]
  );

  const handleRoiChange = useCallback((s, newRect) => {
    setRoiBySide((prev) => ({ ...prev, [s]: newRect }));
  }, []);

  const handleSaveRoi = useCallback(
    (s) => {
      const rect = roiBySide[s];
      if (!socket?.connected || !rect || saving[s]) return;
      setSaving((prev) => ({ ...prev, [s]: true }));
      setStatus({ text: '', isError: false });
      const scale = getScaleForSide(s);
      const div = 1 / (RESIZE_FACTOR * scale);
      const payload = {
        side: s,
        blade_channel_top: Math.round(rect.y * div),
        blade_channel_bottom: Math.round((rect.y + rect.height) * div),
        blade_channel_left: Math.round(rect.x * div),
        blade_channel_right: Math.round((rect.x + rect.width) * div),
      };
      socket
        .request('save_roi', payload)
        .then((res) => {
          setSaving((prev) => ({ ...prev, [s]: false }));
          if (res?.success === false && res?.errors?.length) {
            setSubmitResult({ success: false, message: res.errors.join('; ') });
            return;
          }
          const msg = res?.data?.message ?? 'Config is saved. Please restart DETs process to apply changes.';
          setSubmitResult({ success: true, message: msg });
        })
        .catch((err) => {
          setSaving((prev) => ({ ...prev, [s]: false }));
          setSubmitResult({ success: false, message: err?.message || 'Save failed' });
        });
    },
    [socket, roiBySide, saving, getScaleForSide]
  );

  function clearRestartListeners() {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (socket) {
      if (restartStoppedRef.current) {
        socket.off('async.PROCESS_STOPPED', restartStoppedRef.current);
        restartStoppedRef.current = null;
      }
      if (restartStartedRef.current) {
        socket.off('async.PROCESS_STARTED', restartStartedRef.current);
        restartStartedRef.current = null;
      }
    }
  }

  const closeRestartDialog = useCallback(() => {
    clearRestartListeners();
    setRestartProgress(null);
    setConfirmRestart(null);
    setRestarting(false);
  }, []);

  useEffect(() => {
    return () => clearRestartListeners();
  }, [socket]);

  useEffect(() => {
    if (restartProgress?.logLines?.length && restartLogEndRef.current) {
      restartLogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [restartProgress?.logLines?.length]);

  const handleRestartClick = () => {
    if (!socket?.connected || restarting) return;
    const label = RESTART_PROCESS_OPTIONS.find((o) => o.value === restartProcess)?.label ?? restartProcess;
    setConfirmRestart({ process: restartProcess, label });
  };

  const handleConfirmRestart = () => {
    if (!confirmRestart || !socket?.connected) return;
    const { process: processName, label: processLabel } = confirmRestart;
    setRestartProgress({
      processName,
      logLines: ['Request sent.'],
      done: false,
    });
    setRestarting(true);
    socket
      .request('fleet_restart_process', { process: processName })
      .then((res) => {
        setRestartProgress((prev) =>
          prev ? { ...prev, logLines: [...prev.logLines, 'Accepted.'] } : prev
        );
        const handlerStopped = (data) => {
          setRestartProgress((prev) =>
            prev ? { ...prev, logLines: [...prev.logLines, `PROCESS_STOPPED: ${data?.process ?? '?'}`] } : prev
          );
        };
        const handlerStarted = (data) => {
          const p = data?.process;
          let matched = false;
          setRestartProgress((prev) => {
            if (!prev || prev.done) return prev;
            const match = p && prev.processName && String(p).toLowerCase() === String(prev.processName).toLowerCase();
            const next = { ...prev, logLines: [...prev.logLines, `PROCESS_STARTED: ${p ?? '?'}`], done: match };
            if (match) matched = true;
            return next;
          });
          if (matched) {
            if (restartTimeoutRef.current) {
              clearTimeout(restartTimeoutRef.current);
              restartTimeoutRef.current = null;
            }
            setRestarting(false);
          }
        };
        restartStoppedRef.current = handlerStopped;
        restartStartedRef.current = handlerStarted;
        socket.on('async.PROCESS_STOPPED', handlerStopped);
        socket.on('async.PROCESS_STARTED', handlerStarted);
        restartTimeoutRef.current = setTimeout(() => {
          restartTimeoutRef.current = null;
          setRestartProgress((prev) =>
            prev && !prev.done
              ? { ...prev, done: true, logLines: [...prev.logLines, 'Timeout waiting for process to start.'] }
              : prev
          );
          setRestarting(false);
        }, 60000);
      })
      .catch((err) => {
        const msg = err?.message || 'Request failed';
        setRestartProgress((prev) =>
          prev ? { ...prev, done: true, logLines: [...prev.logLines, msg] } : prev
        );
        setRestarting(false);
      });
  };

  const handleReset = useCallback(
    (s) => {
      setStatus({ text: '', isError: false });
      const img = imagesBySide[s];
      if (img && socket?.connected) loadRoiForSide(s, img);
      else setRoiBySide((prev) => ({ ...prev, [s]: null }));
    },
    [imagesBySide, socket, loadRoiForSide]
  );

  const handleClearRoi = useCallback((s) => {
    setRoiBySide((prev) => ({ ...prev, [s]: null }));
    setStatus({ text: '', isError: false });
  }, []);

  const handleNewRoi = useCallback(
    (s) => {
      const img = imagesBySide[s];
      if (!img) return;
      const scale = Math.min(
        STAGE_MAX_SIDE.width / img.width,
        STAGE_MAX_SIDE.height / img.height,
        1
      );
      setRoiBySide((prev) => ({
        ...prev,
        [s]: {
          x: 0,
          y: 0,
          width: img.width * scale,
          height: img.height * scale,
        },
      }));
      setStatus({ text: '', isError: false });
    },
    [imagesBySide]
  );

  if (permissionDenied) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Bitting ROI</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You need restart-all permission to use Bitting ROI. Request the permission at{' '}
            <a
              href="https://admin.key.me/permissions"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              admin.key.me/permissions
            </a>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  function SidePanel({ side: s }) {
    const img = imagesBySide[s];
    const src = img?.base64 ? `data:image/jpeg;base64,${img.base64}` : null;
    const size = img ? { width: img.width, height: img.height } : null;
    const rect = roiBySide[s];
    const containerRef = s === 'left' ? leftContainerRef : rightContainerRef;
    const isFullscreen = fullscreen === s;
    const loading = loadingImageBySide[s];
    return (
      <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{s} camera</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => loadImageForSide(s)}
              disabled={!socket?.connected || loading}
              className="inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Load image
            </button>
            {src && (
              <button
                type="button"
                onClick={() => {
                  if (isFullscreen) handleExitFullscreen();
                  else {
                    convertedToFullscreenRef.current = false;
                    setFullscreen(s);
                  }
                }}
                className="inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
                title="Fullscreen (Esc to exit)"
              >
                <Maximize2 className="size-3.5" />
                Fullscreen
              </button>
            )}
          </div>
        </div>
        <div ref={containerRef} className="relative min-h-[240px] w-full overflow-hidden rounded-md bg-muted/50">
          {!src && !loading && (
            <div className="flex h-[240px] w-full items-center justify-center text-sm text-muted-foreground">
              Load image to draw ROI
            </div>
          )}
          {loading && (
            <div className="flex h-[240px] w-full flex-col items-center justify-center gap-2">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading {s}…</span>
            </div>
          )}
          {src && !loading && (
            <RoiCanvas
              imageSrc={src}
              imageSize={size}
              roiRect={rect}
              onRoiChange={(newRect) => handleRoiChange(s, newRect)}
              disabled={saving[s]}
              fullscreen={false}
              containerRef={containerRef}
              maxSize={STAGE_MAX_SIDE}
              flip={flipBySide[s]}
            />
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleSaveRoi(s)}
            disabled={!socket?.connected || !rect || saving[s]}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving[s] ? <Loader2 className="size-4 animate-spin" /> : null}
            Submit ROI
          </button>
          <button
            type="button"
            onClick={() => handleReset(s)}
            disabled={!socket?.connected || !img}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
            title="Reload ROI from server"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </button>
          <button
            type="button"
            onClick={() => handleClearRoi(s)}
            disabled={!rect}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
            title="Remove ROI (then use New ROI to draw)"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => handleNewRoi(s)}
            disabled={!img || !!rect}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
            title="Draw new ROI (full image, then resize/drag)"
          >
            New ROI
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Bitting ROI</CardTitle>
          <div className="mt-2 space-y-2 text-sm text-muted-foreground">
            <p>
              When calibration bitting, the kiosk detects a Region of Interest (ROI)—what the kiosk actually sees when
              running the scanning algorithm. Anything outside this region is ignored. Restart DETs process after submitting ROI to apply changes.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-2 rounded-lg border border-border bg-muted/10 p-3" aria-label="Preview">
            <button
              type="button"
              onClick={() => setPreviewSectionOpen((open) => !open)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset"
              aria-expanded={previewSectionOpen}
            >
              {previewSectionOpen ? (
                <ChevronDown className="size-4 shrink-0" />
              ) : (
                <ChevronRight className="size-4 shrink-0" />
              )}
              What the kiosk sees (ROI + dewarp). Check these before adjusting RIO . Click a preview for fullscreen (Esc to close).
            </button>
            {previewSectionOpen && (
            <div className="flex flex-wrap items-end gap-4 border-t border-border px-3 pb-3 pt-1">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Bitting video left (ROI)</span>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => previewBySide.left && setPreviewFullscreen('left')}
                  onKeyDown={(e) => e.key === 'Enter' && previewBySide.left && setPreviewFullscreen('left')}
                  className="flex cursor-pointer items-center justify-center overflow-hidden rounded border border-border bg-muted/50 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary"
                  style={{
                    width: PREVIEW_MAX_SIZE.width,
                    height: PREVIEW_MAX_SIZE.height,
                    minWidth: PREVIEW_MAX_SIZE.width,
                    minHeight: PREVIEW_MAX_SIZE.height,
                  }}
                >
                  {loadingPreviews ? (
                    <Loader2 className="size-8 animate-spin text-muted-foreground" />
                  ) : previewBySide.left ? (
                    <img
                      src={`data:image/jpeg;base64,${previewBySide.left.base64}`}
                      alt="Left ROI preview"
                      className="max-h-full max-w-full object-contain pointer-events-none"
                      style={{ maxWidth: PREVIEW_MAX_SIZE.width, maxHeight: PREVIEW_MAX_SIZE.height }}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Bitting video right (ROI)</span>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => previewBySide.right && setPreviewFullscreen('right')}
                  onKeyDown={(e) => e.key === 'Enter' && previewBySide.right && setPreviewFullscreen('right')}
                  className="flex cursor-pointer items-center justify-center overflow-hidden rounded border border-border bg-muted/50 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary"
                  style={{
                    width: PREVIEW_MAX_SIZE.width,
                    height: PREVIEW_MAX_SIZE.height,
                    minWidth: PREVIEW_MAX_SIZE.width,
                    minHeight: PREVIEW_MAX_SIZE.height,
                  }}
                >
                  {loadingPreviews ? (
                    <Loader2 className="size-8 animate-spin text-muted-foreground" />
                  ) : previewBySide.right ? (
                    <img
                      src={`data:image/jpeg;base64,${previewBySide.right.base64}`}
                      alt="Right ROI preview"
                      className="max-h-full max-w-full object-contain pointer-events-none"
                      style={{ maxWidth: PREVIEW_MAX_SIZE.width, maxHeight: PREVIEW_MAX_SIZE.height }}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={loadPreviews}
                disabled={!socket?.connected || loadingPreviews}
                className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                {loadingPreviews ? <Loader2 className="size-4 animate-spin" /> : null}
                Refresh previews
              </button>
            </div>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-border bg-muted/10 p-3" aria-label="Example good crops">
            <h3 className="text-sm font-semibold text-foreground">Example good crops</h3>
            <p className="text-sm text-muted-foreground">
              Reference images for how the ROI crop should look. Gate side is most critical; right side must be maxed out.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={leftGoodCropUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2 hover:no-underline"
              >
                <ImageIcon className="size-4 shrink-0" />
                Left side example
              </a>
              <a
                href={rightGoodCropUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2 hover:no-underline"
              >
                <ImageIcon className="size-4 shrink-0" />
                Right side example
              </a>
            </div>
          </section>

          {previewFullscreen && previewBySide[previewFullscreen] && (
            <div
              className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
              role="dialog"
              aria-label={`${previewFullscreen} ROI preview fullscreen`}
              onClick={() => setPreviewFullscreen(null)}
              onKeyDown={(e) => e.key === 'Escape' && setPreviewFullscreen(null)}
            >
              <div className="mb-2 flex w-full max-w-4xl items-center justify-between text-sm text-white">
                <span className="font-medium">Bitting video {previewFullscreen} (ROI)</span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setPreviewFullscreen(null); }}
                  className="rounded border border-white/30 px-2 py-1 hover:bg-white/10"
                >
                  Close (Esc)
                </button>
              </div>
              <div
                className="flex max-h-[calc(100vh-80px)] w-full max-w-4xl flex-1 items-center justify-center"
                onClick={(e) => e.stopPropagation()}
              >
                <img
                  src={`data:image/jpeg;base64,${previewBySide[previewFullscreen].base64}`}
                  alt={`${previewFullscreen} ROI preview`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </div>
          )}

          <section className="space-y-3" aria-label="ROI calibration">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">ROI calibration</h3>
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0" />
                Adjust only if you&apos;re familiar with ROI calibration
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              Load an image per side, then adjust the blue rectangle (drag or resize). Submit to save. Reset reloads from server; Clear removes the box; New ROI draws a full-image box to adjust.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <SidePanel side="left" />
              <SidePanel side="right" />
            </div>
          </section>

          {status.text && (
            <p className={cn('text-sm', status.isError ? 'text-destructive' : 'text-muted-foreground')}>
              {status.text}
            </p>
          )}

          <section className="flex flex-wrap items-center gap-2 border-t border-border pt-4" aria-label="Restart to apply">
            <span className="text-sm font-medium">Restart to apply:</span>
            <select
              value={restartProcess}
              onChange={(e) => setRestartProcess(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {RESTART_PROCESS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleRestartClick}
              disabled={!socket?.connected || restarting}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {restarting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Restart
            </button>
          </section>
        </CardContent>
      </Card>

      <Dialog open={!!submitResult} onOpenChange={(open) => !open && setSubmitResult(null)}>
        <DialogContent onClose={() => setSubmitResult(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {submitResult?.success ? (
                <>
                  <CheckCircle className="size-5 text-green-600" aria-hidden />
                  ROI saved
                </>
              ) : (
                <>
                  <XCircle className="size-5 text-destructive" aria-hidden />
                  Save failed
                </>
              )}
            </DialogTitle>
            <DialogDescription>{submitResult?.message}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              onClick={() => setSubmitResult(null)}
            >
              OK
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!confirmRestart}
        onOpenChange={(open) => {
          if (!open && (!restartProgress || restartProgress.done)) closeRestartDialog();
        }}
      >
        <DialogContent
          showClose={!(restartProgress != null && !restartProgress.done)}
          onClose={closeRestartDialog}
        >
          {confirmRestart && restartProgress != null ? (
            <>
              <DialogHeader>
                <DialogTitle>Restart process</DialogTitle>
                <DialogDescription>Restarting {confirmRestart.label}.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div
                  className="max-h-32 overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-xs"
                  role="log"
                  aria-live="polite"
                >
                  {restartProgress.logLines.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                  <div ref={restartLogEndRef} />
                </div>
                <div className="flex items-center gap-2">
                  {!restartProgress.done && (
                    <>
                      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                      <span className="text-sm text-muted-foreground">Restarting…</span>
                    </>
                  )}
                </div>
                {restartProgress.done && (
                  <div className="flex justify-end">
                    <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={closeRestartDialog}>
                      Close
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : confirmRestart ? (
            <>
              <DialogHeader>
                <DialogTitle>Restart process</DialogTitle>
                <DialogDescription>
                  Are you sure you want to restart &quot;{confirmRestart.label}&quot;?
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-0">
                <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50" onClick={closeRestartDialog}>
                  Cancel
                </button>
                <button type="button" className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ml-2" onClick={handleConfirmRestart} disabled={restarting}>
                  {restarting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : 'Confirm'}
                </button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/50 px-4 py-2">
            <span className="text-sm font-medium">{fullscreen} camera</span>
            <button
              type="button"
              onClick={handleExitFullscreen}
              className="ml-auto inline-flex items-center gap-1.5 rounded border border-input bg-background px-2 py-1 text-sm hover:bg-accent"
            >
              <Minimize2 className="size-4" />
              Exit fullscreen (Esc)
            </button>
          </div>
          <div ref={fullscreenContainerRef} className="min-h-0 flex-1">
            {imagesBySide[fullscreen] && (
              <RoiCanvas
                imageSrc={`data:image/jpeg;base64,${imagesBySide[fullscreen].base64}`}
                imageSize={{ width: imagesBySide[fullscreen].width, height: imagesBySide[fullscreen].height }}
                roiRect={roiBySide[fullscreen]}
                onRoiChange={(newRect) => handleRoiChange(fullscreen, newRect)}
                disabled={saving[fullscreen]}
                fullscreen={true}
                containerRef={fullscreenContainerRef}
                maxSize={STAGE_MAX}
                flip={flipBySide[fullscreen]}
                onScaleChange={(scale) => {
                  fullscreenScaleRef.current = scale;
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
