import { useEffect, useRef, useState } from 'react';
import { Ruler, CornerDownRight, Hand, ZoomIn, Contrast, Crop, RotateCw, Eraser } from 'lucide-react';
import {
  registerCornerstoneWebLoader,
  initCornerstoneTools,
  cornerstone,
  cornerstoneTools,
} from '@/lib/cornerstoneSetup';

const VIEWER_ID = 'cornerstone-testcuts-viewer';

// Shortcuts: left-hand only (Q W E R, A S D F, Z X C V) so user can press without moving hand from mouse.
const TOOLS = [
  { name: 'Length', label: 'Length', Icon: Ruler, shortcut: 'Q' },
  { name: 'Angle', label: 'Angle', Icon: CornerDownRight, shortcut: 'E' },
  { name: 'Pan', label: 'Pan', Icon: Hand, shortcut: 'A' },
  { name: 'Zoom', label: 'Zoom', Icon: ZoomIn, shortcut: 'Z' },
  { name: 'Wwwc', label: 'Window/Level', Icon: Contrast, shortcut: 'W' },
  { name: 'RectangleRoi', label: 'Crop', Icon: Crop, shortcut: 'C' },
  { name: 'Rotate', label: 'Rotate', Icon: RotateCw, shortcut: 'R' },
  { name: 'Clear', label: 'Clear', Icon: Eraser, shortcut: 'X' },
];

const SHORTCUT_TO_TOOL = Object.fromEntries(TOOLS.map((t) => [t.shortcut.toLowerCase(), t.name]));

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const updateSize = () => {
      if (element.offsetWidth > 0 && element.offsetHeight > 0) {
        setSize({ width: element.offsetWidth, height: element.offsetHeight });
      }
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(element);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}

const ANNOTATION_TOOL_NAMES = ['Length', 'Angle', 'RectangleRoi'];

function addToolsForElement(element) {
  const {
    LengthTool,
    AngleTool,
    PanTool,
    ZoomTool,
    ZoomMouseWheelTool,
    WwwcTool,
    RectangleRoiTool,
    RotateTool,
    addToolForElement,
    setToolPassiveForElement,
  } = cornerstoneTools;
  [LengthTool, AngleTool, PanTool, ZoomTool, ZoomMouseWheelTool, WwwcTool, RectangleRoiTool, RotateTool].forEach((Tool) => {
    addToolForElement(element, Tool);
  });
  // Scroll to zoom (always on, no need to select Zoom tool)
  setToolPassiveForElement(element, 'ZoomMouseWheel');
}

/**
 * Resolve pixel spacing in mm per pixel for Cornerstone.
 * - pixelSpacing: mm per pixel (direct).
 * - pixelsPerMm: pixels per mm; converted to mm per pixel as 1/pixelsPerMm.
 * If both are set, pixelsPerMm wins. Default when neither set: 50 px/mm.
 */
function getMmPerPixel({ pixelSpacing, pixelsPerMm }) {
  if (pixelsPerMm != null && Number.isFinite(pixelsPerMm) && pixelsPerMm > 0) {
    return 1 / pixelsPerMm;
  }
  if (pixelSpacing != null && Number.isFinite(pixelSpacing) && pixelSpacing > 0) {
    return pixelSpacing;
  }
  return 1 / 50; // default 50 px/mm
}

const defaultPixelsPerMm = 50;

export default function CornerstoneViewer({ imageUrl, pixelSpacing, pixelsPerMm }) {
  const elRef = useRef(null);
  const [error, setError] = useState(null);
  const [activeTool, setActiveTool] = useState('Length');
  const size = useElementSize(elRef);
  const initialMmPerPixel = getMmPerPixel({ pixelSpacing, pixelsPerMm });
  const initialPixelsPerMm = 1 / initialMmPerPixel;
  const [pixelsPerMmInput, setPixelsPerMmInput] = useState(initialPixelsPerMm);
  const mmPerPixel = 1 / (Number(pixelsPerMmInput) || defaultPixelsPerMm);

  useEffect(() => {
    const element = elRef.current;
    if (!element || !imageUrl || size.width === 0 || size.height === 0) return;

    registerCornerstoneWebLoader();
    initCornerstoneTools();

    let cancelled = false;

    try {
      cornerstone.enable(element);
      addToolsForElement(element);
      cornerstoneTools.setToolActiveForElement(element, 'Length', { mouseButtonMask: 1 });

      cornerstone
        .loadImage(imageUrl)
        .then((image) => {
          if (cancelled) return;
          if (image.columnPixelSpacing === undefined || image.rowPixelSpacing === undefined) {
            image.columnPixelSpacing = mmPerPixel;
            image.rowPixelSpacing = mmPerPixel;
          }
          cornerstone.displayImage(element, image);
          cornerstone.fitToWindow(element);
          cornerstone.draw(element);
          cornerstone.resize(element);
          requestAnimationFrame(() => {
            if (!cancelled) {
              try {
                cornerstone.draw(element);
                cornerstone.resize(element);
              } catch (_) {}
            }
          });
        })
        .catch((e) => {
          if (!cancelled) setError(e?.message || String(e));
        });
    } catch (e) {
      setError(e?.message || String(e));
    }

    return () => {
      cancelled = true;
      try {
        cornerstone.disable(element);
      } catch (_) {}
    };
  }, [imageUrl, mmPerPixel, size.width, size.height]);

  // Sync local input when props change (e.g. new image with different calibration)
  useEffect(() => {
    setPixelsPerMmInput(initialPixelsPerMm);
  }, [imageUrl, initialPixelsPerMm]);

  const handlePixelsPerMmChange = (e) => {
    const raw = e.target.value;
    setPixelsPerMmInput(raw);
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0) return;
    const element = elRef.current;
    if (!element) return;
    try {
      const enabledElement = cornerstone.getEnabledElement(element);
      if (enabledElement?.image) {
        const mmPerPx = 1 / val;
        enabledElement.image.columnPixelSpacing = mmPerPx;
        enabledElement.image.rowPixelSpacing = mmPerPx;
        cornerstone.draw(element);
      }
    } catch (_) {}
  };

  const applyTool = (toolName) => {
    const element = elRef.current;
    if (!element) return;
    if (toolName === 'Clear') {
      ANNOTATION_TOOL_NAMES.forEach((name) => {
        try {
          cornerstoneTools.clearToolState(element, name);
        } catch (_) {}
      });
      cornerstone.draw(element);
      return;
    }
    setActiveTool(toolName);
    cornerstoneTools.setToolActiveForElement(element, toolName, { mouseButtonMask: 1 });
    cornerstone.draw(element);
  };

  const handleToolClick = (toolName) => applyTool(toolName);

  useEffect(() => {
    const onKeyDown = (e) => {
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
  }, []);

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded border border-border bg-muted/30 text-destructive text-sm">
        {error}
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
        ref={elRef}
        className="min-h-[400px] w-full rounded border border-border bg-black"
        style={{ width: '100%', height: '70vh', minHeight: 400 }}
      />
    </div>
  );
}
