#!/usr/bin/env python3
"""
Cloud API: FastAPI app, REST router, static JS serving. WebSocket proxy to device.
Run with static root and port via env (see README). Entrypoint for uvicorn is control_panel.cloud.main:app.
"""
import asyncio
import logging
import os
import re

# So app logs (INFO) are visible when run under uvicorn (e.g. in Docker).
# Uvicorn only sets level for its own loggers; root stays WARNING and filters our logs.
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s [%(name)s] %(message)s",
    force=True,
)
# force=True (Python 3.8+) applies config even if root already has handlers (e.g. uvicorn).

from contextlib import asynccontextmanager

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from starlette.staticfiles import StaticFiles

from control_panel.cloud.api import create_auth_router, create_router
from control_panel.cloud.api.auth import ANF_BASE_URL, API_ENV

log = logging.getLogger(__name__)

# Static root: env CONTROL_PANEL_STATIC_ROOT or default cloud/web/dist
_default_static = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "dist")
_STATIC_ROOT = os.path.abspath(os.environ.get("CONTROL_PANEL_STATIC_ROOT", _default_static))
_index_html = os.path.join(_STATIC_ROOT, "index.html")
_assets_dir = os.path.join(_STATIC_ROOT, "assets")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    log.info(
        "Control panel cloud API app loaded static_root=%s API_ENV=%s ANF_BASE_URL=%s",
        _STATIC_ROOT,
        API_ENV,
        ANF_BASE_URL,
    )
    yield


app = FastAPI(title="Control Panel Cloud", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(create_auth_router(), prefix="/api")  # login/logout — no auth required
app.include_router(create_router(), prefix="/api")       # all other routes — auth required

if os.path.isdir(_assets_dir):
    app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

_WS_PORT = 2026
_WS_PATH = "/ws"


def _device_ws_url(device_host: str) -> str:
    """Resolve device host to device WebSocket URL (same logic as frontend)."""
    host = (device_host or "").strip()
    if not host:
        return ""
    host_only = re.sub(r"^(https?://)?([^/]+).*", r"\2", host, flags=re.IGNORECASE)
    with_domain = (
        f"{host_only}.keymekiosk.com" if "." not in host_only else host_only
    )
    return f"ws://{with_domain}:{_WS_PORT}{_WS_PATH}"


@app.websocket("/ws")
async def ws_proxy(websocket: WebSocket):
    """Proxy WebSocket to device. Query param 'device' (required) selects the device."""
    device = websocket.query_params.get("device") or ""
    device = device.strip()
    if not device:
        await websocket.close(code=4400, reason="missing device")
        return
    backend_url = _device_ws_url(device)
    if not backend_url:
        await websocket.close(code=4400, reason="invalid device")
        return
    await websocket.accept()
    try:
        async with websockets.connect(backend_url) as device_ws:

            async def client_to_device():
                try:
                    while True:
                        data = await websocket.receive_text()
                        await device_ws.send(data)
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    log.warning("ws proxy client_to_device: %s", e)

            async def device_to_client():
                try:
                    async for message in device_ws:
                        await websocket.send_text(message)
                except Exception as e:
                    log.warning("ws proxy device_to_client: %s", e)

            done, pending = await asyncio.wait(
                [asyncio.create_task(client_to_device()), asyncio.create_task(device_to_client())],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
    except Exception as e:
        log.exception("ws proxy connect to device failed device=%s", device)
        try:
            await websocket.close(code=1011, reason=str(e)[:123])
        except Exception:
            pass
    else:
        try:
            await websocket.close()
        except Exception:
            pass


def _send_index_html():
    return FileResponse(
        _index_html,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/")
def root():
    if os.path.isfile(_index_html):
        log.info("Control panel cloud: serving index.html")
        return _send_index_html()
    log.warning("Control panel cloud: UI not built, returning 404 (set CONTROL_PANEL_STATIC_ROOT or run npm run build)")
    return PlainTextResponse(
        "Control panel UI not built. Set CONTROL_PANEL_STATIC_ROOT or run npm run build in control_panel/cloud/web.",
        status_code=404,
    )


@app.get("/{path:path}")
def spa_fallback(path: str):
    """SPA fallback: non-API, non-assets paths serve index.html."""
    if path.startswith("api") or path.startswith("assets"):
        return PlainTextResponse("Not Found", status_code=404)
    if os.path.isfile(_index_html):
        return _send_index_html()
    return PlainTextResponse("Not Found", status_code=404)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    log.info(f"Control panel cloud API starting host=0.0.0.0 port={port}")
    uvicorn.run(
        "control_panel.cloud.main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
    )
