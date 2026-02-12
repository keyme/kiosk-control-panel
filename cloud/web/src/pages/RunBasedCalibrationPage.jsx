import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/apiFetch';
import { formatSectionLabel, formatRunSpan } from '@/pages/calibrationReportSections';

export default function RunBasedCalibrationPage({ sectionId, kioskName }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const title = formatSectionLabel(sectionId);

  useEffect(() => {
    if (!kioskName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch(
      `/api/calibration/${sectionId}/runs?kiosk=${encodeURIComponent(kioskName)}`
    )
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Failed to load runs');
        return res.json();
      })
      .then((data) =>
        setRuns(
          Array.isArray(data)
            ? data.map((r) =>
                typeof r === 'string'
                  ? { run_id: r, start_ts: r, end_ts: r }
                  : { run_id: r.run_id, start_ts: r.start_ts ?? r.run_id, end_ts: r.end_ts ?? r.run_id }
              )
            : []
        )
      )
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName, sectionId]);

  const filteredRuns = search.trim()
    ? runs.filter((r) =>
        [r.run_id, r.start_ts, r.end_ts].some((v) =>
          String(v || '').toLowerCase().includes(search.trim().toLowerCase())
        )
      )
    : runs;

  if (!kioskName) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-muted-foreground text-sm">Kiosk name not available.</p>
        </CardContent>
      </Card>
    );
  }

  const latestPath = kioskName
    ? `/${kioskName}/calibration/report/${sectionId}/latest`
    : `/calibration/report/${sectionId}/latest`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <button
          type="button"
          onClick={() => navigate(latestPath)}
          className="text-primary mt-1 text-sm font-medium underline hover:no-underline"
        >
          Open latest
        </button>
      </CardHeader>
      <CardContent className="space-y-4">
        <input
          type="text"
          placeholder="Search runs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-2 text-sm"
        />
        {loading && <p className="text-muted-foreground text-sm">Loading runs…</p>}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!loading && !error && filteredRuns.length === 0 && (
          <p className="text-muted-foreground text-sm">No runs found.</p>
        )}
        {!loading && !error && filteredRuns.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {filteredRuns.map((run) => (
              <li key={run.run_id}>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      kioskName
                        ? `/${kioskName}/calibration/report/${sectionId}/${encodeURIComponent(run.run_id)}`
                        : `/calibration/report/${sectionId}/${encodeURIComponent(run.run_id)}`
                    )
                  }
                  className="rounded border border-border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/60"
                >
                  {formatRunSpan(run.start_ts, run.end_ts)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
