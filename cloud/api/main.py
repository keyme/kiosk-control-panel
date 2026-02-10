#!/usr/bin/env python3
"""
Cloud API: FastAPI app, REST router, static JS serving. No Socket.IO.
Run with static root and port via env (see README). Entrypoint for uvicorn is control_panel.cloud.main:app.
"""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from starlette.staticfiles import StaticFiles

from control_panel.cloud.api import create_router

app = FastAPI(title="Control Panel Cloud")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(create_router(), prefix="/api")

# Static root: env CONTROL_PANEL_STATIC_ROOT or default cloud/web/dist (one level up from api/)
_default_static = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "dist")
_STATIC_ROOT = os.path.abspath(os.environ.get("CONTROL_PANEL_STATIC_ROOT", _default_static))

_index_html = os.path.join(_STATIC_ROOT, "index.html")
_assets_dir = os.path.join(_STATIC_ROOT, "assets")

if os.path.isdir(_assets_dir):
    app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")


def _send_index_html():
    return FileResponse(
        _index_html,
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/")
def root():
    if os.path.isfile(_index_html):
        return _send_index_html()
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
    uvicorn.run(
        "control_panel.cloud.main:app",
        host="0.0.0.0",
        port=port,
        reload=False,
    )
