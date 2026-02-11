import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageTitle } from '@/components/PageTitle';
import { Camera, Loader2 } from 'lucide-react';
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

export default function CameraImagesPage({ socket }) {
  const [loadingCamera, setLoadingCamera] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const takeImage = useCallback(
    (camera) => {
      if (!socket?.connected || loadingCamera) return;
      setLoadingCamera(camera);
      setResult(null);
      setError(null);
      socket.emit('take_image', { camera }, (res) => {
        setLoadingCamera(null);
        if (res && typeof res === 'object') {
          if (res.error) {
            setError(res.error);
            setResult(null);
          } else if (res.imageBase64) {
            setResult({ camera: res.camera, imageBase64: res.imageBase64 });
            setError(null);
          }
        } else {
          setError('No response from device');
        }
      });
    },
    [socket, loadingCamera]
  );

  const dataUrl = result?.imageBase64
    ? `data:image/jpeg;base64,${result.imageBase64}`
    : null;

  return (
    <div className="space-y-6">
      <PageTitle icon={Camera}>Camera images</PageTitle>

      <p className="text-sm text-muted-foreground">
        Take a snapshot from any camera or the screen. Select a source and click Take image.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAMERAS.map((camera) => (
          <Card key={camera}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {CAMERA_LABELS[camera] ?? camera}
              </CardTitle>
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

      {dataUrl && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {result.camera ? CAMERA_LABELS[result.camera] ?? result.camera : 'Image'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <img
              src={dataUrl}
              alt={result.camera ? `From ${CAMERA_LABELS[result.camera] ?? result.camera}` : 'Camera capture'}
              className="max-h-[70vh] w-auto max-w-full rounded-md border border-border object-contain"
            />
          </CardContent>
        </Card>
      )}

      {!socket?.connected && (
        <p className="text-sm text-muted-foreground">
          Connect to a device (use the host in the title bar) to take images.
        </p>
      )}
    </div>
  );
}
