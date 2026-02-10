/**
 * Base URL for REST API calls. Always the current page origin (the URL in the browser).
 * Only Socket.IO uses the title-bar device host; API always goes to the same origin as the loaded page.
 */
export function getApiBaseUrl() {
  return window.location.origin;
}

export function apiUrl(path) {
  const base = getApiBaseUrl().replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}
