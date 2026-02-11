import { useParams, useSearchParams, Navigate, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { apiUrl } from '@/lib/apiUrl';
import { formatSectionLabel } from '@/pages/calibrationReportSections';
import { Loader2 } from 'lucide-react';

export default function CalibrationLatestRedirect({ sectionId, kioskName: kioskNameProp }) {
  const { kiosk } = useParams();
  const [searchParams] = useSearchParams();
  const kioskName = searchParams.get('kiosk_name') || kioskNameProp || kiosk;
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const basePath = kioskName ? `/${kioskName}/calibration/report` : '/calibration/report';
  const sectionPath = `${basePath}/${sectionId}`;

  useEffect(() => {
    if (!kioskName) {
      setLoading(false);
      setError('Kiosk name not available');
      return;
    }
    setLoading(true);
    setError(null);
    const base = kioskName ? `/${kioskName}/calibration/report` : '/calibration/report';
    const section = `${base}/${sectionId}`;

    let url;
    let getFirst;
    if (sectionId === 'testcuts') {
      url = apiUrl(`/api/calibration/testcuts/ids?kiosk=${encodeURIComponent(kioskName)}`);
      getFirst = (data) => (Array.isArray(data) && data.length > 0 ? String(data[0]) : null);
    } else if (sectionId === 'bitting_calibration') {
      url = apiUrl(`/api/calibration/bitting_calibration/dates?kiosk=${encodeURIComponent(kioskName)}`);
      getFirst = (data) => (Array.isArray(data) && data.length > 0 ? data[0] : null);
    } else {
      url = apiUrl(`/api/calibration/${sectionId}/runs?kiosk=${encodeURIComponent(kioskName)}`);
      getFirst = (data) => {
        if (!Array.isArray(data) || data.length === 0) return null;
        const first = data[0];
        return typeof first === 'string' ? first : first?.run_id ?? null;
      };
    }

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Failed to load');
        return res.json();
      })
      .then((data) => {
        const first = getFirst(data);
        if (first) setTarget(`${section}/${encodeURIComponent(first)}`);
        else setTarget(section);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName, sectionId]);

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available.</p>
          <Link to={sectionPath} className="text-primary mt-2 inline-block text-sm underline">
            Back to {formatSectionLabel(sectionId)}
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
          <Link to={sectionPath} className="text-primary mt-2 inline-block text-sm underline">
            Back to {formatSectionLabel(sectionId)}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return <Navigate to={target} replace />;
}
