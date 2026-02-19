"""KeyMe opaque-token authentication via the ANF service.

Token validation flow:
1. Extract ``KEYME-TOKEN`` header from the incoming request.
2. Check the in-memory TTL cache for a previous successful validation.
3. On cache miss, call ``GET {ANF_BASE_URL}/api/permission/check?permission_slug=check_kiosk_status``
   with the token forwarded in the ``KEYME-TOKEN`` header.
4. If the response is non-200 **or** ``granted`` is not ``true``, reject with HTTP 401.
5. On success, cache the result for 300 s and return it.
"""

import logging
import os
import threading

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

log = logging.getLogger(__name__)

# Permission required to access the control panel cloud API.
REQUIRED_PERMISSION_SLUG = "check_kiosk_status"
PERMISSIONS_ADMIN_URL = "https://admin.key.me/permissions"

# ---------------------------------------------------------------------------
# Environment / base URL
# ---------------------------------------------------------------------------

_VALID_ENVS = {"stg", "prod"}

API_ENV: str = os.environ["API_ENV"]

if API_ENV not in _VALID_ENVS:
    raise RuntimeError(
        f"Invalid API_ENV={API_ENV!r}. Must be one of {sorted(_VALID_ENVS)}."
    )

_ANF_BASE_URLS: dict[str, str] = {
    "stg": "http://anf.k8s.staging.keymecloud.com",
    "prod": "https://anf.k8s.production.keymecloud.com",
}

ANF_BASE_URL: str = _ANF_BASE_URLS[API_ENV]

# TODO: Remove stg permission bypass below once we figure out how to re-enable permissions in stg.

# ---------------------------------------------------------------------------
# Token cache (connect-time check_kiosk_status)
# ---------------------------------------------------------------------------

_token_cache: TTLCache = TTLCache(maxsize=1000, ttl=300)

# ---------------------------------------------------------------------------
# Permission cache for fleet commands: (token, permission_slug) -> ANF response
# ---------------------------------------------------------------------------

_permission_cache: TTLCache = TTLCache(maxsize=2000, ttl=300)

# Lock for thread-safe cache access (sync REST and async WS paths both touch caches).
_cache_lock = threading.Lock()

# ---------------------------------------------------------------------------
# FastAPI security scheme (shows "Authorize" button in /docs)
# ---------------------------------------------------------------------------

keyme_token_header = APIKeyHeader(name="KEYME-TOKEN", auto_error=False)

# ---------------------------------------------------------------------------
# Token validation (sync, callable from REST and WebSocket)
# ---------------------------------------------------------------------------


