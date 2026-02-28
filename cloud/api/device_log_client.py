# Server-side device WebSocket client for log analysis: search_log and get_log_around_datetime.
# Caller resolves device and passes backend_url, ssl_ctx, wss_key to avoid circular imports with main.

import asyncio
import json
import logging
from typing import Any, List, Optional, Tuple

import websockets

log = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 60
# Match device log_tail._SEARCH_LOG_TIMEOUT_SEC so client does not give up before device.
SEARCH_LOG_TIMEOUT = 120
# Per-recv timeout while streaming; device has no total cap for get_log_around.
GET_LOG_AROUND_TIMEOUT = 90
_HELLO_EVENT = "hello"
# Single request per connection; id is only used to match response to our request.
_REQUEST_ID = 1


async def _connect_and_request(
    backend_url: str,
    ssl_ctx: Optional[Any],
    wss_key: str,
    event: str,
    data: dict,
    timeout: float = _DEFAULT_TIMEOUT,
) -> Tuple[dict, List[dict]]:
    """Connect to device WSS, send one request, collect response and any push messages. Returns (response_msg, list_of_push_messages)."""
    connect_kwargs: dict = {"ssl": ssl_ctx} if ssl_ctx is not None else {}
    connect_kwargs["additional_headers"] = {"Authorization": "Bearer " + wss_key}
    connect_kwargs["additional_headers"]["X-User-Email"] = "log-analysis"
    connect_kwargs["max_size"] = 10 * 1024 * 1024
    connect_kwargs["close_timeout"] = 5
    payload = {"id": _REQUEST_ID, "event": event, "data": data}

    async with websockets.connect(backend_url, **connect_kwargs) as ws:
        await ws.send(json.dumps(payload))
        response_msg = None
        push_messages = []
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                log.warning("device_log_client recv timeout")
                raise
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("event") == _HELLO_EVENT:
                continue
            if "id" in msg and msg.get("id") == _REQUEST_ID:
                response_msg = msg
                break
            push_messages.append(msg)
        return response_msg, push_messages


async def search_log(
    backend_url: str,
    ssl_ctx: Optional[Any],
    wss_key: str,
    query: str,
    date_hint_start: Optional[str] = None,
    date_hint_end: Optional[str] = None,
    timeout: float = SEARCH_LOG_TIMEOUT,
) -> Optional[str]:
    """Find exact datetime when query appears in device log. Returns datetime string or None on error/not found."""
    data = {"log_id": "all", "query": query.strip()}
    if date_hint_start:
        data["date_hint_start"] = date_hint_start
    if date_hint_end:
        data["date_hint_end"] = date_hint_end
    try:
        resp, _ = await _connect_and_request(
            backend_url, ssl_ctx, wss_key, "search_log", data, timeout=timeout
        )
    except Exception as e:
        log.warning("search_log request failed: %s", e)
        return None
    if not resp.get("success") or not isinstance(resp.get("data"), dict):
        return None
    dt = resp["data"].get("datetime")
    log.info("search_log query=%s datetime=%s", query[:64] if query else "", dt)
    return dt


PUSH_LOG_AROUND_BATCH = "log_around_batch"
PUSH_LOG_AROUND_DONE = "log_around_done"


async def get_log_around_datetime(
    backend_url: str,
    ssl_ctx: Optional[Any],
    wss_key: str,
    central_datetime: str,
    lines_before: int = 1000,
    lines_after: int = 10000,
    timeout: float = GET_LOG_AROUND_TIMEOUT,
    output_path: Optional[str] = None,
) -> bool:
    """Stream log around central_datetime from device. If output_path is set, write chunks directly to file (no full buffer in memory). Returns True on success."""
    import uuid
    stream_id = str(uuid.uuid4())[:12]
    data = {
        "log_id": "all",
        "central_datetime": central_datetime,
        "lines_before": lines_before,
        "lines_after": lines_after,
        "stream_id": stream_id,
    }
    connect_kwargs: dict = {"ssl": ssl_ctx} if ssl_ctx is not None else {}
    connect_kwargs["additional_headers"] = {"Authorization": "Bearer " + wss_key}
    connect_kwargs["additional_headers"]["X-User-Email"] = "log-analysis"
    connect_kwargs["max_size"] = 10 * 1024 * 1024
    connect_kwargs["close_timeout"] = 5
    payload = {"id": _REQUEST_ID, "event": "get_log_around_datetime", "data": data}

    try:
        async with websockets.connect(backend_url, **connect_kwargs) as ws:
            await ws.send(json.dumps(payload))
            response_msg = None
            bytes_received = 0
            if output_path:
                f = open(output_path, "w", encoding="utf-8")
            else:
                f = None
            try:
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
                    msg = json.loads(raw) if isinstance(raw, str) else {}
                    if not isinstance(msg, dict):
                        continue
                    if msg.get("event") == _HELLO_EVENT:
                        continue
                    if "id" in msg and msg.get("id") == _REQUEST_ID:
                        response_msg = msg
                        if not response_msg.get("success"):
                            return False
                        continue
                    if msg.get("event") == PUSH_LOG_AROUND_BATCH:
                        d = msg.get("data") or {}
                        if d.get("stream_id") == stream_id and f is not None:
                            chunk = d.get("chunk")
                            if isinstance(chunk, str):
                                n = len(chunk)
                                bytes_received += n
                                f.write(chunk)
                    if msg.get("event") == PUSH_LOG_AROUND_DONE:
                        d = msg.get("data") or {}
                        if d.get("stream_id") == stream_id:
                            break
            finally:
                if f is not None:
                    f.close()
            log.info(
                "get_log_around_datetime stream_id=%s bytes_received=%s output_path=%s success=%s",
                stream_id,
                bytes_received,
                output_path or "(none)",
                response_msg.get("success") if response_msg else False,
            )
            return response_msg is not None and response_msg.get("success") is True
    except Exception as e:
        log.warning(f"get_log_around_datetime request failed: {e}")
        return False
