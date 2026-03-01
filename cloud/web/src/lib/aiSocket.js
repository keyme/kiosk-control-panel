/**
 * WebSocket client for cloud /ai endpoint (AI log analysis).
 * Protocol: send { event, id, data }; receive { id, success, result } or { id, success: false, error }.
 */

import { getToken } from './apiFetch';

const AI_WS_PATH = '/ai';
const REQUEST_TIMEOUT_MS = 120000;

/**
 * Build WebSocket URL for /ai. Same-origin, path /ai, no query params (auth sent in first message).
 */
export function buildAiWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${AI_WS_PATH}`;
}

/**
 * Create an AI socket: connect to /ai, request(event, data) returns Promise<{ success, result? } | { success: false, error }>.
 */
export function createAiSocket() {
  let nextId = 1;
  const pending = new Map();
  let ws = null;
  let onConnectCb = null;
  let onDisconnectCb = null;

  function sendMessage(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function handleMessage(msg) {
    if (msg == null || typeof msg !== 'object') return;
    if (msg.event === 'auth_ok') return;
    const id = msg.id;
    if (id === undefined || id === null) return;
    const entry = pending.get(id);
    if (!entry) return;
    if ('stream_delta' in msg && typeof msg.stream_delta === 'string') {
      if (entry.onStreamDelta) entry.onStreamDelta(msg.stream_delta);
      return;
    }
    pending.delete(id);
    if (msg.success === false) {
      entry.reject(new Error(msg.error || 'Request failed'));
    } else {
      entry.resolve(msg);
    }
  }

  function connect() {
    if (ws) return;
    const url = buildAiWsUrl();
    ws = new WebSocket(url);
    ws.onopen = () => {
      sendMessage({ event: 'auth', token: getToken() || '' });
      if (onConnectCb) onConnectCb();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      ws = null;
      pending.forEach((entry) => entry.reject(new Error('Connection closed')));
      pending.clear();
      if (onDisconnectCb) onDisconnectCb();
    };
    ws.onerror = () => {};
  }

  const socket = {
    get connected() {
      return ws != null && ws.readyState === WebSocket.OPEN;
    },

    connect() {
      connect();
    },

    disconnect() {
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    request(event, data, options = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {
          resolve,
          reject,
          onStreamDelta: options.onStreamDelta || null,
        });
        sendMessage({ id, event, data: data || undefined });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('Request timeout'));
          }
        }, REQUEST_TIMEOUT_MS);
      });
    },

    onConnect(cb) {
      onConnectCb = cb;
    },

    onDisconnect(cb) {
      onDisconnectCb = cb;
    },
  };

  return socket;
}
