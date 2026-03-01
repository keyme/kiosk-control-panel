/**
 * WebSocket client for cloud /ai endpoint (AI log analysis).
 * Protocol: send { event, id, data }; receive { id, success, result } or { id, success: false, error }.
 */

import { getToken } from './apiFetch';

const AI_WS_PATH = '/ai';
const REQUEST_TIMEOUT_MS = 120000;

/**
 * Build WebSocket URL for /ai. Same-origin, path /ai, query token=... (KeyMe token from apiFetch).
 */
export function buildAiWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}${AI_WS_PATH}`;
  const token = getToken();
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
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
    const id = msg.id;
    if (id === undefined || id === null) return;
    const settle = pending.get(id);
    if (!settle) return;
    pending.delete(id);
    if (msg.success === false) {
      settle.reject(new Error(msg.error || 'Request failed'));
    } else {
      settle.resolve(msg);
    }
  }

  function connect() {
    if (ws) return;
    const url = buildAiWsUrl();
    ws = new WebSocket(url);
    ws.onopen = () => {
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
      pending.forEach((s) => s.reject(new Error('Connection closed')));
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

    onConnect(cb) {
      onConnectCb = cb;
    },

    onDisconnect(cb) {
      onDisconnectCb = cb;
    },
  };

  return socket;
}
