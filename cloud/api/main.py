#!/usr/bin/env python3
"""
Cloud API: FastAPI app, REST router, static JS serving. WebSocket proxy to device.
Run with static root and port via env (see README). Entrypoint for uvicorn is control_panel.cloud.main:app.
"""
import asyncio
import datetime
import json
import logging
import os
import re
import ssl
import tempfile
import time
from typing import Any, Callable, Optional, Tuple

import boto3
import httpx

try:
    import resource  # POSIX-only (for ulimit)
except Exception:  # pragma: no cover
    resource = None  # type: ignore[assignment]

from control_panel.cloud.api.logging_config import setup_logging

setup_logging()

from contextlib import asynccontextmanager

import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.staticfiles import StaticFiles

from control_panel.cloud.api import create_auth_router, create_router
from control_panel.cloud.api.auth import (
    ANF_BASE_URL,
    API_ENV,
    get_user_identifier_for_token,
    PERMISSIONS_ADMIN_URL,
    validate_token_async,
    validate_permission_async,
)
from control_panel.cloud.api.ws_fleet_permissions import (
    FLEET_EVENTS_REQUIRING_PERMISSION,
    required_permission,
)
from control_panel.shared import (
    DEVICE_CERTS_BUCKET,
    WSS_SECRET_ID,
    WSS_CERTS_S3_PREFIX,
    WS_PORT,
    WS_PATH,
)

from control_panel.cloud.api import codex_app_server_client
from control_panel.cloud.api import device_log_client
from control_panel.cloud.api import log_analysis

log = logging.getLogger(__name__)

# Staging must not connect to deployed kiosks (close code and reason for frontend).
STG_DEPLOYED_CLOSE_CODE = 4403
STG_DEPLOYED_CLOSE_REASON = "Staging environment cannot connect to a deployed kiosk. Use production to connect to this kiosk."
PANEL_INFO_GATE_TIMEOUT_SEC = 8

# WebSocket connection counter (active connections proxied through this service).
_active_ws_connections = 0
_active_ws_connections_lock = asyncio.Lock()


async def _inc_active_ws_connections() -> None:
    global _active_ws_connections
    async with _active_ws_connections_lock:
        _active_ws_connections += 1


async def _dec_active_ws_connections() -> None:
    global _active_ws_connections
    async with _active_ws_connections_lock:
        if _active_ws_connections > 0:
            _active_ws_connections -= 1


async def _get_active_ws_connections() -> int:
    async with _active_ws_connections_lock:
        return int(_active_ws_connections)


def _read_int_file(path: str) -> Optional[int]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
        if raw == "" or raw.lower() == "max":
            return None
        return int(raw)
    except Exception:
        return None


def _ulimit_n() -> Optional[int]:
    try:
        if resource is None:
            return None
        soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)  # type: ignore[attr-defined]
        return int(soft)
    except Exception:
        return None


def _current_open_fds() -> Optional[int]:
    try:
        return len(os.listdir("/proc/self/fd"))
    except Exception:
        return None


def _memory_limit_bytes() -> Optional[int]:
    # cgroup v1 (as requested)
    v1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes"
    if os.path.exists(v1):
        val = _read_int_file(v1)
        return int(val) if isinstance(val, int) else None

    # cgroup v2 fallback (helps when running on modern distros)
    v2 = "/sys/fs/cgroup/memory.max"
    if os.path.exists(v2):
        val = _read_int_file(v2)
        return int(val) if isinstance(val, int) else None

    return None


def _memory_usage_bytes() -> Optional[int]:
    # Prefer /proc/self/status: VmRSS is resident set size (kB).
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    parts = line.split()
                    # Format: VmRSS: <value> kB
                    if len(parts) >= 2:
                        kb = int(parts[1])
                        return kb * 1024
                    break
    except Exception:
        pass

    # Fallback: /proc/self/statm resident pages * page_size
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as f:
            parts = f.read().strip().split()
        if len(parts) >= 2:
            resident_pages = int(parts[1])
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            return resident_pages * page_size
    except Exception:
        return None
    return None


def _make_warning(message: str, recommendation: str) -> dict[str, str]:
    return {"message": message, "recommendation": recommendation}


_RECOMMEND_ULIMIT = (
    "Increase file descriptor limit.\n"
    "For Docker:\n"
    "  --ulimit nofile=200000:200000\n"
    "For Kubernetes:\n"
    "  Set container runtime ulimit or configure via node limits.\n"
)

_RECOMMEND_CONNTRACK = (
    "Increase conntrack limit:\n"
    "  sysctl -w net.netfilter.nf_conntrack_max=262144\n"
    "And persist in /etc/sysctl.conf\n"
)

_RECOMMEND_MEMORY = (
    "Increase pod memory limit in Kubernetes:\n"
    "resources:\n"
    "  limits:\n"
    "    memory: 1Gi\n"
)

