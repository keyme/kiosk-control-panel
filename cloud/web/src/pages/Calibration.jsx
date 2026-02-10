import { useLocation, Outlet, Navigate, useParams } from 'react-router-dom';
import { PageTitle } from '@/components/PageTitle';
import { Wrench } from 'lucide-react';
import { CALIBRATION_REPORT_SECTIONS, formatSectionLabel } from '@/pages/calibrationReportSections';

function useCalibrationPageTitle() {
  const { pathname } = useLocation();
  if (pathname.endsWith('/calibration/report') || pathname.endsWith('/calibration')) return 'Calibration Reports';
  if (pathname.endsWith('/calibration/tracing') || pathname.endsWith('/calibration/tracing/gripper-cam')) return pathname.endsWith('gripper-cam') ? 'Gripper Cam Calibration' : 'Calibration Tracing';
  const match = pathname.match(/\/calibration\/report\/([^/]+)$/);
  if (match && CALIBRATION_REPORT_SECTIONS.includes(match[1])) return formatSectionLabel(match[1]);
  return 'Calibration';
}

export default function Calibration() {
  const title = useCalibrationPageTitle();
  return (
    <div className="space-y-6">
      <PageTitle icon={Wrench}>{title}</PageTitle>
      <Outlet />
    </div>
  );
}

export function CalibrationIndexRedirect() {
  const { kiosk } = useParams();
  const base = kiosk ? `/${kiosk}` : '';
  return <Navigate to={base ? `${base}/calibration/report` : '/calibration/report'} replace />;
}

export function CalibrationTracingIndexRedirect() {
  const { kiosk } = useParams();
  const base = kiosk ? `/${kiosk}` : '';
  return <Navigate to={base ? `${base}/calibration/tracing/gripper-cam` : '/calibration/tracing/gripper-cam'} replace />;
}
