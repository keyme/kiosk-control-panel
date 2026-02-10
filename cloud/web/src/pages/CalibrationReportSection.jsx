import { useParams, Navigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CALIBRATION_REPORT_SECTIONS, formatSectionLabel } from '@/pages/calibrationReportSections';
import TestcutsPage from '@/pages/TestcutsPage';
import BittingCalibrationPage from '@/pages/BittingCalibrationPage';
import RunBasedCalibrationPage from '@/pages/RunBasedCalibrationPage';

export default function CalibrationReportSection({ kioskName }) {
  const { sectionId, kiosk } = useParams();
  const isValid = sectionId && CALIBRATION_REPORT_SECTIONS.includes(sectionId);
  const reportPath = kiosk ? `/${kiosk}/calibration/report` : '/calibration/report';

  if (!isValid) {
    return <Navigate to={reportPath} replace />;
  }

  if (sectionId === 'testcuts') {
    return <TestcutsPage kioskName={kioskName} />;
  }

  if (sectionId === 'bitting_calibration') {
    return <BittingCalibrationPage kioskName={kioskName} />;
  }

  if (
    sectionId === 'bump_tower_calibration' ||
    sectionId === 'grip_calibration' ||
    sectionId === 'gripper_cam_calibration' ||
    sectionId === 'gripper_leds_check' ||
    sectionId === 'overhead_cam_calibration' ||
    sectionId === 'pickup_y_calibration'
  ) {
    return <RunBasedCalibrationPage sectionId={sectionId} kioskName={kioskName} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{formatSectionLabel(sectionId)}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">Content for this calibration report section will appear here.</p>
      </CardContent>
    </Card>
  );
}
