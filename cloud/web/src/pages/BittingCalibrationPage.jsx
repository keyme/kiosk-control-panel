import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/apiFetch';

function formatDateDisplay(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
}

export default function BittingCalibrationPage({ kioskName }) {
  const navigate = useNavigate();
  const [dates, setDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!kioskName) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch(`/api/calibration/bitting_calibration/dates?kiosk=${encodeURIComponent(kioskName)}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Failed to load dates');
        return res.json();
      })
      .then(setDates)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName]);

  const filteredDates = search.trim()
    ? dates.filter((d) => String(d).includes(search.trim()))
    : dates;

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
    ? `/${kioskName}/calibration/report/bitting_calibration/latest`
    : '/calibration/report/bitting_calibration/latest';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bitting Calibration</CardTitle>
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
          placeholder="Search dates..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-2 text-sm"
        />
        {loading && <p className="text-muted-foreground text-sm">Loading dates…</p>}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!loading && !error && filteredDates.length === 0 && (
          <p className="text-muted-foreground text-sm">No bitting calibration dates found.</p>
        )}
        {!loading && !error && filteredDates.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {filteredDates.map((date) => (
              <li key={date}>
                <button
                  type="button"
                  onClick={() =>
                    navigate(
                      kioskName ? `/${kioskName}/calibration/report/bitting_calibration/${date}` : `/calibration/report/bitting_calibration/${date}`
                    )
                  }
                  className="rounded border border-border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/60"
                >
                  {formatDateDisplay(date)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
