#!/usr/bin/env python3
"""
Cloud API: FastAPI app, REST router, static JS serving. WebSocket proxy to device.
Run with static root and port via env (see README). Entrypoint for uvicorn is control_panel.cloud.main:app.
"""
import asyncio
import json
import logging
import os
import re
import ssl
import time
from typing import Any, Optional, Tuple

import boto3
import httpx

try:
    import resource  # POSIX-only (for ulimit)
except Exception:  # pragma: no cover
    resource = None  # type: ignore[assignment]

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
        response = await call_next(request)
        if request.url.path == "/api/status" and response.status_code == 200:
            pass  # skip log for probe to avoid noise
        else:
            client = request.client or ("?", "?")
            client_addr = f"{client[0]}:{client[1]}"
            path_safe = _request_line_safe(request.url.path, request.url.query)
            log.info(f'{client_addr} - "{request.method} {path_safe}" {response.status_code}')
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
        log.info("User %s: %s %s %s", user_id or "?", request.method, path_safe, response.status_code)
        return response


@asynccontextmanager
async def _lifespan(app: FastAPI):
    log.info(
        "Control panel cloud API app loaded static_root=%s API_ENV=%s ANF_BASE_URL=%s",
        _STATIC_ROOT,
        API_ENV,
        ANF_BASE_URL,
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


def _device_ws_backend(device_host: str) -> Tuple[str, str, str, Optional[ssl.SSLContext], bool]:
    """Resolve device to (wss_url, host_fqdn, kiosk_name_upper, ssl_ctx, used_cert). used_cert True if cert from S3/cache."""
    host = (device_host or "").strip()
    if not host:
        return "", "", "", None, False
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
        return url, with_domain, kiosk_name_upper, ctx, True
    log.warning(f"No device cert for {with_domain}, using unverified TLS")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return url, with_domain, kiosk_name_upper, ctx, False


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


@app.websocket("/ws")
async def ws_proxy(websocket: WebSocket):
    """Proxy WebSocket to device. Query params: 'device' (required), 'token' (required, KeyMe)."""
    t_start = time.perf_counter()
    token = (websocket.query_params.get("token") or "").strip()
    if not token:
        await websocket.close(code=4401, reason="missing token")
        return
    app = websocket.scope["app"]
    client = app.state.httpx_client
    try:
        user_data = await validate_token_async(client, token)
    except HTTPException:
        log.info("ws proxy token validation failed")
        await websocket.close(code=4401, reason="invalid token")
        return
    user_identifier = (user_data.get("email") or user_data.get("user_id")) or get_user_identifier_for_token(token) or "?"
    t_after_token = time.perf_counter()
    token_ms = (t_after_token - t_start) * 1000
    log.debug("ws_proxy timing token_validation_ms=%.2f", token_ms)
    device = websocket.query_params.get("device") or ""
    device = device.strip()
    if not device:
        await websocket.close(code=4400, reason="missing device")
        return
    backend_url, host_fqdn, kiosk_name_upper, ssl_ctx, used_cert = _device_ws_backend(device)
    if not backend_url:
        await websocket.close(code=4400, reason="invalid device")
        return
    t_after_backend = time.perf_counter()
    backend_ms = (t_after_backend - t_after_token) * 1000
    log.debug("ws_proxy timing device_backend_ms=%.2f", backend_ms)
    await websocket.accept()
    await _inc_active_ws_connections()
    t_after_accept = time.perf_counter()
    accept_ms = (t_after_accept - t_after_backend) * 1000
    log.debug("ws_proxy timing accept_ms=%.2f", accept_ms)

    async def _run_proxy(backend_url: str, ssl_ctx: Optional[ssl.SSLContext], used_cert: bool) -> None:
        t_key = time.perf_counter()
        wss_key = _get_wss_api_key()
        if wss_key is None:
            await websocket.close(code=4500, reason="server config")
            return
        wss_key_ms = (time.perf_counter() - t_key) * 1000
        log.debug("ws_proxy timing wss_key_ms=%.2f", wss_key_ms)
        connect_kwargs: dict = {"ssl": ssl_ctx} if ssl_ctx is not None else {}
        connect_kwargs["additional_headers"] = {"Authorization": "Bearer " + wss_key}
        connect_kwargs["max_size"] = 10 * 1024 * 1024  # 10 MiB; device may send large take_image payloads
        t_connect = time.perf_counter()
        async with websockets.connect(backend_url, **connect_kwargs) as device_ws:
            device_connect_ms = (time.perf_counter() - t_connect) * 1000
            total_ms = (time.perf_counter() - t_start) * 1000
            log.debug("ws_proxy timing device_connect_ms=%.2f total_ms=%.2f", device_connect_ms, total_ms)
            log.info(
                "ws_proxy connection established device=%s total_ms=%.0f token_ms=%.0f backend_ms=%.0f accept_ms=%.0f wss_key_ms=%.0f device_connect_ms=%.0f",
                device,
                total_ms,
                token_ms,
                backend_ms,
                accept_ms,
                wss_key_ms,
                device_connect_ms,
            )
            log.info("User %s: WS connect device=%s", user_identifier, device)
            if used_cert:
                log.info(
                    f"ws proxy connected to device device={device} url={backend_url} TLS verification successful"
                )
            else:
                log.info(f"ws proxy connected to device device={device} url={backend_url}")

            # Messages read from device during gate phase (e.g. hello) to forward once proxy starts.
            device_message_buffer: list[str] = []

            # Limit stg to only connect to non-deployed kiosks
            if API_ENV == "stg":
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
                                log.info("User %s: WS deployed false, closing connection", user_identifier)
                                await websocket.close(
                                    code=STG_DEPLOYED_CLOSE_CODE,
                                    reason=STG_DEPLOYED_CLOSE_REASON,
                                )
                                return
                            device_message_buffer.append(msg_raw)
                            break
                        device_message_buffer.append(msg_raw)
                except asyncio.TimeoutError:
                    log.warning(
                        "ws_proxy stg gate: get_panel_info timeout device=%s, allowing connection",
                        device,
                    )

            async def client_to_device():
                try:
                    while True:
                        data = await websocket.receive_text()
                        try:
                            msg = json.loads(data)
                        except (json.JSONDecodeError, TypeError):
                            await device_ws.send(data)
                            continue
                        event = msg.get("event") if isinstance(msg, dict) else None
                        log.info("User %s: WS event=%s device=%s", user_identifier, event, device)
                        if event not in FLEET_EVENTS_REQUIRING_PERMISSION:
                            await device_ws.send(data)
                            continue
                        slug = required_permission(event)
                        if slug is None:
                            await device_ws.send(data)
                            continue
                        granted, perm_user_id = await validate_permission_async(
                            client, token, slug
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
                            await websocket.send_text(err_response)
                            continue
                        await device_ws.send(data)
                except WebSocketDisconnect:
                    pass
                except Exception as e:
                    log.warning(f"ws proxy client_to_device: {e}")

            async def device_to_client():
                try:
                    for message in device_message_buffer:
                        await websocket.send_text(message)
                    async for message in device_ws:
                        await websocket.send_text(message)
                except Exception as e:
                    log.warning(f"ws proxy device_to_client: {e}")

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

    try:
        await _run_proxy(backend_url, ssl_ctx, used_cert)
    except (TimeoutError, Exception) as first_error:
        # On connection failure: invalidate cache, refetch from S3, retry once (handles device replacement).
        _device_cert_cache.pop(host_fqdn, None)
        _device_ssl_ctx_cache.pop(host_fqdn, None)
        refetch_pem = _get_device_cert_from_s3(host_fqdn, kiosk_name_upper)
        if refetch_pem is not None:
            _device_cert_cache[host_fqdn] = refetch_pem
            refetch_ctx = ssl.create_default_context()
            refetch_ctx.load_verify_locations(cadata=refetch_pem)
            log.info(f"ws proxy refetched device cert from S3, retrying device={device}")
            try:
                await _run_proxy(backend_url, refetch_ctx, True)
            except Exception as retry_error:
                log.exception(
                    f"ws proxy connect to device failed after retry device={device} url={backend_url}"
                )
                try:
                    reason = _device_connection_failure_reason(retry_error)
                    await websocket.close(code=1011, reason=reason)
                except Exception:
                    pass
            else:
                try:
                    await websocket.close()
                except Exception:
                    pass
            return
        raise first_error
    except TimeoutError as e:
        log.error(
            f"ws proxy connect timed out: url={backend_url} port={WS_PORT} error={e}"
        )
        try:
            reason = _device_connection_failure_reason(e)
            await websocket.close(code=1011, reason=reason)
        except Exception:
            pass
    except Exception as e:
        log.exception(
            f"ws proxy connect to device failed device={device} url={backend_url} port={WS_PORT}"
        )
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
