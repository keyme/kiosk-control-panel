# WebSocket server for control panel using the websockets library (RFC 6455).
# Python 3.6 compatible. Application protocol: JSON request/response and push.

import asyncio
import json
import os
import ssl
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import websockets

import pylib as keyme

from control_panel.python.shared import (
    CERT_PATH,
    CERT_MARKER_PATH,
    KEY_PATH,
    PORTS,
    WSS_KEYRING_SERVICE,
    WSS_KEYRING_USERNAME,
)
from control_panel.shared import WS_PATH
from control_panel.python import ws_protocol

# Fleet events this server handles; must match control_panel.fleet_permissions.EVENT_TO_PERMISSION.
FLEET_EVENT_NAMES = frozenset((
    "fleet_reboot_kiosk",
    "fleet_clear_cutter_stuck",
    "fleet_restart_process",
    "fleet_reset_device",
    "fleet_switch_process_list",
))
from control_panel.fleet_permissions import EVENT_TO_PERMISSION
from control_panel.python import log_tail as _log_tail_module

assert FLEET_EVENT_NAMES == frozenset(EVENT_TO_PERMISSION.keys()), (
    "FLEET_EVENT_NAMES in ws_server must match EVENT_TO_PERMISSION in control_panel.fleet_permissions"
)

# Set after server module is loaded.
_server_handlers = None
_async_loop = None
_executor = None

_CONNECTION_COUNT_STATE = 'state/control_panel/connection_count.json'

# Connected clients: id -> ws (websockets WebSocketServerProtocol)
_connected_clients = {}
_clients_lock = threading.Lock()
_wellness_client_id = None
_wellness_client_lock = threading.Lock()

_wss_api_key = None


def _load_wss_api_key():
    """Load WSS API key; cache in keyring and _wss_api_key."""
    global _wss_api_key
    try:
        api_key = keyme.keyring_utils.safe_get_password(WSS_KEYRING_SERVICE, WSS_KEYRING_USERNAME)
        if api_key:
            _wss_api_key = api_key
            return

        keyme.log.warning("WSS API key not in keyring; fetching from AWS Secrets Manager")
        from control_panel.python.scripts.load_wss_api_key import load_wss_api_key

        _wss_api_key = load_wss_api_key(enable_jitter=True, cache_in_keyring=True)
    except Exception as e:
        keyme.log.warning(f"WSS API key load failed: {e}")
        _wss_api_key = None
        return


def _write_connection_count(count):
    try:
        keyme.config.save(_CONNECTION_COUNT_STATE, {'connection_count': count})
    except Exception:
        pass


def _set_handlers(handlers_module):
    """Register the handlers module (server) so we can call event handlers."""
    global _server_handlers
    _server_handlers = handlers_module


def _get_connection_count():
    with _clients_lock:
        return len(_connected_clients)


def _normalize_response(request_id, handler_result):
    """Turn handler return into { id, success, data } or { id, success, errors }."""
    if handler_result is None:
        return {'id': request_id, 'success': False, 'errors': ['No response']}
    if isinstance(handler_result, dict) and 'success' in handler_result:
        out = dict(handler_result)
        out['id'] = request_id
        return out
    return {'id': request_id, 'success': True, 'data': handler_result}


