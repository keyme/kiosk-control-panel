import { Link, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CALIBRATION_REPORT_SECTIONS, formatSectionLabel } from '@/pages/calibrationReportSections';

export default function CalibrationReport() {
  const { kiosk } = useParams();
  const base = kiosk ? `/${kiosk}` : '';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Calibration Report</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {CALIBRATION_REPORT_SECTIONS.map((sectionId) => (
            <li key={sectionId}>
              <Link
                to={base ? `${base}/calibration/report/${sectionId}` : `/calibration/report/${sectionId}`}
                className="flex items-center rounded-md border border-border bg-muted/30 px-4 py-3 text-sm font-medium hover:bg-muted/50"
              >
                {formatSectionLabel(sectionId)}
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
