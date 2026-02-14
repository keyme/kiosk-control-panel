/**
 * WebSocket wrapper for control panel device: request/response + push.
 * Protocol: client sends { id, event, data? }; server responds { id, success, data? } or { id, success, errors? };
 * server push: { event, data?, from? } (no id).
 */

const WS_PORT = 2026;
const WS_PATH = '/ws';
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Build WebSocket URL for device. In dev with proxy, use same-origin /ws; otherwise ws://host:port/ws.
 */
export function buildWsUrl(deviceHost) {
  const host = (deviceHost || '').trim();
  if (!host) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${WS_PATH}`;
  }
  const hostOnly = host.replace(/^(https?:\/\/)?([^/]+).*$/i, '$2');
  const withDomain = hostOnly.includes('.') ? hostOnly : `${hostOnly}.keymekiosk.com`;
  return `ws://${withDomain}:${WS_PORT}${WS_PATH}`;
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
      }
      return;
    }
    const event = msg && msg.event;
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

  function connect() {
    if (ws) return;
    helloReceived = false;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {};
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleMessage(msg);
      } catch (e) {
        console.error('deviceSocket parse error', e);
      }
    };
    ws.onclose = () => {
      ws = null;
      helloReceived = false;
      pending.forEach((s) => s.reject(new Error('Connection closed')));
      pending.clear();
      if (disconnectCallback) disconnectCallback();
    };
    ws.onerror = () => {
      if (disconnectCallback) disconnectCallback();
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
