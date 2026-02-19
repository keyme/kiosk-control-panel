const DEFAULT_PORT = 2026;

/**
 * Build base URL for WebSocket (device) and API from a device host string.
 * - Falsy deviceHost: return window.location.origin.
 * - No dot in value: treat as short name, use http://{value}.keymekiosk.com:{port}.
 * - Otherwise: strip any scheme and use http://{host}:{port}.
 */
export function buildBaseUrl(deviceHost, port = DEFAULT_PORT) {
  const host = (deviceHost || '').trim();
  if (!host) return window.location.origin;
  const hostOnly = host.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
  const withDomain = hostOnly.includes('.') ? hostOnly : `${hostOnly}.keymekiosk.com`;
  return `http://${withDomain}:${port}`;
}

/**
 * If value is all digits (e.g. 1111), return 'ns' + value (e.g. ns1111). Otherwise return trimmed value.
 */
export function normalizeDeviceHost(value) {
  const v = (value || '').trim();
  if (/^\d+$/.test(v)) return 'ns' + v;
  return v;
}

/**
 * Initial value for the device host field: from path (first segment) or ?host= only.
 * Never use the page's URL hostname/DNS as the device — user must enter kiosk or use path/query.
 */
export function getInitialDeviceHost() {
  const pathSegments = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (pathSegments[0]) {
    return normalizeDeviceHost(pathSegments[0]);
  }
  const params = new URLSearchParams(window.location.search);
  const hostParam = params.get('host');
  if (hostParam) {
    const hostOnly = hostParam.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
    const short = hostOnly.endsWith('.keymekiosk.com')
      ? hostOnly.slice(0, -'.keymekiosk.com'.length)
      : hostOnly;
    return normalizeDeviceHost(short);
  }
  return '';
}

/**
 * @deprecated Use getInitialDeviceHost() + buildBaseUrl() and title bar device field instead.
 * Resolves the WebSocket server base URL from URL params (legacy).
 */
export function getSocketBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const device = params.get('device');
  const host = params.get('host');
  const port = params.get('port') || String(DEFAULT_PORT);

  if (device) {
    const url = device.replace(/\/+$/, '');
    return url;
  }

  if (host) {
    const hostOnly = host.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
    return `http://${hostOnly}:${port}`;
  }

  return window.location.origin;
}
