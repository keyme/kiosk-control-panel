import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Camera, Loader2, Download, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const CAMERAS = [
  'bitting_video_left',
  'bitting_video_right',
  'gripper_camera',
  'milling_video',
  'overhead_camera',
  'security_camera',
  'screenshot',
  'inventory_camera',
  'bitting_video_left_roi_box',
  'bitting_video_right_roi_box',
];

const CAMERA_LABELS = {
  bitting_video_left: 'Bitting video left',
  bitting_video_right: 'Bitting video right',
  gripper_camera: 'Gripper camera',
  milling_video: 'Milling video',
  overhead_camera: 'Overhead camera',
  security_camera: 'Security camera',
  screenshot: 'Screenshot',
  inventory_camera: 'Inventory camera',
  bitting_video_left_roi_box: 'Bitting video left (ROI)',
  bitting_video_right_roi_box: 'Bitting video right (ROI)',
};

const CAMERA_DESCRIPTIONS = {
  bitting_video_left:
    'Left key scanner camera in the camera box. Used to capture and read key bitting.',
  bitting_video_right:
    'Right key scanner camera in the camera box. Used to capture and read key bitting.',
  gripper_camera:
    'Camera on the gripper assembly. Views and analyzes the key during pickup, milling, and drop-off.',
  milling_video:
    'Camera that has a view of the milling area. Used to identify the keyway during scanning.',
  overhead_camera:
    'Overhead camera above the work area. Provides a top-down view of the kiosk.',
  security_camera:
    'Security or wide-angle camera. Fisheyed view of outside of the kiosk.',
  screenshot:
    'Screen capture of the kiosk display (DISPLAY=:0). Shows what is on the main screen.',
  inventory_camera:
    'Camera that views the key inventory or magazine area.',
  bitting_video_left_roi_box:
    'Left key scanner with the ROI (region of interest) crop box drawn on the image. This is what kiosk actually sees when it scans the key.',
  bitting_video_right_roi_box:
    'Right key scanner with the ROI crop box drawn on the image. This is what kiosk actually sees when it scans the key.',
};

const SCALE_OPTIONS = [
  { value: 0.25, label: '0.25' },
  { value: 0.5, label: '0.5 (default)' },
  { value: 0.75, label: '0.75' },
  { value: 1, label: '1.0 (full size)' },
];

function downloadImage(result, labels) {
  const name = result.camera ? (labels[result.camera] ?? result.camera) : 'image';
  const safeName = name.replace(/[^a-z0-9-_]/gi, '_');
  const filename = `${safeName}_${result.id}.jpg`;
  const dataUrl = `data:image/jpeg;base64,${result.imageBase64}`;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

export default function CameraImagesPage({ socket }) {
  const [loadingCamera, setLoadingCamera] = useState(null);
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [scaleFactor, setScaleFactor] = useState(0.5);
  const [fullscreenResultId, setFullscreenResultId] = useState(null);

  const takeImage = useCallback(
    (camera) => {
      if (!socket?.connected || loadingCamera) return;
      setLoadingCamera(camera);
      setError(null);
      socket.request('take_image', { camera, resize_factor: scaleFactor }).then((res) => {
        setLoadingCamera(null);
        const data = res?.success ? res.data : null;
        if (data && typeof data === 'object') {
          if (data.error) {
            setError(data.error);
          } else if (data.imageBase64) {
            setResults((prev) => [
              { camera: data.camera, imageBase64: data.imageBase64, id: Date.now() },
              ...prev,
            ]);
            setError(null);
          }
        } else if (res && !res.success) {
          setError(res.errors?.join(', ') || 'Request failed');
        } else {
          setError('No response from device');
        }
      }).catch(() => setLoadingCamera(null));
    },
    [socket, loadingCamera, scaleFactor]
  );

  const fullscreenResult = fullscreenResultId
    ? results.find((r) => r.id === fullscreenResultId)
    : null;

  return (
    <div className="space-y-6">
      <PageTitle icon={Camera}>Camera images</PageTitle>

      <p className="text-sm text-muted-foreground">
        Take a snapshot from any camera or the screen. Select a source and click Take image.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Scale factor:</span>
          <select
            value={scaleFactor}
            onChange={(e) => setScaleFactor(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            {SCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          Lower values reduce file size and bandwidth (default 0.5).
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAMERAS.map((camera) => (
          <Card key={camera}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {CAMERA_LABELS[camera] ?? camera}
              </CardTitle>
              {CAMERA_DESCRIPTIONS[camera] && (
                <p className="text-xs text-muted-foreground font-normal leading-snug">
                  {CAMERA_DESCRIPTIONS[camera]}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <button
                type="button"
                onClick={() => takeImage(camera)}
                disabled={!socket?.connected || loadingCamera !== null}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'disabled:opacity-50 disabled:pointer-events-none'
                )}
              >
                {loadingCamera === camera ? (
                  <>
                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                    Capturing…
                  </>
                ) : (
                  'Take image'
                )}
              </button>
            </CardContent>
          </Card>
        ))}
      </div>

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {results.length > 0 && (
        <div className="space-y-4">
          {results.map((result) => (
            <Card key={result.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {result.camera ? CAMERA_LABELS[result.camera] ?? result.camera : 'Image'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="relative">
                  <img
                    src={`data:image/jpeg;base64,${result.imageBase64}`}
                    alt={result.camera ? `From ${CAMERA_LABELS[result.camera] ?? result.camera}` : 'Camera capture'}
                    className="max-h-[70vh] w-auto max-w-full rounded-md border border-border object-contain cursor-pointer hover:opacity-95"
                    onClick={() => setFullscreenResultId(result.id)}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setFullscreenResultId(result.id)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      'border border-input bg-background hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <Maximize2 className="size-4 shrink-0" aria-hidden />
                    Fullscreen
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadImage(result, CAMERA_LABELS)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      'border border-input bg-background hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <Download className="size-4 shrink-0" aria-hidden />
                    Download
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!fullscreenResult} onOpenChange={(open) => !open && setFullscreenResultId(null)}>
        <DialogContent className="max-w-[95vw] max-h-[95vh] w-auto p-2 overflow-auto flex flex-col items-center">
          <DialogTitle className="sr-only">
            {fullscreenResult?.camera
              ? CAMERA_LABELS[fullscreenResult.camera] ?? fullscreenResult.camera
              : 'Image'}
          </DialogTitle>
          {fullscreenResult && (
            <img
              src={`data:image/jpeg;base64,${fullscreenResult.imageBase64}`}
              alt={fullscreenResult.camera ? `From ${CAMERA_LABELS[fullscreenResult.camera] ?? fullscreenResult.camera}` : 'Camera capture'}
              className="max-h-[90vh] w-auto max-w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>

      {!socket?.connected && (
        <p className="text-sm text-muted-foreground">
          Connect to a device (use the host in the title bar) to take images.
        </p>
      )}
    </div>
  );
}
