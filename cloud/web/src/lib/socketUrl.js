const DEFAULT_PORT = 2026;

/**
 * Build base URL for Socket.IO and API from a device host string.
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
 * Initial value for the device host field: from path (first segment), ?host=, or hostname.
 * Path takes precedence: e.g. /ns1234/calibration/ or /192.168.1.1/calibration/ → use that segment.
 */
export function getInitialDeviceHost() {
  const pathSegments = window.location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (pathSegments[0]) {
    return pathSegments[0];
  }
  const params = new URLSearchParams(window.location.search);
  const hostParam = params.get('host');
  if (hostParam) {
    const hostOnly = hostParam.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
    return hostOnly.endsWith('.keymekiosk.com')
      ? hostOnly.slice(0, -'.keymekiosk.com'.length)
      : hostOnly;
  }
  const hostname = window.location.hostname || '';
  if (hostname.endsWith('.keymekiosk.com')) {
    return hostname.slice(0, -'.keymekiosk.com'.length);
  }
  return hostname || '';
}

/**
 * @deprecated Use getInitialDeviceHost() + buildBaseUrl() and title bar device field instead.
 * Resolves the Socket.IO server base URL from URL params (legacy).
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
