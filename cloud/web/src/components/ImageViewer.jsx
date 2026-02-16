import { useCallback, useEffect, useRef, useState } from 'react';
import { Ruler, CornerDownRight, Hand, Crop, RotateCw, Eraser, Maximize2 } from 'lucide-react';
import { Stage, Layer, Group, Image, Line, Rect, Text } from 'react-konva';
import useImage from 'use-image';

const VIEWER_ID = 'image-measure-viewer';

const TOOLS = [
  { name: 'Length', label: 'Length', Icon: Ruler, shortcut: 'Q' },
  { name: 'Angle', label: 'Angle', Icon: CornerDownRight, shortcut: 'E' },
  { name: 'Pan', label: 'Pan', Icon: Hand, shortcut: 'A' },
  { name: 'RectangleRoi', label: 'Crop', Icon: Crop, shortcut: 'C' },
  { name: 'Rotate', label: 'Rotate', Icon: RotateCw, shortcut: 'R' },
  { name: 'Fit', label: 'Fit', Icon: Maximize2, shortcut: 'F' },
  { name: 'Reset', label: 'Reset', Icon: Eraser, shortcut: 'X' },
];

const SHORTCUT_TO_TOOL = Object.fromEntries(TOOLS.map((t) => [t.shortcut.toLowerCase(), t.name]));

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        setSize({ width: el.offsetWidth, height: el.offsetHeight });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function getMmPerPixel({ pixelSpacing, pixelsPerMm }) {
  if (pixelsPerMm != null && Number.isFinite(pixelsPerMm) && pixelsPerMm > 0) {
    return 1 / pixelsPerMm;
  }
  if (pixelSpacing != null && Number.isFinite(pixelSpacing) && pixelSpacing > 0) {
    return pixelSpacing;
  }
  return 1 / 50;
}

const defaultPixelsPerMm = 50;

