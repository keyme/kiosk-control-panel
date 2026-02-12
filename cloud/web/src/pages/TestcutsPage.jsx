import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/apiFetch';

export default function TestcutsPage({ kioskName }) {
  const navigate = useNavigate();
  const [ids, setIds] = useState([]);
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
    apiFetch(`/api/calibration/testcuts/ids?kiosk=${encodeURIComponent(kioskName)}`)
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || 'Failed to load IDs');
        return res.json();
      })
      .then(setIds)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kioskName]);

  const filteredIds = search.trim()
    ? ids.filter((id) => String(id).includes(search.trim()))
    : ids;

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
    ? `/${kioskName}/calibration/report/testcuts/latest`
    : '/calibration/report/testcuts/latest';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Testcuts</CardTitle>
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
          placeholder="Search IDs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded border border-border bg-background px-3 py-2 text-sm"
        />
        {loading && <p className="text-muted-foreground text-sm">Loading IDs…</p>}
        {error && <p className="text-destructive text-sm">{error}</p>}
        {!loading && !error && filteredIds.length === 0 && (
          <p className="text-muted-foreground text-sm">No testcut IDs found.</p>
        )}
        {!loading && !error && filteredIds.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {filteredIds.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => navigate(kioskName ? `/${kioskName}/calibration/report/testcuts/${id}` : `/calibration/report/testcuts/${id}`)}
                  className="rounded border border-border bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/60"
                >
                  {id}
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
