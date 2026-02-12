import { useParams, useSearchParams, Navigate, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/apiFetch';
import { Loader2 } from 'lucide-react';

export default function CalibrationTracingLatestRedirect({ kioskName: kioskNameProp }) {
  const { kiosk } = useParams();
  const [searchParams] = useSearchParams();
  const kioskName = searchParams.get('kiosk_name') || kioskNameProp || kiosk;
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const tracingPath = kioskName ? `/${kioskName}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam';

  useEffect(() => {
    if (!kioskName) {
      setLoading(false);
      setError('Kiosk name not available');
      return;
    }
    setLoading(true);
    setError(null);

    const url = `/api/calibration/trace/gripper_cam/runs?kiosk=${encodeURIComponent(kioskName)}`;
    const base = kioskName ? `/${kioskName}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam';
    apiFetch(url)
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        const runs = Array.isArray(data) ? data : [];
        const first = runs.length > 0 ? (runs[0]?.run_id ?? runs[0]) : null;
        if (first) setTarget(`${base}/${encodeURIComponent(first)}`);
        else setTarget(base);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName]);

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available.</p>
          <Link to={tracingPath} className="text-primary mt-2 inline-block text-sm underline">
            Back to Gripper Cam Calibration
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-6">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground text-sm">Resolving latest…</span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-destructive text-sm">{error}</p>
          <Link to={tracingPath} className="text-primary mt-2 inline-block text-sm underline">
            Back to Gripper Cam Calibration
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <Navigate to={target} replace />;
}