def validate_token(token: str | None) -> dict:
    """Validate the opaque KeyMe token via ANF and return permission info.

    Raises HTTPException(401) on failure. Uses the same cache as REST.
    Safe to call from WebSocket handler (run in executor if async).
    """
    if not token:
        raise HTTPException(status_code=401, detail="Missing KEYME-TOKEN header")

    # Cache hit ---------------------------------------------------------------
    with _cache_lock:
        cached = _token_cache.get(token)
        if cached is not None:
            return cached

    # Validate against ANF ----------------------------------------------------
    url = f"{ANF_BASE_URL}/api/permission/check"
    try:
        resp = httpx.get(
            url,
            params={"permission_slug": REQUIRED_PERMISSION_SLUG},
            headers={"KEYME-TOKEN": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("ANF permission check failed: %s", exc)
        raise HTTPException(status_code=401, detail="Token validation failed") from exc

    if resp.status_code != 200:
        log.info("ANF returned %s for permission check", resp.status_code)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    data = resp.json()
    # In stg, require valid token only; skip permission check. Re-enable later.
    if API_ENV != "stg" and not data.get("granted"):
        log.info("Permission not granted: required=%s response=%s", REQUIRED_PERMISSION_SLUG, data)
        raise HTTPException(
            status_code=401,
            detail=(
                f'Access denied. Permission "{REQUIRED_PERMISSION_SLUG}" must be granted in '
                f"{PERMISSIONS_ADMIN_URL}"
            ),
        )

    # Cache successful validation ---------------------------------------------
    with _cache_lock:
        _token_cache[token] = data
    return data


async def validate_token_async(client: httpx.AsyncClient, token: str | None) -> dict:
    """Async token validation for WebSocket path. Same contract as validate_token."""
    if not token:
        raise HTTPException(status_code=401, detail="Missing KEYME-TOKEN header")

    with _cache_lock:
        cached = _token_cache.get(token)
        if cached is not None:
            return cached

    url = f"{ANF_BASE_URL}/api/permission/check"
    try:
        resp = await client.get(
            url,
            params={"permission_slug": REQUIRED_PERMISSION_SLUG},
            headers={"KEYME-TOKEN": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("ANF permission check failed: %s", exc)
        raise HTTPException(status_code=401, detail="Token validation failed") from exc

    if resp.status_code != 200:
        log.info("ANF returned %s for permission check", resp.status_code)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    data = resp.json()
    # In stg, require valid token only; skip permission check. Re-enable later.
    if API_ENV != "stg" and not data.get("granted"):
        log.info("Permission not granted: required=%s response=%s", REQUIRED_PERMISSION_SLUG, data)
        raise HTTPException(
            status_code=401,
            detail=(
                f'Access denied. Permission "{REQUIRED_PERMISSION_SLUG}" must be granted in '
                f"{PERMISSIONS_ADMIN_URL}"
            ),
        )

    with _cache_lock:
        _token_cache[token] = data
    return data


# ---------------------------------------------------------------------------
# Permission check for a specific slug (e.g. fleet commands). Returns (granted, user_identifier).
# ---------------------------------------------------------------------------

def validate_permission(token: str | None, permission_slug: str) -> tuple[bool, str | None]:
    """Check if token has the given permission via ANF. Returns (granted, user_identifier).

    user_identifier is from ANF response (e.g. email) when present, for use in error messages.
    Safe to call from WebSocket handler (run in executor if async).
    In stg, permission check is bypassed (always granted) so user only needs to be logged in.
    """
    if not token:
        return (False, None)
    if API_ENV == "stg":
        return (True, None)
    key = (token, permission_slug)
    with _cache_lock:
        cached = _permission_cache.get(key)
        if cached is not None:
            granted = bool(cached.get("granted"))
            user_id = cached.get("email") or cached.get("user_id")
            return (granted, user_id)

    url = f"{ANF_BASE_URL}/api/permission/check"
    try:
        resp = httpx.get(
            url,
            params={"permission_slug": permission_slug},
            headers={"KEYME-TOKEN": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("ANF permission check failed for %s: %s", permission_slug, exc)
        return (False, None)

    if resp.status_code != 200:
        log.info("ANF returned %s for permission check slug=%s", resp.status_code, permission_slug)
        return (False, None)

    data = resp.json()
    granted = bool(data.get("granted"))
    user_id = data.get("email") or data.get("user_id")
    with _cache_lock:
        _permission_cache[key] = data
    return (granted, user_id)


async def validate_permission_async(
    client: httpx.AsyncClient, token: str | None, permission_slug: str
) -> tuple[bool, str | None]:
    """Async permission check for WebSocket path. Same contract as validate_permission.
    In stg, permission check is bypassed (always granted).
    """
    if not token:
        return (False, None)
    if API_ENV == "stg":
        return (True, None)
    key = (token, permission_slug)
    with _cache_lock:
        cached = _permission_cache.get(key)
        if cached is not None:
            granted = bool(cached.get("granted"))
            user_id = cached.get("email") or cached.get("user_id")
            return (granted, user_id)

    url = f"{ANF_BASE_URL}/api/permission/check"
    try:
        resp = await client.get(
            url,
            params={"permission_slug": permission_slug},
            headers={"KEYME-TOKEN": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("ANF permission check failed for %s: %s", permission_slug, exc)
        return (False, None)

    if resp.status_code != 200:
        log.info("ANF returned %s for permission check slug=%s", resp.status_code, permission_slug)
        return (False, None)

    data = resp.json()
    granted = bool(data.get("granted"))
    user_id = data.get("email") or data.get("user_id")
    with _cache_lock:
        _permission_cache[key] = data
    return (granted, user_id)


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------


def get_current_user(token: str | None = Depends(keyme_token_header)) -> dict:
    """Validate the opaque KeyMe token via ANF and return permission info.

    Usage::

        @router.get("/protected")
        def protected(user=Depends(get_current_user)):
            ...
    """
    return validate_token(token)
