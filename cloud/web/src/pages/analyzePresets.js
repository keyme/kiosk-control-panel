/**
 * Predefined process names (used by log_filter.awk and builder).
 * Used for preset definitions and query builder.
 */
export const ANALYZE_PROCESS_NAMES = [
  'ABILITIES_MANAGER', 'CONTROLLER', 'ADVERTISER', 'AUTOCAL', 'BACKEND', 'BACKGROUND_DL', 'BROWSER',
  'CREDIT_CARD', 'CUTTER', 'DET', 'DET_BITTING_LEFT', 'DET_BITTING_RIGHT', 'DET_MILLING',
  'DEVICE_DIRECTOR', 'GEOMETRY', 'GRIP_CALIB', 'GRIPPER_CAM', 'GUI', 'INVENTORY', 'INVENTORY_CAMERA',
  'IO', 'JOB_SERVER', 'ADMIN_OPTIONS', 'KEY_PATH_GEN', 'MOTION', 'NETS_SERVER', 'ORDER_DISPATCHER',
  'OVERHEAD_CAMERA', 'POWER_MONITOR', 'PRINTER', 'RFID_READER', 'SECURITY_CAMERA', 'SECURITY_MONITOR',
  'TRANSPONDER', 'UPLOADER', 'CONTROL_PANEL', 'SENDER', 'SYSTEM_MONITOR',
];

/** Level codes and labels for builder. */
export const ANALYZE_LEVELS = [
  { value: 'e', label: 'Error' },
  { value: 'w', label: 'Warning' },
  { value: 'i', label: 'Info' },
  { value: 'c', label: 'Critical' },
  { value: 'd', label: 'Debug' },
];

/** Predefined message patterns: { id, label, message_regex }. */
export const ANALYZE_MESSAGE_PRESETS = [
  { id: 'restart', label: 'Restart', message_regex: 'async_STARTED to MANAGER' },
  { id: 'timeout_ping', label: 'Timeout / PING', message_regex: 'timeout|PING' },
  { id: 'countdown_expired', label: 'Countdown expired', message_regex: 'countdown expired' },
  { id: 'cancel_session', label: 'Cancel / Not converted', message_regex: 'canceling session' },
  { id: 'missing_heights', label: 'Missing heights', message_regex: 'item is missing heights' },
  { id: 'payment_page', label: 'Payment page', message_regex: 'page changed to /payment' },
  { id: 'insert_for_copy', label: 'Insert for copy', message_regex: 'page changed to /insert_for_copy' },
  { id: 'post_to_orders', label: 'Post to orders', message_regex: 'sending POST to https://api.key.me/orders' },
  { id: 'touch_button', label: 'Touch button', message_regex: 'TOUCH BUTTON' },
  { id: 'got_error_from_ping', label: 'Got an error from ping', message_regex: 'Got an error from ping' },
  { id: 'hardware_unparseable', label: 'Hardware unparseable', message_regex: 'unparseable! Skipping' },
];

/**
 * Presets: { id, name, query, processes, levels, message_regex }.
 * name = short label in preset dropdown. query = full query shown in Query field. Backend receives processes, levels, message_regex.
 */
export const ANALYZE_PRESETS = [
  {
    id: 'errors_and_restarts',
    name: 'Errors and restarts',
    query: '(log_level:e OR log_level:c) OR message:/async_STARTED to MANAGER/',
    processes: [],
    levels: ['e', 'c'],
    message_regex: 'async_STARTED to MANAGER',
  },
  {
    id: 'errors_only',
    name: 'Errors only',
    query: 'log_level:e OR log_level:c',
    processes: [],
    levels: ['e', 'c'],
    message_regex: '',
  },
  {
    id: 'restarts_only',
    name: 'Restarts only',
    query: 'message:/async_STARTED to MANAGER/',
    processes: [],
    levels: [],
    message_regex: 'async_STARTED to MANAGER',
  },
  {
    id: 'warnings_and_errors',
    name: 'Warnings and errors',
    query: 'log_level:w OR log_level:e',
    processes: [],
    levels: ['w', 'e'],
    message_regex: '',
  },
];

export function getPresetPayload(preset) {
  const { processes = [], levels = [], message_regex = '', combine_mode } = preset;
  return { processes: [...processes], levels: [...levels], message_regex, combine_mode: combine_mode || 'AND_OR' };
}