def _dispatch_request(client_id, request_id, event, data, connection_count):
    """Call the right handler and return normalized response dict. Runs in executor (sync)."""
    if _server_handlers is None:
        return {'id': request_id, 'success': False, 'errors': ['Server not ready']}
    handlers = _server_handlers
    event_handlers = {
        'get_kiosk_name': lambda: handlers.get_kiosk_name(),
        'get_panel_info': lambda: handlers.get_panel_info(),
        'get_activity': lambda: handlers.get_activity(),
        'get_computer_stats': lambda: handlers.get_computer_stats(),
        'get_terminals': lambda: handlers.get_terminals(),
        'get_wtf_why_degraded': lambda: handlers.get_wtf_why_degraded(),
        'get_status_sections': lambda: handlers.get_status_sections(),
        'get_connection_count': lambda: handlers.get_connection_count(connection_count=connection_count),
        'get_status_snapshot': lambda: handlers.get_status_snapshot(connection_count=connection_count),
        'get_all_configs': lambda: handlers.get_all_configs(),
        'take_image': lambda: handlers.take_image(data or {}),
        'get_wellness_check': lambda: handlers.get_wellness_check(
            client_id=client_id,
            send_progress=lambda p: _schedule_send(client_id, {'event': ws_protocol.PUSH_WELLNESS_PROGRESS, 'data': p})
        ),
        'get_data_usage': lambda: handlers.get_data_usage(),
        'get_log_list': lambda: handlers.get_log_list(),
        'log_tail_start': lambda: handlers.log_tail_start(
            client_id,
            data or {},
            lambda cid, obj: _schedule_send(cid, obj),
            ws_protocol.PUSH_LOG_TAIL_LINE,
        ),
        'log_tail_stop': lambda: handlers.log_tail_stop(client_id),
        'fleet_restart_process': lambda: handlers.fleet_restart_process(data or {}),
        'fleet_reset_device': lambda: handlers.fleet_reset_device(data or {}),
        'fleet_switch_process_list': lambda: handlers.fleet_switch_process_list(data or {}),
        'fleet_reboot_kiosk': lambda: handlers.fleet_reboot_kiosk(data or {}),
        'fleet_clear_cutter_stuck': lambda: handlers.fleet_clear_cutter_stuck(data or {}),
    }
    if event not in event_handlers:
        return {'id': request_id, 'success': False, 'errors': ['Unknown event']}
    try:
        result = event_handlers[event]()
        return _normalize_response(request_id, result)
    except Exception as e:
        keyme.log.error(f"Handler {event} failed: {e}")
        return {'id': request_id, 'success': False, 'errors': [str(e)]}


def _schedule_send(client_id, obj):
    """Schedule sending a JSON message to a client from a sync context (e.g. wellness progress)."""
    with _clients_lock:
        ws = _connected_clients.get(client_id)
    if ws is None:
        return
    loop = _async_loop
    if loop is None:
        return
    try:
        raw = json.dumps(obj)
    except (TypeError, ValueError):
        return
    asyncio.run_coroutine_threadsafe(_send_text(ws, raw), loop)


async def _send_text(ws, text):
    """Send one text message. Must be called from the async loop."""
    try:
        await ws.send(text)
    except (websockets.exceptions.ConnectionClosed, RuntimeError):
        pass


def _clear_cache_if_no_clients():
    """Clear TTL cache when last client disconnects (optional)."""
    if _server_handlers is not None and hasattr(_server_handlers, 'clear_cache'):
        _server_handlers.clear_cache()


def emit_async_request(request_obj):
    """Broadcast async IPC to all connected clients. Called by parser (sync, any thread)."""
    event = ws_protocol.PUSH_ASYNC_PREFIX + request_obj.get('action', '')
    payload = {
        'event': event,
        'data': request_obj.get('data'),
        'from': request_obj.get('from', 'CONTROL_PANEL'),
    }
    with _clients_lock:
        clients = list(_connected_clients.items())
    loop = _async_loop
    if loop is None:
        return
    try:
        raw = json.dumps(payload)
    except (TypeError, ValueError):
        return
    for cid, ws in clients:
        asyncio.run_coroutine_threadsafe(_send_text(ws, raw), loop)