_RECOMMEND_ACTIVE_WS = (
    "Reduce active WebSocket connections or increase the file descriptor limit.\n"
    "If connections are unexpectedly high, check for leaked/idle clients and enforce timeouts.\n"
    "For Docker:\n"
    "  --ulimit nofile=200000:200000\n"
    "For Kubernetes:\n"
    "  Set container runtime ulimit or configure via node limits.\n"
)

# Static root: env CONTROL_PANEL_STATIC_ROOT or default cloud/web/dist
_default_static = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "dist")
_STATIC_ROOT = os.path.abspath(os.environ.get("CONTROL_PANEL_STATIC_ROOT", _default_static))
_index_html = os.path.join(_STATIC_ROOT, "index.html")
_assets_dir = os.path.join(_STATIC_ROOT, "assets")


def _request_line_safe(path: str, query: str) -> str:
    """Path + query with token= redacted for access log."""
    if not query:
        return path
    safe = re.sub(r"token=[^&\s]+", "token=REDACTED", query, flags=re.IGNORECASE)
    return f"{path}?{safe}"


class _RestApiLogMiddleware(BaseHTTPMiddleware):
    """Info-log every REST API request for debuggability. Token never logged. No log for GET /api/status when 200."""

    async def dispatch(self, request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/api"):
            if request.url.path == "/api/status" and response.status_code == 200:
                pass  # skip log for probe to avoid noise
            else:
                path_safe = _request_line_safe(request.url.path, request.url.query)
                log.info(f"REST API {request.method} {path_safe}")
        return response


class _AccessLogMiddleware(BaseHTTPMiddleware):
    """Log every HTTP request (and WebSocket upgrade). Token is never logged. No log for GET /api/status when 200."""

    async def dispatch(self, request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        if request.url.path == "/api/status" and response.status_code == 200:
            pass  # skip log for probe to avoid noise
        else:
            duration = time.perf_counter() - start
            client = request.client or ("?", "?")
            client_addr = f"{client[0]}:{client[1]}"
            path_safe = _request_line_safe(request.url.path, request.url.query)
            log.info(
                f'{client_addr} - "{request.method} {path_safe}" {response.status_code}',
                extra={
                    "duration": duration,
                    "client": client_addr,
                    "path": path_safe,
                    "method": request.method,
                },
            )
        return response


class _AuditLogMiddleware(BaseHTTPMiddleware):
    """Log authenticated API requests with user identity for audit. No log for /api/login, /api/logout, /api/status."""

    async def dispatch(self, request, call_next):
        token = (request.headers.get("KEYME-TOKEN") or "").strip()
        response = await call_next(request)
        path = request.url.path
        if not path.startswith("/api"):
            return response
        if path in ("/api/login", "/api/logout", "/api/status"):
            return response
        user_id = get_user_identifier_for_token(token)
        path_safe = _request_line_safe(request.url.path, request.url.query)
        log.info(f"User {user_id or '?'}: {request.method} {path_safe} {response.status_code}")
        return response


@asynccontextmanager
async def _lifespan(app: FastAPI):
    log.info(
        f"Control panel cloud API app loaded static_root={_STATIC_ROOT} API_ENV={API_ENV} ANF_BASE_URL={ANF_BASE_URL}"
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        app.state.httpx_client = client
        yield


app = FastAPI(title="Control Panel Cloud", lifespan=_lifespan)
app.add_middleware(_AuditLogMiddleware)  # outermost: after call_next cache may be populated
app.add_middleware(_RestApiLogMiddleware)
app.add_middleware(_AccessLogMiddleware)
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


@app.get("/health")
async def health() -> dict[str, Any]:
    ulimit_n = _ulimit_n()
    fs_file_max = _read_int_file("/proc/sys/fs/file-max")
    nf_conntrack_max = _read_int_file("/proc/sys/net/netfilter/nf_conntrack_max")
    memory_limit_bytes = _memory_limit_bytes()

    active_websocket_connections = await _get_active_ws_connections()
    current_open_fds = _current_open_fds()
    memory_usage_bytes = _memory_usage_bytes()

    warnings: list[dict[str, str]] = []
    if isinstance(ulimit_n, int) and ulimit_n < 10_000:
        warnings.append(
            _make_warning(
                message=f"ulimit_n is low ({ulimit_n}); recommended >= 10000.",
                recommendation=_RECOMMEND_ULIMIT,
            )
        )
    if isinstance(nf_conntrack_max, int) and nf_conntrack_max < 100_000:
        warnings.append(
            _make_warning(
                message=f"nf_conntrack_max is low ({nf_conntrack_max}); recommended >= 100000.",
                recommendation=_RECOMMEND_CONNTRACK,
            )
        )
    if isinstance(memory_limit_bytes, int) and memory_limit_bytes < 512 * 1024 * 1024:
        warnings.append(
            _make_warning(
                message=(
                    f"memory_limit_bytes is low ({memory_limit_bytes}); recommended >= 536870912 (512MB)."
                ),
                recommendation=_RECOMMEND_MEMORY,
            )
        )
    if isinstance(ulimit_n, int) and ulimit_n > 0:
        if active_websocket_connections > int(0.8 * ulimit_n):
            warnings.append(
                _make_warning(
                    message=(
                        "active_websocket_connections is above 80% of ulimit_n "
                        f"({active_websocket_connections} / {ulimit_n})."
                    ),
                    recommendation=_RECOMMEND_ACTIVE_WS,
                )
            )

    status = "warning" if warnings else "ok"
    return {
        "status": status,
        "limits": {
            "ulimit_n": ulimit_n,
            "fs_file_max": fs_file_max,
            "nf_conntrack_max": nf_conntrack_max,
            "memory_limit_bytes": memory_limit_bytes,
        },
        "usage": {
            "current_open_fds": current_open_fds,
            "memory_usage_bytes": memory_usage_bytes,
            "active_websocket_connections": active_websocket_connections,
        },
        "warnings": warnings,
    }


@app.get("/api/status")
async def status() -> dict[str, Any]:
    """Unauthenticated probe endpoint: 200 if critical deps (e.g. WSS API key) are present, else 503. No log on 200."""
    wss_key = _get_wss_api_key()
    if wss_key is None:
        log.error("status check failed: WSS API key missing")
        return JSONResponse(
            {"status": "error", "missing": "WSS API key"},
            status_code=503,
        )
    return {"status": "ok"}


# In-memory cache: fqdn -> PEM string (device public cert from S3).
_device_cert_cache: dict[str, str] = {}
# In-memory cache: fqdn -> SSLContext (reused for device WSS connections).
_device_ssl_ctx_cache: dict[str, ssl.SSLContext] = {}

# In-memory cache for WSS API key (cloud-to-device auth). Fetched from AWS Secrets Manager.
_wss_api_key: Optional[str] = None


def _get_wss_api_key() -> Optional[str]:
    """Return WSS API key from in-memory cache or AWS Secrets Manager. On error returns None."""
    global _wss_api_key
    if _wss_api_key is not None:
        return _wss_api_key
    try:
        client = boto3.client("secretsmanager", region_name="us-east-1")
        response = client.get_secret_value(SecretId=WSS_SECRET_ID)
        secret_str = (response.get("SecretString") or "").strip()
        if not secret_str:
            log.warning("WSS secret SecretString is empty")
            return None
        _wss_api_key = secret_str
        return _wss_api_key
    except Exception as e:
        log.warning(f"WSS API key fetch failed: {e}")
        return None


def _get_device_cert_from_s3(host_fqdn: str, kiosk_name_upper: str) -> Optional[str]:
    """Fetch device public cert from S3. Returns PEM string or None on 404/error."""
    key = f"{WSS_CERTS_S3_PREFIX}/{kiosk_name_upper}/{host_fqdn}.crt"
    log.info(f"Downloading WSS cert from S3 bucket={DEVICE_CERTS_BUCKET} key={key}")
    try:
        s3 = boto3.client("s3")
        resp = s3.get_object(Bucket=DEVICE_CERTS_BUCKET, Key=key)
        log.info(f"WSS cert downloaded from S3 bucket={DEVICE_CERTS_BUCKET} key={key}")
        return resp["Body"].read().decode()
    except Exception as e:
        log.warning(f"Device cert S3 fetch failed bucket={DEVICE_CERTS_BUCKET} key={key} error={e}")
        return None


def _device_ws_backend(device_host: str) -> Tuple[str, str, str, Optional[ssl.SSLContext], bool, Optional[str]]:
    """Resolve device to (wss_url, host_fqdn, kiosk_name_upper, ssl_ctx, used_cert, backend_fail_reason). used_cert True if cert from S3/cache. backend_fail_reason set when backend_url is empty (e.g. 'device_cert_unavailable')."""
    host = (device_host or "").strip()
    if not host:
        return "", "", "", None, False, None
    host_only = re.sub(r"^(https?://)?([^/]+).*", r"\2", host, flags=re.IGNORECASE)
    with_domain = (
        f"{host_only}.keymekiosk.com" if "." not in host_only else host_only
    )
    url = f"wss://{with_domain}:{WS_PORT}{WS_PATH}"
    kiosk_name_upper = host_only.upper()
    pem = _device_cert_cache.get(with_domain)
    if pem is None:
        pem = _get_device_cert_from_s3(with_domain, kiosk_name_upper)
        if pem is not None:
            _device_cert_cache[with_domain] = pem
    if pem is not None:
        ctx = _device_ssl_ctx_cache.get(with_domain)
        if ctx is None:
            ctx = ssl.create_default_context()
            ctx.load_verify_locations(cadata=pem)
            _device_ssl_ctx_cache[with_domain] = ctx
        return url, with_domain, kiosk_name_upper, ctx, True, None
    log.error(f"No device cert for {with_domain}, refusing to connect")
    return "", with_domain, kiosk_name_upper, None, False, "device_cert_unavailable"


def _device_connection_failure_reason(exc: BaseException) -> str:
    """Classify device connection failure: 'ssl', 'refused' (port open but nothing listening), or 'port' (timeout/unreachable)."""
    if isinstance(exc, ssl.SSLError):
        return "ssl"
    msg = str(exc).lower()
    if "certificate" in msg or "ssl" in msg or "tls" in msg:
        return "ssl"
    errno = getattr(exc, "errno", None)
    if errno == 111:  # ECONNREFUSED: port reachable but control_panel not listening
        return "refused"
    if "connection refused" in msg:
        return "refused"
    if isinstance(exc, TimeoutError):
        return "port"
    if errno is not None and errno in (110, 113):  # ETIMEDOUT, EHOSTUNREACH
        return "port"
    if "timed out" in msg or "name or service not known" in msg:
        return "port"
    return "port"


async def _handle_connect_failure_retry(
    websocket: WebSocket,
    device: str,
    backend_url: str,
    host_fqdn: str,
    kiosk_name_upper: str,
    session: "WSProxySession",
) -> bool:
    """
    On connection failure: invalidate cache, refetch cert from S3, retry once.
    Returns True if the failure was handled (retry succeeded or we closed the client); False to re-raise.
    """
    _device_cert_cache.pop(host_fqdn, None)
    _device_ssl_ctx_cache.pop(host_fqdn, None)
    refetch_pem = _get_device_cert_from_s3(host_fqdn, kiosk_name_upper)
    if refetch_pem is None:
        return False
    _device_cert_cache[host_fqdn] = refetch_pem
    refetch_ctx = ssl.create_default_context()
    refetch_ctx.load_verify_locations(cadata=refetch_pem)
    log.info(f"ws proxy refetched device cert from S3, retrying device={device}")
    try:
        await session.run_with_refetched_cert(refetch_ctx)
    except Exception as retry_error:
        log.exception(
            f"ws proxy connect to device failed after retry device={device} url={backend_url}"
        )
        try:
            reason = _device_connection_failure_reason(retry_error)
            await websocket.close(code=1011, reason=reason)
        except Exception:
            pass
        return True
    try:
        await websocket.close()
    except Exception:
        pass
    return True


class WSProxySession:
    """Single WebSocket proxy session: client <-> device. All deps passed via constructor."""

    def __init__(
        self,
        websocket: WebSocket,
        backend_url: str,
        ssl_ctx: Optional[ssl.SSLContext],
        used_cert: bool,
        get_wss_key: Callable[[], Optional[str]],
        client: httpx.AsyncClient,
        token: str,
        user_identifier: str,
        device: str,
        t_start: float,
        token_ms: float,
        backend_ms: float,
        accept_ms: float,
    ):
        self.websocket = websocket
        self.backend_url = backend_url
        self.ssl_ctx = ssl_ctx
        self.used_cert = used_cert
        self.get_wss_key = get_wss_key
        self.client = client
        self.token = token
        self.user_identifier = user_identifier
        self.device = device
        self.t_start = t_start
        self.token_ms = token_ms
        self.backend_ms = backend_ms
        self.accept_ms = accept_ms

    async def run(self) -> None:
        await self._run_with_ctx(self.ssl_ctx, self.used_cert)

    async def run_with_refetched_cert(self, refetch_ctx: ssl.SSLContext) -> None:
        await self._run_with_ctx(refetch_ctx, True)

    async def _run_with_ctx(
        self, ssl_ctx: Optional[ssl.SSLContext], used_cert: bool
    ) -> None:
        t_key = time.perf_counter()
        wss_key = self.get_wss_key()
        if wss_key is None:
            await self.websocket.close(code=4500, reason="server config")
            return
        wss_key_ms = (time.perf_counter() - t_key) * 1000
        log.debug(f"ws_proxy timing wss_key_ms={wss_key_ms:.2f}")
        connect_kwargs: dict = {"ssl": ssl_ctx} if ssl_ctx is not None else {}
        connect_kwargs["additional_headers"] = {"Authorization": "Bearer " + wss_key}
        user_email_header = (self.user_identifier or "")[:256].strip() or "?"
        connect_kwargs["additional_headers"]["X-User-Email"] = user_email_header
        connect_kwargs["max_size"] = 10 * 1024 * 1024  # 10 MiB
        t_connect = time.perf_counter()
        async with websockets.connect(self.backend_url, **connect_kwargs) as device_ws:
            device_connect_ms = (time.perf_counter() - t_connect) * 1000
            total_ms = (time.perf_counter() - self.t_start) * 1000
            log.debug(
                f"ws_proxy timing device_connect_ms={device_connect_ms:.2f}"
            )
            timings = " ".join(
                f"{k}={v:.0f}"
                for k, v in [
                    ("total_ms", total_ms),
                    ("token_ms", self.token_ms),
                    ("backend_ms", self.backend_ms),
                    ("accept_ms", self.accept_ms),
                    ("wss_key_ms", wss_key_ms),
                    ("device_connect_ms", device_connect_ms),
                ]
            )
            log.info(f"ws_proxy connection established device={self.device} {timings}")
            log.info(f"User {self.user_identifier}: WS connect device={self.device}")
            if used_cert:
                log.info(
                    f"ws proxy connected to device device={self.device} url={self.backend_url} TLS verification successful"
                )
            else:
                log.info(
                    f"ws proxy connected to device device={self.device} url={self.backend_url}"
                )
            device_message_buffer = await self._run_staging_gate(device_ws)
            if device_message_buffer is None:
                return
            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(self._client_to_device(device_ws)),
                    asyncio.create_task(self._device_to_client(device_ws, device_message_buffer)),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

    async def _run_staging_gate(
        self, device_ws: Any
    ) -> Optional[list[str]]:
        device_message_buffer: list[str] = []
        if API_ENV != "stg":
            return device_message_buffer
        await device_ws.send(json.dumps({"id": 0, "event": "get_panel_info"}))
        try:
            while True:
                msg_raw = await asyncio.wait_for(
                    device_ws.recv(), timeout=PANEL_INFO_GATE_TIMEOUT_SEC
                )
                try:
                    msg = json.loads(msg_raw)
                except (json.JSONDecodeError, TypeError):
                    device_message_buffer.append(msg_raw)
                    continue
                if isinstance(msg, dict) and msg.get("id") == 0:
                    if (
                        msg.get("success")
                        and isinstance(msg.get("data"), dict)
                        and msg["data"].get("deployed") is True
                    ):
                        log.info(
                            f"User {self.user_identifier}: WS deployed true (kiosk deployed), closing connection"
                        )
                        await self.websocket.close(
                            code=STG_DEPLOYED_CLOSE_CODE,
                            reason=STG_DEPLOYED_CLOSE_REASON,
                        )
                        return None
                    device_message_buffer.append(msg_raw)
                    break
                device_message_buffer.append(msg_raw)
        except asyncio.TimeoutError:
            log.warning(
                f"ws_proxy stg gate: get_panel_info timeout device={self.device}, allowing connection"
            )
        return device_message_buffer

    async def _client_to_device(self, device_ws: Any) -> None:
        try:
            while True:
                data = await self.websocket.receive_text()
                try:
                    msg = json.loads(data)
                except (json.JSONDecodeError, TypeError):
                    await device_ws.send(data)
                    continue
                event = msg.get("event") if isinstance(msg, dict) else None
                log.info(
                    f"User {self.user_identifier}: WS event={event} device={self.device}"
                )
                if event not in FLEET_EVENTS_REQUIRING_PERMISSION:
                    await device_ws.send(data)
                    continue
                slug = required_permission(event)
                if slug is None:
                    await device_ws.send(data)
                    continue
                granted, perm_user_id = await validate_permission_async(
                    self.client, self.token, slug
                )
                if not granted:
                    if perm_user_id:
                        err_msg = (
                            f"User {perm_user_id} does not have permission '{slug}'. "
                            f"You can add the permission at {PERMISSIONS_ADMIN_URL}"
                        )
                    else:
                        err_msg = (
                            f"Permission denied: '{slug}' required. "
                            f"You can add the permission at {PERMISSIONS_ADMIN_URL}"
                        )
                    err_response = json.dumps({
                        "id": msg.get("id"),
                        "success": False,
                        "errors": [err_msg],
                    })
                    await self.websocket.send_text(err_response)
                    continue
                await device_ws.send(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            log.warning(f"ws proxy client_to_device: {e}")

    async def _device_to_client(
        self, device_ws: Any, device_message_buffer: list[str]
    ) -> None:
        try:
            for message in device_message_buffer:
                await self.websocket.send_text(message)
            async for message in device_ws:
                await self.websocket.send_text(message)
        except Exception as e:
            log.warning(f"ws proxy device_to_client: {e}")


_AUTH_FIRST_MESSAGE_TIMEOUT = 10.0  # seconds to wait for auth message after connect


@app.websocket("/ws")
async def ws_proxy(websocket: WebSocket):
    """Proxy WebSocket to device. Auth via first message: { event: 'auth', token, device } (no token in URL)."""
    t_start = time.perf_counter()
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=_AUTH_FIRST_MESSAGE_TIMEOUT)
    except asyncio.TimeoutError:
        await websocket.close(code=4401, reason="auth required")
        return
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        await websocket.close(code=4401, reason="auth required")
        return
    if not isinstance(msg, dict) or msg.get("event") != "auth":
        await websocket.close(code=4401, reason="auth required")
        return
    token = (msg.get("token") or "").strip()
    device = (msg.get("device") or "").strip()
    if not token:
        await websocket.close(code=4401, reason="missing token")
        return
    if not device:
        await websocket.close(code=4400, reason="missing device")
        return
    app = websocket.scope["app"]
    client = app.state.httpx_client
    try:
        user_data = await validate_token_async(client, token)
    except HTTPException:
        log.info("ws proxy token validation failed")
        await websocket.close(code=4401, reason="invalid token")
        return
    raw_uid = (user_data.get("email") or user_data.get("user_id")) or get_user_identifier_for_token(token) or "?"
    if asyncio.iscoroutine(raw_uid):
        user_identifier = (await raw_uid) or "?"
    else:
        user_identifier = raw_uid or "?"
    user_identifier = str(user_identifier)[:256].strip() or "?"
    t_after_token = time.perf_counter()
    token_ms = (t_after_token - t_start) * 1000
    log.debug(f"ws_proxy timing token_validation_ms={token_ms:.2f}")
    backend_url, host_fqdn, kiosk_name_upper, ssl_ctx, used_cert, backend_fail_reason = _device_ws_backend(device)
    if not backend_url:
        await websocket.close(code=4400, reason=backend_fail_reason or "invalid device")
        return
    t_after_backend = time.perf_counter()
    backend_ms = (t_after_backend - t_after_token) * 1000
    log.debug(f"ws_proxy timing device_backend_ms={backend_ms:.2f}")
    await _inc_active_ws_connections()
    t_after_accept = time.perf_counter()
    accept_ms = (t_after_accept - t_after_backend) * 1000
    log.debug(f"ws_proxy timing accept_ms={accept_ms:.2f}")
    await websocket.send_text(json.dumps({"event": "auth_ok"}))

    session = WSProxySession(
        websocket=websocket,
        backend_url=backend_url,
        ssl_ctx=ssl_ctx,
        used_cert=used_cert,
        get_wss_key=_get_wss_api_key,
        client=client,
        token=token,
        user_identifier=user_identifier,
        device=device,
        t_start=t_start,
        token_ms=token_ms,
        backend_ms=backend_ms,
        accept_ms=accept_ms,
    )

    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    except TimeoutError as e:
        log.error(
            f"ws proxy connect timed out: url={backend_url} port={WS_PORT} error={e}"
        )
        handled = await _handle_connect_failure_retry(
            websocket,
            device,
            backend_url,
            host_fqdn,
            kiosk_name_upper,
            session,
        )
        if handled:
            return
        try:
            reason = _device_connection_failure_reason(e)
            await websocket.close(code=1011, reason=reason)
        except Exception:
            pass
    except Exception as e:
        log.exception(
            f"ws proxy connect to device failed device={device} url={backend_url} port={WS_PORT}"
        )
        handled = await _handle_connect_failure_retry(
            websocket,
            device,
            backend_url,
            host_fqdn,
            kiosk_name_upper,
            session,
        )
        if handled:
            return
        try:
            reason = _device_connection_failure_reason(e)
            await websocket.close(code=1011, reason=reason)
        except Exception:
            pass
    else:
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        await _dec_active_ws_connections()


@app.websocket("/ai")
async def ws_ai(websocket: WebSocket):
    """AI log analysis WebSocket. Auth via first message: { event: 'auth', token } (no token in URL). Events: ai_get_identifiers, ai_log_session, ai_turn."""
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=_AUTH_FIRST_MESSAGE_TIMEOUT)
    except asyncio.TimeoutError:
        await websocket.close(code=4401, reason="auth required")
        return
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        await websocket.close(code=4401, reason="auth required")
        return
    if not isinstance(msg, dict) or msg.get("event") != "auth":
        await websocket.close(code=4401, reason="auth required")
        return
    token = (msg.get("token") or "").strip()
    if not token:
        await websocket.close(code=4401, reason="missing token")
        return
    app = websocket.scope["app"]
    client = app.state.httpx_client
    try:
        await validate_token_async(client, token)
    except HTTPException:
        log.info("ws_ai token validation failed")
        await websocket.close(code=4401, reason="invalid token")
        return
    await websocket.send_text(json.dumps({"event": "auth_ok"}))
    log.info("ws_ai connection accepted")

    codex_ws = None
    thread_to_workspace: dict[str, str] = {}

    def _reply(rid: Any, success: bool, result: Any = None, error: str = "") -> dict:
        out = {"id": rid, "success": success}
        if success:
            out["result"] = result
        else:
            out["error"] = error or "Request failed"
        return out

    async def _send_reply(rid: Any, success: bool, result: Any = None, error: str = "") -> None:
        await websocket.send_text(json.dumps(_reply(rid, success, result=result, error=error)))

    async def _send_stream_delta(rid: Any, delta: str) -> None:
        await websocket.send_text(json.dumps({"id": rid, "stream_delta": delta}))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                log.warning("ws_ai invalid JSON")
                await _send_reply(None, False, error="Invalid JSON")
                continue
            if not isinstance(msg, dict):
                await _send_reply(None, False, error="Message must be an object")
                continue
            rid = msg.get("id")
            event = msg.get("event")
            data = msg.get("data") if isinstance(msg.get("data"), dict) else {}
            log.info("ws_ai event=%s id=%s", event, rid)

            if event == "ai_get_identifiers":
                question = (data.get("question") or "").strip()
                if not question:
                    await _send_reply(rid, False, error="question is required")
                    continue
                log.info("ws_ai ai_get_identifiers question_len=%s", len(question))
                try:
                    workspace = log_analysis.get_empty_workspace()
                    result = await asyncio.to_thread(
                        log_analysis.extract_identifiers_json,
                        workspace,
                        question,
                        60,
                    )
                except Exception as e:
                    log.exception("ai_get_identifiers extract_identifiers_json failed")
                    await _send_reply(rid, False, error=str(e))
                    continue
                if result.get("success"):
                    identifiers = result.get("identifiers") or []
                    log.info("ws_ai ai_get_identifiers success identifiers=%s", identifiers)
                    await _send_reply(rid, True, result={"identifiers": identifiers})
                else:
                    err_msg = result.get("error_message") or "Could not extract identifiers."
                    log.info("ws_ai ai_get_identifiers failed error_message=%s", err_msg)
                    await _send_reply(rid, False, error=err_msg)
                continue

            if event == "ai_log_session":
                kiosk_name = (data.get("kiosk_name") or "").strip()
                approximate_date = (data.get("approximate_date") or "").strip()
                identifiers = data.get("identifiers")
                first_question = (data.get("first_question") or "").strip()
                if not kiosk_name or not approximate_date or not first_question:
                    await _send_reply(
                        rid,
                        False,
                        error="kiosk_name, approximate_date, and first_question are required",
                    )
                    continue
                if not isinstance(identifiers, list) or not identifiers:
                    await _send_reply(rid, False, error="identifiers must be a non-empty list")
                    continue
                identifiers = [str(x).strip() for x in identifiers if x is not None and str(x).strip()]
                if not identifiers:
                    await _send_reply(rid, False, error="identifiers must be a non-empty list")
                    continue

                log.info(
                    "ws_ai ai_log_session kiosk_name=%s approximate_date=%s identifiers=%s first_question_len=%s",
                    kiosk_name,
                    approximate_date,
                    identifiers,
                    len(first_question),
                )

                backend_url, _, _, ssl_ctx, _, backend_fail_reason = _device_ws_backend(kiosk_name)
                if not backend_url:
                    log.warning("ws_ai ai_log_session invalid device kiosk_name=%s reason=%s", kiosk_name, backend_fail_reason)
                    await _send_reply(rid, False, error=backend_fail_reason or "invalid device")
                    continue
                wss_key = _get_wss_api_key()
                if not wss_key:
                    log.warning("ws_ai ai_log_session WSS API key missing")
                    await _send_reply(rid, False, error="server config")
                    continue

                date_hint_start = approximate_date
                date_hint_end = approximate_date
                if "T" not in approximate_date and approximate_date:
                    parts = approximate_date.split("-")
                    if len(parts) >= 3:
                        try:
                            y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
                            next_d = datetime.date(y, m, d) + datetime.timedelta(days=1)
                            date_hint_end = next_d.isoformat()
                        except (ValueError, TypeError):
                            pass

                log.info(
                    "ws_ai ai_log_session search_log backend_url=%s date_hint_start=%s date_hint_end=%s",
                    backend_url,
                    date_hint_start,
                    date_hint_end,
                )
                central_datetime = await device_log_client.search_log(
                    backend_url,
                    ssl_ctx,
                    wss_key,
                    queries=identifiers,
                    date_hint_start=date_hint_start or None,
                    date_hint_end=date_hint_end or None,
                )
                if not central_datetime:
                    log.warning(
                        "ws_ai ai_log_session search_log returned no datetime (no match) kiosk_name=%s identifiers=%s date_hint=%s..%s",
                        kiosk_name,
                        identifiers,
                        date_hint_start,
                        date_hint_end,
                    )
                    await _send_reply(rid, False, error="No log found for the given identifiers and date")
                    continue
                log.info("ws_ai ai_log_session search_log central_datetime=%s", central_datetime)

                fd, temp_path = tempfile.mkstemp(suffix=".log", prefix="log_analysis_")
                try:
                    os.close(fd)
                    log.info("ws_ai ai_log_session get_log_around_datetime central_datetime=%s", central_datetime)
                    ok = await device_log_client.get_log_around_datetime(
                        backend_url,
                        ssl_ctx,
                        wss_key,
                        central_datetime,
                        output_path=temp_path,
                    )
                    if not ok:
                        log.warning("ws_ai ai_log_session get_log_around_datetime failed")
                        await _send_reply(rid, False, error="Failed to fetch log from device")
                        continue
                    log.info("ws_ai ai_log_session get_log_around_datetime ok")
                    with open(temp_path, "r", encoding="utf-8", errors="replace") as f:
                        lines = [line.rstrip("\n\r") for line in f]
                finally:
                    try:
                        os.remove(temp_path)
                    except OSError:
                        pass

                # Each session gets a fresh workspace and fresh log fetch; no reuse of previous
                # session's logs (thread_to_workspace is per-connection, each thread has its own cwd).
                workspace_path = log_analysis.create_workspace()
                log.info("ws_ai ai_log_session workspace_path=%s lines=%s", workspace_path, len(lines))
                try:
                    log_analysis.write_all_log(workspace_path, lines)
                    log_analysis.ensure_codex_context(workspace_path)
                except Exception as e:
                    log_analysis.cleanup_workspace(workspace_path)
                    log.exception("ai_log_session write_all_log failed")
                    await _send_reply(rid, False, error=str(e))
                    continue

                if codex_ws is None:
                    try:
                        log.info("ws_ai ai_log_session connecting to Codex app-server")
                        codex_ws = await codex_app_server_client.connect_and_handshake()
                        log.info("ws_ai ai_log_session Codex app-server connected")
                    except Exception as e:
                        log_analysis.cleanup_workspace(workspace_path)
                        log.exception("ai_log_session Codex connect failed")
                        await _send_reply(rid, False, error=str(e))
                        continue

                try:
                    log.info("ws_ai ai_log_session thread_start cwd=%s", workspace_path)
                    thread_id = await codex_app_server_client.thread_start(codex_ws, workspace_path)
                    log.info("ws_ai ai_log_session thread_start thread_id=%s", thread_id)
                except Exception as e:
                    log_analysis.cleanup_workspace(workspace_path)
                    log.exception("ai_log_session thread_start failed")
                    await _send_reply(rid, False, error=str(e))
                    continue

                first_prompt = first_question + "\n\nThe log file to analyze is ./all.log"

                async def _on_delta_log_session(d: str) -> None:
                    await _send_stream_delta(rid, d)

                try:
                    log.info("ws_ai ai_log_session turn_start thread_id=%s", thread_id)
                    result_text = await codex_app_server_client.turn_start(
                        codex_ws, thread_id, first_prompt, on_delta=_on_delta_log_session
                    )
                    log.info("ws_ai ai_log_session turn_start done result_len=%s", len(result_text or ""))
                except Exception as e:
                    log_analysis.cleanup_workspace(workspace_path)
                    log.exception("ai_log_session turn_start failed")
                    await _send_reply(rid, False, error=str(e))
                    continue

                thread_to_workspace[thread_id] = workspace_path
                await _send_reply(
                    rid,
                    True,
                    result={"thread_id": thread_id, "result": result_text or ""},
                )
                continue

            if event == "ai_turn":
                thread_id = (data.get("thread_id") or "").strip()
                text = (data.get("text") or "").strip()
                if not thread_id:
                    await _send_reply(rid, False, error="thread_id is required")
                    continue
                if thread_id not in thread_to_workspace:
                    log.warning("ws_ai ai_turn unknown thread_id=%s", thread_id)
                    await _send_reply(rid, False, error="unknown thread_id")
                    continue
                if not codex_ws:
                    await _send_reply(rid, False, error="no active session")
                    continue
                async def _on_delta_turn(d: str) -> None:
                    await _send_stream_delta(rid, d)

                try:
                    log.info("ws_ai ai_turn thread_id=%s text_len=%s", thread_id, len(text))
                    result_text = await codex_app_server_client.turn_start(
                        codex_ws, thread_id, text, on_delta=_on_delta_turn
                    )
                    log.info("ws_ai ai_turn done result_len=%s", len(result_text or ""))
                except Exception as e:
                    log.exception("ai_turn turn_start failed")
                    await _send_reply(rid, False, error=str(e))
                    continue
                await _send_reply(rid, True, result=result_text or "")
                continue

            await _send_reply(rid, False, error=f"unknown event: {event!r}")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("ws_ai error: %s", e)
    finally:
        if codex_ws is not None:
            try:
                await codex_ws.close()
            except Exception:
                pass
        for wp in thread_to_workspace.values():
            log_analysis.cleanup_workspace(wp)
        thread_to_workspace.clear()


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
        access_log=False,
    )
