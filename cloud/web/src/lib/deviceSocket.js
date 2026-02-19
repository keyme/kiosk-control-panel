/**
 * WebSocket wrapper for control panel device: request/response + push.
 * Protocol: client sends { id, event, data? }; server responds { id, success, data? } or { id, success, errors? };
 * server push: { event, data?, from? } (no id).
 */

import { getToken } from './apiFetch';

const WS_PATH = '/ws';
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Build WebSocket URL for device. Same-origin /ws (cloud proxy or Vite dev proxy).
 * When deviceHost is set, add ?device=... so the cloud proxy can connect to that device.
 * When a KeyMe token is present (cloud auth), add &token=... so the cloud validates before proxying.
 */
export function buildWsUrl(deviceHost) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}${WS_PATH}`;
  const host = (deviceHost || '').trim();
  const params = new URLSearchParams();
  if (host) {
    const hostOnly = host.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
    params.set('device', hostOnly);
  }
  const token = getToken();
  if (token) {
    params.set('token', token);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Create a device socket instance that connects to wsUrl and provides request() and on/off.
 */
export function createDeviceSocket(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let ws = null;
  let helloReceived = false;
  let connectCallback = null;
  let disconnectCallback = null;

  function sendMessage(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleMessage(msg) {
    const hasId = msg != null && 'id' in msg && msg.id !== undefined && msg.id !== null;
    if (hasId) {
      const id = msg.id;
      const settle = pending.get(id);
      if (settle) {
        pending.delete(id);
        if (msg.success === false) {
          settle.reject(new Error(Array.isArray(msg.errors) ? msg.errors.join('; ') : 'Request failed'));
        } else {
          settle.resolve(msg);
        }
        return;
      }
      // If the server mistakenly includes an `id` on a push message (or the client has already timed out),
      // treat it as a push only if it also includes an `event`.
      if (msg.event == null) return;
    }
    const event = msg && msg.event != null ? String(msg.event).trim() : undefined;
    if (!event) return;
    if (event === 'hello') {
      helloReceived = true;
      if (connectCallback) connectCallback();
    }
    const list = listeners.get(event);
    if (list) {
      list.forEach((fn) => {
        try {
          fn(msg.data, msg);
        } catch (e) {
          console.error('deviceSocket listener error', event, e);
        }
      });
    }
  }

  function parseMessage(raw) {
    if (raw == null) return null;
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      // Some tools/servers can append extra columns after JSON when copying/printing.
      // Try to recover by parsing the first {...} span.
      const start = s.indexOf('{');
      const end = s.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const candidate = s.slice(start, end + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  function connect() {
    if (ws) return;
    helloReceived = false;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      const raw = ev.data;
      const msg = parseMessage(raw);
      if (msg) {
        handleMessage(msg);
      } else {
        console.error('deviceSocket parse error');
      }
    };
    ws.onclose = (ev) => {
      ws = null;
      helloReceived = false;
      pending.forEach((s) => s.reject(new Error('Connection closed')));
      pending.clear();
      if (disconnectCallback) disconnectCallback({ code: ev.code, reason: ev.reason ?? '' });
    };
    ws.onerror = () => {
      if (disconnectCallback) disconnectCallback({ code: undefined, reason: '' });
    };
  }

  const socket = {
    get connected() {
      return ws != null && ws.readyState === WebSocket.OPEN && helloReceived;
    },

    connect() {
      connect();
    },

    disconnect() {
      if (ws) {
        ws.close();
        ws = null;
      }
      helloReceived = false;
    },

    request(event, data) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        sendMessage({ id, event, data: data || undefined });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('Request timeout'));
          }
        }, REQUEST_TIMEOUT_MS);
      });
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },

    off(event, handler) {
      const list = listeners.get(event);
      if (!list) return;
      if (handler) {
        const i = list.indexOf(handler);
        if (i !== -1) list.splice(i, 1);
      } else {
        list.length = 0;
      }
    },

    onConnect(cb) {
      connectCallback = cb;
    },

    onDisconnect(cb) {
      disconnectCallback = cb;
    },
  };

  connect();
  return socket;
}