function lengthPx(points) {
  if (!points || points.length < 4) return 0;
  const dx = points[2] - points[0];
  const dy = points[3] - points[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function angleDeg(points) {
  if (!points || points.length < 6) return 0;
  const [x1, y1, x2, y2, x3, y3] = points;
  const ax = x1 - x2;
  const ay = y1 - y2;
  const bx = x3 - x2;
  const by = y3 - y2;
  const dot = ax * bx + ay * by;
  const cross = ax * by - ay * bx;
  const rad = Math.atan2(Math.abs(cross), dot);
  return Math.abs((rad * 180) / Math.PI);
}

function rotatePoint({ x, y }, deg) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Stage coords -> image pixel coords (origin top-left). Uses view + image center. */
function stageToImage(stagePt, view, imgWidth, imgHeight) {
  const cx = imgWidth / 2;
  const cy = imgHeight / 2;
  const translated = { x: stagePt.x - view.pos.x, y: stagePt.y - view.pos.y };
  const unRotated = rotatePoint(translated, -view.rotationDeg);
  return {
    x: unRotated.x / view.scale + cx,
    y: unRotated.y / view.scale + cy,
  };
}

/** Image pixel coords (origin top-left) -> stage coords. */
function imageToStage(imgPt, view, imgWidth, imgHeight) {
  const cx = imgWidth / 2;
  const cy = imgHeight / 2;
  const local = { x: (imgPt.x - cx) * view.scale, y: (imgPt.y - cy) * view.scale };
  const rotated = rotatePoint(local, view.rotationDeg);
  return { x: view.pos.x + rotated.x, y: view.pos.y + rotated.y };
}

export default function ImageViewer({ imageUrl, pixelSpacing, pixelsPerMm }) {
  const containerRef = useRef(null);
  const groupRef = useRef(null);
  const imageRef = useRef(null);
  const size = useElementSize(containerRef);

  const [image, imageStatus] = useImage(imageUrl ?? '');
  const [error, setError] = useState(null);
  const [activeTool, setActiveTool] = useState('Length');
  const initialMmPerPixel = getMmPerPixel({ pixelSpacing, pixelsPerMm });
  const initialPixelsPerMm = 1 / initialMmPerPixel;
  const [pixelsPerMmInput, setPixelsPerMmInput] = useState(initialPixelsPerMm);
  const mmPerPixel = 1 / (Number(pixelsPerMmInput) || defaultPixelsPerMm);

  const [view, setView] = useState({ pos: { x: 0, y: 0 }, scale: 1, rotationDeg: 0 });
  const [annotations, setAnnotations] = useState([]);
  const [drawing, setDrawing] = useState(null);
  const [angleStep, setAngleStep] = useState(0);
  const [cropRect, setCropRect] = useState(null);

  const spaceDownRef = useRef(false);
  const isPanningRef = useRef(false);
  const panLastRef = useRef(null);
  const pointerIdRef = useRef(null);

  const stageWidth = size.width;
  const stageHeight = size.height;
  const imgWidth = image?.width ?? 0;
  const imgHeight = image?.height ?? 0;

  useEffect(() => {
    if (imageStatus === 'failed') setError('Failed to load image');
    else if (imageStatus === 'loaded') setError(null);
  }, [imageStatus]);

  const fittedForImageRef = useRef(null);
  const fitStageSizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    if (!imgWidth || !imgHeight || !stageWidth || !stageHeight) return;
    if (fittedForImageRef.current === imageUrl) return;
    fittedForImageRef.current = imageUrl;
    fitStageSizeRef.current = { width: stageWidth, height: stageHeight };
    setCropRect(null);
    const scale = Math.min(stageWidth / imgWidth, stageHeight / imgHeight);
    setView({ pos: { x: stageWidth / 2, y: stageHeight / 2 }, scale, rotationDeg: 0 });
  }, [imageUrl, imgWidth, imgHeight, stageWidth, stageHeight]);

  useEffect(() => {
    setPixelsPerMmInput(initialPixelsPerMm);
  }, [imageUrl, initialPixelsPerMm]);

  const getImagePointFromStage = useCallback(
    (stageX, stageY) => stageToImage({ x: stageX, y: stageY }, view, imgWidth, imgHeight),
    [view, imgWidth, imgHeight]
  );

  const fitView = useCallback(() => {
    if (!imgWidth || !imgHeight || !stageWidth || !stageHeight) return;
    const { width: w, height: h } = fitStageSizeRef.current;
    const sw = w > 0 ? w : stageWidth;
    const sh = h > 0 ? h : stageHeight;
    if (sw > 0 && sh > 0) {
      const scale = Math.min(sw / imgWidth, sh / imgHeight);
      setView((v) => ({ ...v, pos: { x: sw / 2, y: sh / 2 }, scale }));
    }
  }, [imgWidth, imgHeight, stageWidth, stageHeight]);

  const handleStageWheel = useCallback(
    (e) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      setView((v) => {
        const scaleBy = 1.1;
        const newScale = e.evt.deltaY > 0 ? v.scale / scaleBy : v.scale * scaleBy;
        const clamped = Math.max(0.1, Math.min(20, newScale));
        const imgPt = stageToImage(pointer, v, imgWidth, imgHeight);
        const staged = imageToStage(imgPt, { pos: { x: 0, y: 0 }, scale: clamped, rotationDeg: v.rotationDeg }, imgWidth, imgHeight);
        return { ...v, scale: clamped, pos: { x: pointer.x - staged.x, y: pointer.y - staged.y } };
      });
    },
    [imgWidth, imgHeight]
  );

  const handleRotate = useCallback(() => {
    setView((v) => {
      const stageCenter = { x: stageWidth / 2, y: stageHeight / 2 };
      const imgPt = stageToImage(stageCenter, v, imgWidth, imgHeight);
      const newRot = (v.rotationDeg + 90) % 360;
      const staged = imageToStage(imgPt, { pos: { x: 0, y: 0 }, scale: v.scale, rotationDeg: newRot }, imgWidth, imgHeight);
      return { ...v, rotationDeg: newRot, pos: { x: stageCenter.x - staged.x, y: stageCenter.y - staged.y } };
    });
  }, [imgWidth, imgHeight, stageWidth, stageHeight]);

  const handlePointerDown = useCallback(
    (e) => {
      const stage = e.target.getStage();
      const evt = e.evt;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const isSpacePan = spaceDownRef.current || activeTool === 'Pan';
      if (isSpacePan) {
        isPanningRef.current = true;
        panLastRef.current = { x: pointer.x, y: pointer.y };
        pointerIdRef.current = evt.pointerId ?? null;
        return;
      }
      const pt = getImagePointFromStage(pointer.x, pointer.y);
      if (activeTool === 'Length') {
        setDrawing({ type: 'length', points: [pt.x, pt.y, pt.x, pt.y] });
      } else if (activeTool === 'Angle') {
        if (angleStep === 0) {
          setDrawing({ type: 'angle', points: [pt.x, pt.y] });
          setAngleStep(1);
        } else if (angleStep === 1) {
          setDrawing((d) => (d ? { ...d, points: [...d.points, pt.x, pt.y] } : null));
          setAngleStep(2);
        } else {
          setDrawing((d) => {
            if (!d || d.points.length < 4) return d;
            const next = [...d.points, pt.x, pt.y];
            setAnnotations((a) => [...a, { type: 'angle', points: next }]);
            setAngleStep(0);
            return null;
          });
        }
      } else if (activeTool === 'RectangleRoi') {
        setDrawing({ type: 'RectangleRoi', x: pt.x, y: pt.y, width: 0, height: 0 });
      }
    },
    [activeTool, angleStep, getImagePointFromStage]
  );

  const handlePointerMove = useCallback(
    (e) => {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      if (isPanningRef.current) {
        const last = panLastRef.current;
        if (last) {
          const dx = pointer.x - last.x;
          const dy = pointer.y - last.y;
          panLastRef.current = { x: pointer.x, y: pointer.y };
          setView((v) => ({ ...v, pos: { x: v.pos.x + dx, y: v.pos.y + dy } }));
        }
        return;
      }
      if (!drawing) return;
      const pt = getImagePointFromStage(pointer.x, pointer.y);
      if (drawing.type === 'length' && drawing.points.length >= 4) {
        setDrawing((d) => ({ ...d, points: [d.points[0], d.points[1], pt.x, pt.y] }));
      } else if (drawing.type === 'RectangleRoi') {
        setDrawing((d) => ({ ...d, width: pt.x - d.x, height: pt.y - d.y }));
      }
    },
    [drawing, getImagePointFromStage]
  );

  const handlePointerUp = useCallback(
    (e) => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        panLastRef.current = null;
        pointerIdRef.current = null;
        return;
      }
      if (drawing?.type === 'length') {
        setAnnotations((a) => [...a, { type: 'length', points: [...drawing.points] }]);
        setDrawing(null);
      } else if (drawing?.type === 'RectangleRoi') {
        const { x, y, width, height } = drawing;
        const nx = width < 0 ? x + width : x;
        const ny = height < 0 ? y + height : y;
        const w = Math.abs(width);
        const h = Math.abs(height);
        if (w > 2 && h > 2) setCropRect({ x: nx, y: ny, width: w, height: h });
        setDrawing(null);
      }
    },
    [drawing]
  );

  const applyTool = useCallback(
    (toolName) => {
      if (toolName === 'Fit') {
        fitView();
        return;
      }
      if (toolName === 'Reset') {
        setAnnotations([]);
        setDrawing(null);
        setAngleStep(0);
        setCropRect(null);
        setView((v) => ({ ...v, rotationDeg: 0 }));
        setActiveTool('Length');
        setPixelsPerMmInput(initialPixelsPerMm);
        if (imgWidth && imgHeight && stageWidth && stageHeight) {
          const { width: w, height: h } = fitStageSizeRef.current;
          const sw = w > 0 ? w : stageWidth;
          const sh = h > 0 ? h : stageHeight;
          const scale = Math.min(sw / imgWidth, sh / imgHeight);
          setView({ pos: { x: sw / 2, y: sh / 2 }, scale, rotationDeg: 0 });
        }
        return;
      }
      if (toolName === 'Rotate') {
        handleRotate();
        return;
      }
      setActiveTool(toolName);
    },
    [fitView, handleRotate, initialPixelsPerMm, imgWidth, imgHeight, stageWidth, stageHeight]
  );

  const handleToolClick = useCallback((toolName) => applyTool(toolName), [applyTool]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === ' ') {
        spaceDownRef.current = true;
        return;
      }
      if (e.key === 'Escape') {
        setDrawing(null);
        setAngleStep(0);
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        fitView();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key?.toLowerCase();
      const toolName = SHORTCUT_TO_TOOL[key];
      if (toolName) {
        e.preventDefault();
        applyTool(toolName);
      }
    };
    const onKeyUp = (e) => {
      if (e.key === ' ') spaceDownRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [applyTool, fitView]);

  const handlePixelsPerMmChange = (e) => {
    setPixelsPerMmInput(e.target.value);
  };

  if (error || imageStatus === 'failed') {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-border bg-muted/30 text-destructive text-sm">
        {error || 'Failed to load image'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/30 px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground whitespace-nowrap">px/mm</span>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={pixelsPerMmInput}
            onChange={handlePixelsPerMmChange}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v <= 0) setPixelsPerMmInput(defaultPixelsPerMm);
            }}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-sm"
            aria-label="Pixels per millimetre"
          />
        </label>
        {TOOLS.map(({ name, label, Icon, shortcut }) => (
          <button
            key={name}
            type="button"
            onClick={() => handleToolClick(name)}
            title={`${label} (${shortcut})`}
            className={
              activeTool === name && name !== 'Fit'
                ? 'flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground'
                : 'flex items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted'
            }
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span>{label}</span>
            <kbd className="ml-0.5 rounded border border-current/30 bg-black/10 px-1 font-mono text-[10px] opacity-80">
              {shortcut}
            </kbd>
          </button>
        ))}
      </div>
      <div
        id={VIEWER_ID}
        ref={containerRef}
        className="min-h-[400px] w-full rounded border border-border bg-black"
        style={{ width: '100%', height: '70vh', minHeight: 400 }}
      >
        {stageWidth > 0 && stageHeight > 0 && (
          <Stage
            width={stageWidth}
            height={stageHeight}
            onWheel={handleStageWheel}
            onMouseDown={handlePointerDown}
            onMouseMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onMouseLeave={handlePointerUp}
          >
            <Layer>
              <Group
                ref={groupRef}
                x={view.pos.x}
                y={view.pos.y}
                scaleX={view.scale}
                scaleY={view.scale}
                rotation={view.rotationDeg}
                offsetX={imgWidth / 2}
                offsetY={imgHeight / 2}
                draggable={false}
                clipFunc={cropRect ? (ctx) => { ctx.beginPath(); ctx.rect(cropRect.x, cropRect.y, cropRect.width, cropRect.height); } : undefined}
              >
                {image && (
                  <Image
                    ref={imageRef}
                    image={image}
                    width={imgWidth}
                    height={imgHeight}
                    listening={false}
                  />
                )}
                {annotations.map((ann, i) => {
                  if (ann.type === 'length' && ann.points?.length >= 4) {
                    const px = lengthPx(ann.points);
                    const mm = px * mmPerPixel;
                    const midX = (ann.points[0] + ann.points[2]) / 2;
                    const midY = (ann.points[1] + ann.points[3]) / 2;
                    return (
                      <Group key={`len-${i}`}>
                        <Line points={ann.points} stroke="lime" strokeWidth={2} lineCap="round" listening={false} />
                        <Text
                          x={midX - 30}
                          y={midY - 10}
                          text={`${px.toFixed(1)} px · ${mm.toFixed(2)} mm`}
                          fontSize={14}
                          fill="lime"
                          listening={false}
                        />
                      </Group>
                    );
                  }
                  if (ann.type === 'angle' && ann.points?.length >= 6) {
                    const deg = angleDeg(ann.points);
                    const [x1, y1, x2, y2, x3, y3] = ann.points;
                    const midX = (x1 + x2 + x3) / 3;
                    const midY = (y1 + y2 + y3) / 3;
                    return (
                      <Group key={`ang-${i}`}>
                        <Line points={[x1, y1, x2, y2]} stroke="cyan" strokeWidth={2} listening={false} />
                        <Line points={[x2, y2, x3, y3]} stroke="cyan" strokeWidth={2} listening={false} />
                        <Text
                          x={midX - 20}
                          y={midY - 8}
                          text={`${deg.toFixed(1)}°`}
                          fontSize={14}
                          fill="cyan"
                          listening={false}
                        />
                      </Group>
                    );
                  }
                  return null;
                })}
                {drawing?.type === 'length' && drawing.points?.length >= 4 && (
                  <Line points={drawing.points} stroke="lime" strokeWidth={2} lineCap="round" listening={false} />
                )}
                {drawing?.type === 'angle' && drawing.points?.length >= 2 && (
                  <Line points={drawing.points} stroke="cyan" strokeWidth={2} listening={false} />
                )}
                {drawing?.type === 'RectangleRoi' && (
                  <Rect
                    x={drawing.x}
                    y={drawing.y}
                    width={drawing.width}
                    height={drawing.height}
                    stroke="cyan"
                    strokeWidth={2}
                    dash={[6, 4]}
                    listening={false}
                  />
                )}
              </Group>
            </Layer>
          </Stage>
        )}
      </div>
    </div>
  );
}
