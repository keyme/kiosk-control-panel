import { useCallback, useEffect, useRef, useState } from 'react';
import { Ruler, CornerDownRight, Hand, Crop, RotateCw, Eraser } from 'lucide-react';
import { Stage, Layer, Group, Image, Line, Rect, Text } from 'react-konva';
import useImage from 'use-image';

const VIEWER_ID = 'image-measure-viewer';

const TOOLS = [
  { name: 'Length', label: 'Length', Icon: Ruler, shortcut: 'Q' },
  { name: 'Angle', label: 'Angle', Icon: CornerDownRight, shortcut: 'E' },
  { name: 'Pan', label: 'Pan', Icon: Hand, shortcut: 'A' },
  { name: 'RectangleRoi', label: 'Crop', Icon: Crop, shortcut: 'C' },
  { name: 'Rotate', label: 'Rotate', Icon: RotateCw, shortcut: 'R' },
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

  const [groupPos, setGroupPos] = useState({ x: 0, y: 0 });
  const [groupScale, setGroupScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [annotations, setAnnotations] = useState([]);
  const [drawing, setDrawing] = useState(null);
  const [angleStep, setAngleStep] = useState(0);
  const [cropRect, setCropRect] = useState(null);

  const stageWidth = size.width;
  const stageHeight = size.height;
  const imgWidth = image?.width ?? 0;
  const imgHeight = image?.height ?? 0;

  useEffect(() => {
    if (imageStatus === 'failed') setError('Failed to load image');
    else if (imageStatus === 'loaded') setError(null);
  }, [imageStatus]);

  // Fit to window only when image first loads (or imageUrl changes). Store dimensions used
  // so Reset can reuse them and avoid drift from ResizeObserver firing with different values.
  const fittedForImageRef = useRef(null);
  const fitStageSizeRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    if (!imgWidth || !imgHeight || !stageWidth || !stageHeight) return;
    if (fittedForImageRef.current === imageUrl) return;
    fittedForImageRef.current = imageUrl;
    fitStageSizeRef.current = { width: stageWidth, height: stageHeight };
    setCropRect(null);
    const scale = Math.min(stageWidth / imgWidth, stageHeight / imgHeight);
    setGroupPos({ x: stageWidth / 2, y: stageHeight / 2 });
    setGroupScale(scale);
  }, [imageUrl, imgWidth, imgHeight, stageWidth, stageHeight]);

  useEffect(() => {
    setPixelsPerMmInput(initialPixelsPerMm);
  }, [imageUrl, initialPixelsPerMm]);

  function getImagePoint() {
    if (!groupRef.current) return null;
    const stage = groupRef.current.getStage();
    if (!stage) return null;
    const pointer = stage.getPointerPosition();
    if (!pointer) return null;
    const transform = groupRef.current.getAbsoluteTransform().copy();
    transform.invert();
    return transform.point(pointer);
  }

  const handleStageWheel = useCallback(
    (e) => {
      e.evt.preventDefault();
      const stage = e.target.getStage();
      const oldScale = groupScale;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const scaleBy = 1.1;
      const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
      const clamped = Math.max(0.1, Math.min(20, newScale));
      const mousePointTo = {
        x: (pointer.x - groupPos.x) / oldScale,
        y: (pointer.y - groupPos.y) / oldScale,
      };
      const newPos = {
        x: pointer.x - mousePointTo.x * clamped,
        y: pointer.y - mousePointTo.y * clamped,
      };
      setGroupScale(clamped);
      setGroupPos(newPos);
    },
    [groupScale, groupPos]
  );

  const handleStageMouseDown = useCallback(
    (e) => {
      if (e.target !== e.target.getStage()) return;
      const pt = getImagePoint();
      if (!pt) return;

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
    [activeTool, angleStep]
  );

  const handleStageMouseMove = useCallback(
    (e) => {
      if (!drawing) return;
      const pt = getImagePoint();
      if (!pt) return;

      if (drawing.type === 'length' && drawing.points.length >= 4) {
        setDrawing((d) => ({ ...d, points: [d.points[0], d.points[1], pt.x, pt.y] }));
      } else if (drawing.type === 'RectangleRoi') {
        setDrawing((d) => ({
          ...d,
          width: pt.x - d.x,
          height: pt.y - d.y,
        }));
      }
    },
    [drawing]
  );

  const handleStageMouseUp = useCallback(
    (e) => {
      if (e.target !== e.target.getStage()) return;
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

  const handleRotate = useCallback(() => {
    setRotation((r) => (r + 90) % 360);
  }, []);

  const applyTool = useCallback(
    (toolName) => {
      if (toolName === 'Reset') {
        setAnnotations([]);
        setDrawing(null);
        setAngleStep(0);
        setCropRect(null);
        setRotation(0);
        setActiveTool('Length');
        setPixelsPerMmInput(initialPixelsPerMm);
        if (imgWidth && imgHeight) {
          const { width: w, height: h } = fitStageSizeRef.current;
          const sw = w > 0 ? w : stageWidth;
          const sh = h > 0 ? h : stageHeight;
          if (sw > 0 && sh > 0) {
            const scale = Math.min(sw / imgWidth, sh / imgHeight);
            setGroupPos({ x: sw / 2, y: sh / 2 });
            setGroupScale(scale);
          }
        }
        return;
      }
      if (toolName === 'Rotate') {
        handleRotate();
        return;
      }
      setActiveTool(toolName);
    },
    [handleRotate, initialPixelsPerMm, imgWidth, imgHeight, stageWidth, stageHeight]
  );

  const handleToolClick = useCallback(
    (toolName) => {
      applyTool(toolName);
    },
    [applyTool]
  );

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setDrawing(null);
        setAngleStep(0);
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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [applyTool]);

  const handlePixelsPerMmChange = (e) => {
    setPixelsPerMmInput(e.target.value);
  };

  const isPan = activeTool === 'Pan';
  const groupDraggable = isPan && stageWidth > 0 && stageHeight > 0;
  const dragBoundFunc = useCallback(
    (pos) => {
      if (!imgWidth || !imgHeight) return pos;
      // Account for rotation: at 90°/270° visual width/height swap
      const isRotated90 = rotation % 180 !== 0;
      const visW = isRotated90 ? imgHeight : imgWidth;
      const visH = isRotated90 ? imgWidth : imgHeight;
      const halfW = (visW * groupScale) / 2;
      const halfH = (visH * groupScale) / 2;
      // Use min/max so bounds work when image is both smaller AND larger than stage
      const minX = Math.min(halfW, stageWidth - halfW);
      const maxX = Math.max(halfW, stageWidth - halfW);
      const minY = Math.min(halfH, stageHeight - halfH);
      const maxY = Math.max(halfH, stageHeight - halfH);
      return {
        x: Math.max(minX, Math.min(maxX, pos.x)),
        y: Math.max(minY, Math.min(maxY, pos.y)),
      };
    },
    [stageWidth, stageHeight, imgWidth, imgHeight, groupScale, rotation]
  );

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
              activeTool === name
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
            onMouseDown={handleStageMouseDown}
            onMouseMove={handleStageMouseMove}
            onMouseUp={handleStageMouseUp}
            onMouseLeave={handleStageMouseUp}
          >
            <Layer>
              <Group
                ref={groupRef}
                x={groupPos.x}
                y={groupPos.y}
                scaleX={groupScale}
                scaleY={groupScale}
                rotation={rotation}
                offsetX={imgWidth / 2}
                offsetY={imgHeight / 2}
                draggable={groupDraggable}
                onDragMove={(e) => setGroupPos({ x: e.target.x(), y: e.target.y() })}
                onDragEnd={(e) => setGroupPos({ x: e.target.x(), y: e.target.y() })}
                dragBoundFunc={dragBoundFunc}
                clipFunc={cropRect ? (ctx) => { ctx.beginPath(); ctx.rect(cropRect.x, cropRect.y, cropRect.width, cropRect.height); } : undefined}
              >
                {image && (
                  <Image
                    ref={imageRef}
                    image={image}
                    width={imgWidth}
                    height={imgHeight}
                    listening={activeTool === 'Pan'}
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
