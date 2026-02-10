export const CALIBRATION_REPORT_SECTIONS = [
  'testcuts',
  'bitting_calibration',
  'bump_tower_calibration',
  'grip_calibration',
  'gripper_cam_calibration',
  'gripper_leds_check',
  'overhead_cam_calibration',
  'pickup_y_calibration',
];

export function formatSectionLabel(key) {
  return key
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const TS_REGEX = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-UTC$/;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatTimestampShort(tsStr) {
  if (typeof tsStr !== 'string' || !tsStr) return null;
  const match = tsStr.match(TS_REGEX);
  if (!match) return null;
  const [, y, mo, d, h, min] = match;
  const month = MONTH_NAMES[parseInt(mo, 10) - 1] || mo;
  const day = parseInt(d, 10);
  const hour = parseInt(h, 10);
  const minute = parseInt(min, 10);
  const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
  return { label: `${month} ${day}, ${y}, ${timeStr}`, timeOnly: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}` };
}

/** Run IDs are YYYY-MM-DD-HH-MM-SS-UTC. Fallback when no span available. */
export function formatRunIdForDisplay(runId) {
  const parsed = formatTimestampShort(runId);
  return parsed ? parsed.label : String(runId ?? '');
}

/** Format run span as "Oct 20, 2025, 10:16 – 10:28" from start_ts and end_ts. */
export function formatRunSpan(startTs, endTs) {
  const start = formatTimestampShort(startTs);
  const end = formatTimestampShort(endTs);
  if (!start) return end ? end.label : (startTs ? String(startTs) : '');
  if (!end || startTs === endTs) return start.label;
  return `${start.label} – ${end.timeOnly}`;
}
