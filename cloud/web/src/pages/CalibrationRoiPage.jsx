import { useState, useCallback, useEffect, useRef } from 'react';
import { Stage, Layer, Image, Rect, Transformer } from 'react-konva';
import useImage from 'use-image';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, RotateCcw, Play, Maximize2, Minimize2, ImageIcon, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import leftGoodCropUrl from '@/assets/left_good_crop.jpg';
import rightGoodCropUrl from '@/assets/right_good_crop.jpg';

const RESIZE_FACTOR = 1;
const STAGE_MAX = { width: 800, height: 600 };
const STAGE_MAX_SIDE = { width: 480, height: 360 };

const RESTART_PROCESS_OPTIONS = [
  { value: 'det', label: 'DETs (DET, DET_BITTING_LEFT, DET_BITTING_RIGHT, DET_MILLING)' },
  { value: 'det_bitting_left', label: 'DET_BITTING_LEFT' },
  { value: 'det_bitting_right', label: 'DET_BITTING_RIGHT' },
  { value: 'det_milling', label: 'DET_MILLING' },
  { value: 'restart_all', label: 'Restart all (connection will drop)' },
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
          scaleX={scale}
          scaleY={scale}
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
  const [loadingImages, setLoadingImages] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState('');
  const [saving, setSaving] = useState({ left: false, right: false });
  const [restarting, setRestarting] = useState(false);
  const [status, setStatus] = useState({ text: '', isError: false });
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [restartProcess, setRestartProcess] = useState('det');
  const [fullscreen, setFullscreen] = useState(null);
  const fullscreenScaleRef = useRef(1);
  const convertedToFullscreenRef = useRef(false);
  const fullscreenContainerRef = useRef(null);
  const leftContainerRef = useRef(null);
  const rightContainerRef = useRef(null);

  const handleExitFullscreen = useCallback(() => {
    convertedToFullscreenRef.current = false;
    const s = fullscreen;
    if (!s) return;
    const img = imagesBySide[s];
    const rect = roiBySide[s];
    if (img && rect && fullscreenScaleRef.current > 0) {
      const panelScale = Math.min(
        STAGE_MAX_SIDE.width / img.width,
        STAGE_MAX_SIDE.height / img.height,
        1
      );
      const fsScale = fullscreenScaleRef.current;
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
        if (data && data.blade_channel_top != null) {
          setRoiBySide((prev) => ({
            ...prev,
            [s]: {
              x: (data.blade_channel_left ?? 0) * s2,
              y: (data.blade_channel_top ?? 0) * s2,
              width: ((data.blade_channel_right ?? 0) - (data.blade_channel_left ?? 0)) * s2,
              height: ((data.blade_channel_bottom ?? 0) - (data.blade_channel_top ?? 0)) * s2,
            },
          }));
        }
      });
    },
    [socket]
  );

  const loadBothImages = useCallback(() => {
    if (!socket?.connected || loadingImages) return;
    setLoadingImages(true);
    setStatus({ text: '', isError: false });
    setLoadingPhase('left');
    socket
      .request('take_image', { camera: 'bitting_video_left', resize_factor: RESIZE_FACTOR })
      .then((resLeft) => {
        if (resLeft && !resLeft.success && resLeft.errors?.some((e) => String(e).toLowerCase().includes('permission'))) {
          setPermissionDenied(true);
        }
        const dataLeft = resLeft?.success ? resLeft.data : null;
        if (dataLeft?.error) {
          setLoadingImages(false);
          setLoadingPhase('');
          setStatus({ text: `Left: ${dataLeft.error}`, isError: true });
          return;
        }
        return parseImageData(dataLeft).then((left) => {
          if (!left) {
            setLoadingImages(false);
            setLoadingPhase('');
            return;
          }
          setImagesBySide((prev) => ({ ...prev, left }));
          setLoadingPhase('right');
          return socket
            .request('take_image', { camera: 'bitting_video_right', resize_factor: RESIZE_FACTOR })
            .then((resRight) => {
              if (resRight && !resRight.success && resRight.errors?.some((e) => String(e).toLowerCase().includes('permission'))) {
                setPermissionDenied(true);
              }
              const dataRight = resRight?.success ? resRight.data : null;
              if (dataRight?.error) {
                setLoadingImages(false);
                setLoadingPhase('');
                setStatus((prev) => ({ ...prev, text: `Right: ${dataRight.error}`, isError: true }));
                return;
              }
              return parseImageData(dataRight).then((right) => {
                setLoadingImages(false);
                setLoadingPhase('');
                setImagesBySide((prev) => ({ ...prev, right }));
                if (!socket?.connected) return;
                loadRoiForSide('left', left);
                loadRoiForSide('right', right);
              });
            });
        });
      })
      .catch((err) => {
        setLoadingImages(false);
        setLoadingPhase('');
        setStatus({ text: err?.message || 'Failed to load images', isError: true });
      });
  }, [socket, loadingImages, parseImageData, loadRoiForSide]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') handleExitFullscreen();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleExitFullscreen]);

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
            setStatus({ text: res.errors.join('; '), isError: true });
            return;
          }
          const msg = res?.data?.message ?? 'Config is saved. Please restart DETs process to apply changes.';
          setStatus({ text: msg, isError: false });
        })
        .catch((err) => {
          setSaving((prev) => ({ ...prev, [s]: false }));
          setStatus({ text: err?.message || 'Save failed', isError: true });
        });
    },
    [socket, roiBySide, saving, getScaleForSide]
  );

  const handleRestartDet = () => {
    if (!socket?.connected || restarting) return;
    const label = RESTART_PROCESS_OPTIONS.find((o) => o.value === restartProcess)?.label ?? restartProcess;
    const warn =
      restartProcess === 'restart_all'
        ? 'Restart all processes? The connection will be lost.'
        : `Restart ${label}?`;
    if (!window.confirm(warn)) return;
    setRestarting(true);
    setStatus({ text: '', isError: false });
    socket
      .request('fleet_restart_process', { process: restartProcess })
      .then((res) => {
        setRestarting(false);
        if (res?.success === false && res?.errors?.length) {
          setStatus({ text: res.errors.join('; '), isError: true });
          return;
        }
        setStatus({ text: `Restart requested: ${restartProcess}`, isError: false });
      })
      .catch((err) => {
        setRestarting(false);
        setStatus({ text: err?.message || 'Restart failed', isError: true });
      });
  };

  const handleReset = useCallback((s) => {
    setRoiBySide((prev) => ({ ...prev, [s]: null }));
    setStatus({ text: '', isError: false });
  }, []);

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
    return (
      <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{s} camera</span>
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
        <div ref={containerRef} className="relative min-h-[240px] w-full overflow-hidden rounded-md bg-muted/50">
          {!src && !loadingImages && (
            <div className="flex h-[240px] w-full items-center justify-center text-sm text-muted-foreground">
              —
            </div>
          )}
          {loadingImages && loadingPhase === s && (
            <div className="flex h-[240px] w-full flex-col items-center justify-center gap-2">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading {s}…</span>
            </div>
          )}
          {src && !(loadingImages && loadingPhase === s) && (
            <RoiCanvas
              imageSrc={src}
              imageSize={size}
              roiRect={rect}
              onRoiChange={(newRect) => handleRoiChange(s, newRect)}
              disabled={saving[s]}
              fullscreen={false}
              containerRef={containerRef}
              maxSize={STAGE_MAX_SIDE}
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
            disabled={!rect}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-2">
            <CardTitle className="shrink-0">Bitting ROI</CardTitle>
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5 shrink-0" />
              Adjust only if you&apos;re familiar with ROI calibration
            </span>
          </div>
          <div className="mt-2 space-y-3 text-sm text-muted-foreground">
            <p>
              When calibration bitting, the kiosk detects a Region of Interest (ROI)—what the kiosk actually sees when
              running the scanning algorithm. Anything outside this region is ignored, so these values are critical.
            </p>
            <p>
              In most cases the kiosk finds the correct ROI automatically. Only in rare situations (e.g. poor bitting
              camera quality) is human intervention needed.
            </p>
            <p>
              <strong>Note:</strong> Gate side is most critical for accurate measurements. Top and bottom can be
              bigger; right side must be maxed out. Restart DETs process after submitting ROI to apply changes.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-foreground">Example good crops:</span>
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
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={loadBothImages}
              disabled={!socket?.connected || loadingImages}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loadingImages ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Loading {loadingPhase || '…'}
                </>
              ) : (
                'Load images'
              )}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <SidePanel side="left" />
            <SidePanel side="right" />
          </div>

          {status.text && (
            <p className={cn('text-sm', status.isError ? 'text-destructive' : 'text-muted-foreground')}>
              {status.text}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
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
              onClick={handleRestartDet}
              disabled={!socket?.connected || restarting}
              className="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {restarting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              Restart DETs process
            </button>
          </div>
        </CardContent>
      </Card>

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
                onScaleChange={(scale) => {
                  fullscreenScaleRef.current = scale;
                  if (!convertedToFullscreenRef.current && roiBySide[fullscreen]) {
                    convertedToFullscreenRef.current = true;
                    const img = imagesBySide[fullscreen];
                    const rect = roiBySide[fullscreen];
                    if (img?.width && img?.height) {
                      const panelScale = Math.min(
                        STAGE_MAX_SIDE.width / img.width,
                        STAGE_MAX_SIDE.height / img.height,
                        1
                      );
                      if (panelScale > 0) {
                        setRoiBySide((prev) => ({
                          ...prev,
                          [fullscreen]: {
                            x: (rect.x * scale) / panelScale,
                            y: (rect.y * scale) / panelScale,
                            width: (rect.width * scale) / panelScale,
                            height: (rect.height * scale) / panelScale,
                          },
                        }));
                      }
                    }
                  }
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
