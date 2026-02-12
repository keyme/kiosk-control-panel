/**
 * Authenticated fetch wrapper.
 *
 * - Reads the KeyMe token from localStorage and attaches it as `KEYME-TOKEN`.
 * - On 401 responses, clears the stored token and redirects to /login.
 */
import { apiUrl } from './apiUrl';

const TOKEN_KEY = 'keyme_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Drop-in replacement for `fetch(apiUrl(path), options)`.
 *
 * Automatically injects the KEYME-TOKEN header and handles 401.
 *
 * @param {string} path  API path, e.g. `/api/calibration/testcuts/ids?kiosk=ns1234`
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['KEYME-TOKEN'] = token;
  }

  const res = await fetch(apiUrl(path), { ...options, headers });

  if (res.status === 401) {
    clearToken();
    // Navigate to login; use window.location so it works outside React Router.
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  return res;
}
