# Async WebSocket client for Codex app-server (thread/start, turn/start, collect agent reply).
# Uses control_panel/cloud/codex_docs for request/response and notification shapes.

import asyncio
import json
import logging
import os
from typing import Any, Awaitable, Callable, Dict, List, Optional

import websockets

log = logging.getLogger(__name__)

DEFAULT_WS_URL = "ws://127.0.0.1:4500"
ENV_WS_URL = "CODEX_APP_SERVER_WS_URL"

# Timeouts
INIT_TIMEOUT = 15
THREAD_START_TIMEOUT = 30
TURN_TIMEOUT = 300  # One turn can take a long time

_REQUEST_ID_INIT = 0
_REQUEST_ID_THREAD_START = 1
_REQUEST_ID_TURN_START = 2


def _get_ws_url() -> str:
    return os.environ.get(ENV_WS_URL, DEFAULT_WS_URL).strip() or DEFAULT_WS_URL


async def _recv_json(ws: Any, timeout: float) -> Optional[Dict[str, Any]]:
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    except asyncio.TimeoutError:
        log.warning("codex_app_server_client recv timeout")
        raise
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


def _extract_agent_text_from_turn(turn: Dict[str, Any]) -> str:
    """Collect agent message text from turn.items (agentMessage items)."""
    items = turn.get("items") or []
    parts: List[str] = []
    for it in items:
        if isinstance(it, dict) and it.get("type") == "agentMessage":
            text = it.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n\n".join(parts).strip()


async def connect_and_handshake(ws_url: Optional[str] = None) -> Any:
    """
    Connect to Codex app-server, send initialize + initialized, return the open websocket.
    Caller must close the connection when done.
    """
    url = (ws_url or _get_ws_url()).strip() or _get_ws_url()
    ws = await websockets.connect(
        url,
        max_size=10 * 1024 * 1024,
        close_timeout=5,
    )
    try:
        # initialize
        init_req = {
            "method": "initialize",
            "id": _REQUEST_ID_INIT,
            "params": {
                "clientInfo": {
                    "name": "control-panel",
                    "title": "Control Panel",
                    "version": "1.0",
                },
                "capabilities": None,
            },
        }
        await ws.send(json.dumps(init_req))
        while True:
            msg = await _recv_json(ws, INIT_TIMEOUT)
            if not isinstance(msg, dict):
                continue
            if msg.get("id") == _REQUEST_ID_INIT:
                if "error" in msg:
                    raise RuntimeError(
                        "Codex app-server initialize error: %s" % msg.get("error")
                    )
                break
            # ignore notifications during handshake
        # initialized notification
        await ws.send(json.dumps({"method": "initialized"}))
    except Exception:
        await ws.close()
        raise
    return ws


async def thread_start(ws: Any, cwd: str) -> str:
    """
    Send thread/start with cwd; return thread_id from response.
    """
    req = {
        "method": "thread/start",
        "id": _REQUEST_ID_THREAD_START,
        "params": {
            "cwd": cwd,
            "approvalPolicy": "never",
            "sandbox": "danger-full-access",
            "experimentalRawEvents": False,
            "persistExtendedHistory": False,
        },
    }
    await ws.send(json.dumps(req))
    while True:
        msg = await _recv_json(ws, THREAD_START_TIMEOUT)
        if not isinstance(msg, dict):
            continue
        if msg.get("id") == _REQUEST_ID_THREAD_START:
            if "error" in msg:
                err = msg["error"]
                raise RuntimeError(
                    "Codex thread/start error: %s" % err.get("message", err)
                )
            result = msg.get("result")
            if not isinstance(result, dict):
                raise RuntimeError("Codex thread/start missing result")
            thread = result.get("thread")
            if not isinstance(thread, dict):
                raise RuntimeError("Codex thread/start missing thread")
            thread_id = thread.get("id")
            if not isinstance(thread_id, str):
                raise RuntimeError("Codex thread/start missing thread.id")
            return thread_id
        # ignore other notifications


async def turn_start(
    ws: Any,
    thread_id: str,
    text: str,
    on_delta: Optional[Callable[[str], Awaitable[None]]] = None,
) -> str:
    """
    Send turn/start; proxy agent message deltas via on_delta (if set), collect
    full text from item/completed and turn/completed; return combined reply text.
    """
    req = {
        "method": "turn/start",
        "id": _REQUEST_ID_TURN_START,
        "params": {
            "threadId": thread_id,
            "input": [{"type": "text", "text": text, "text_elements": []}],
        },
    }
    await ws.send(json.dumps(req))
    parts: List[str] = []
    turn_completed = False
    while not turn_completed:
        msg = await _recv_json(ws, TURN_TIMEOUT)
        if not isinstance(msg, dict):
            continue
        mid = msg.get("id")
        method = msg.get("method")
        if method == "item/agentMessage/delta":
            params = msg.get("params")
            if isinstance(params, dict):
                delta = params.get("delta")
                if isinstance(delta, str) and on_delta:
                    await on_delta(delta)
            continue
        if mid == _REQUEST_ID_TURN_START:
            if "error" in msg:
                err = msg["error"]
                raise RuntimeError(
                    "Codex turn/start error: %s" % err.get("message", err)
                )
            # TurnStartResponse has turn; turn.items may be empty per docs
            result = msg.get("result")
            if isinstance(result, dict):
                turn = result.get("turn")
                if isinstance(turn, dict):
                    t = _extract_agent_text_from_turn(turn)
                    if t:
                        parts.append(t)
            continue
        if method == "turn/completed":
            turn_completed = True
            params = msg.get("params")
            if isinstance(params, dict):
                turn = params.get("turn")
                if isinstance(turn, dict):
                    t = _extract_agent_text_from_turn(turn)
                    if t:
                        parts.append(t)
            continue
        if method == "item/completed":
            params = msg.get("params")
            if isinstance(params, dict):
                item = params.get("item")
                if isinstance(item, dict) and item.get("type") == "agentMessage":
                    t = item.get("text")
                    if isinstance(t, str) and t:
                        parts.append(t)
    return "\n\n".join(parts).strip()