async def _handler(ws, path):
    """Per-connection handler: hello, then request/response loop. Runs in async loop."""
    global _wellness_client_id
    if path != WS_PATH:
        await ws.close()
        return
    if _wss_api_key is None:
        keyme.log.warning("WSS auth rejected: API key not loaded yet (auth not ready)")
        await ws.close(code=4401, reason="auth not ready")
        return
    # Legacy WebSocketServerProtocol uses request_headers; older versions may use request.headers.
    headers = getattr(ws, "request_headers", None) or (
        getattr(ws, "request", None) and getattr(ws.request, "headers", None)
    )
    if headers is None:
        keyme.log.warning("WSS auth rejected: could not read request headers")
        await ws.close(code=4401, reason="missing or invalid API key")
        return
    auth_header = (headers.get("Authorization") or "").strip()
    expected = "Bearer " + _wss_api_key
    if auth_header != expected:
        keyme.log.warning(
            f"WSS auth rejected: Authorization header missing or mismatch "
            f"(header present={bool(auth_header)})"
        )
        await ws.close(code=4401, reason="missing or invalid API key")
        return
    client_id = str(uuid.uuid4())
    kiosk_name = getattr(keyme.config, 'KIOSK_NAME', None) or ''
    hello_msg = json.dumps({
        'event': ws_protocol.PUSH_HELLO,
        'data': {
            'connected': True,
            'service': 'CONTROL_PANEL',
            'kiosk_name': kiosk_name,
        }
    })
    try:
        await ws.send(hello_msg)
    except (websockets.exceptions.ConnectionClosed, RuntimeError):
        return
    with _clients_lock:
        _connected_clients[client_id] = ws
        count = len(_connected_clients)
    _write_connection_count(count)
    keyme.log.info(f"Control panel WS client connected id={client_id} total={count}")
    loop = asyncio.get_event_loop()
    try:
        async for message in ws:
            try:
                msg = json.loads(message)
            except (ValueError, TypeError):
                err = json.dumps({'id': None, 'success': False, 'errors': ['Invalid JSON']})
                await _send_text(ws, err)
                continue
            request_id = msg.get('id')
            event = msg.get('event')
            data = msg.get('data')
            if not event:
                err = json.dumps({'id': request_id, 'success': False, 'errors': ['Missing event']})
                await _send_text(ws, err)
                continue
            connection_count = _get_connection_count()
            response = await loop.run_in_executor(
                _executor,
                lambda: _dispatch_request(client_id, request_id, event, data, connection_count)
            )
            try:
                response_str = json.dumps(response)
            except (TypeError, ValueError):
                response_str = json.dumps({'id': request_id, 'success': False, 'errors': ['Serialization error']})
            await _send_text(ws, response_str)
    except (websockets.exceptions.ConnectionClosed, RuntimeError, ValueError) as e:
        keyme.log.warning(f"WS client {client_id} error: {e}")
    finally:
        with _clients_lock:
            _connected_clients.pop(client_id, None)
            count = len(_connected_clients)
        _write_connection_count(count)
        _log_tail_module.log_tail_stop(client_id)
        with _wellness_client_lock:
            if _wellness_client_id == client_id:
                _wellness_client_id = None
        if count == 0:
            _clear_cache_if_no_clients()
        keyme.log.info(f"Control panel WS client disconnected id={client_id} total={count}")


def run():
    """Entry point: set handlers, then run the websockets server in this thread (blocking)."""
    global _async_loop, _executor, _wss_api_key
    from control_panel.python import server as server_handlers
    _set_handlers(server_handlers)
    port = PORTS['python']
    host = '0.0.0.0'
    kiosk_name = keyme.config.KIOSK_NAME
    if not kiosk_name:
        keyme.log.error("Control panel WebSocket server: KIOSK_NAME not set, cannot create certs or start WSS")
        return
    cert_path = CERT_PATH
    key_path = KEY_PATH
    if not (os.path.isfile(cert_path) and os.path.isfile(key_path) and os.path.isfile(CERT_MARKER_PATH)):
        keyme.log.warning("Control panel device cert missing/not uploaded; generating/uploading")
        from control_panel.python.scripts.create_wss_cert_and_upload import ensure_wss_device_certs_and_upload

        cert_path, key_path = ensure_wss_device_certs_and_upload()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
    _write_connection_count(0)
    keyme.log.info(f"Control panel WebSocket server starting host={host} port={port} path={WS_PATH} (WSS)")
    # Fast path: load from keyring synchronously; avoid spawning a thread if already present.
    _wss_api_key = keyme.keyring_utils.safe_get_password(WSS_KEYRING_SERVICE, WSS_KEYRING_USERNAME)
    if not _wss_api_key:
        threading.Thread(target=_load_wss_api_key, daemon=True).start()
    _executor = ThreadPoolExecutor(max_workers=2)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _async_loop = loop
    try:
        start_server = websockets.serve(_handler, host, port, ssl=ctx)
        loop.run_until_complete(start_server)
        loop.run_forever()
    finally:
        _async_loop = None
        _executor.shutdown(wait=True)
