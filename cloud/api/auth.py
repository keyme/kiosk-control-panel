"""KeyMe opaque-token authentication via the admin API.

Token validation flow:
1. Extract ``KEYME-TOKEN`` header from the incoming request.
2. Check the in-memory TTL cache for a previous successful validation.
3. On cache miss, call ``GET {LOGIN_BASE_URL}/users/permission_check`` with JSON body ``{"token": "..."}``.
4. Admin returns an array of permission slugs. If ``check_kiosk_status`` is not in the array, reject with HTTP 401.
5. On success, cache the result for 300 s and return it.
"""

import logging
import os
import threading
import time

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
ANF_BASE_URL: str = _ANF_BASE_URLS[API_ENV]  # Used for logout only

_LOGIN_BASE_URLS: dict[str, str] = {
    "stg": "https://admin.k8s.staging.keymecloud.com",
    "prod": "https://admin.k8s.production.keymecloud.com",
}
LOGIN_BASE_URL: str = _LOGIN_BASE_URLS[API_ENV]

# TODO: Remove stg permission bypass below once we figure out how to re-enable permissions in stg.

# ---------------------------------------------------------------------------
# Token cache (connect-time check_kiosk_status)
# ---------------------------------------------------------------------------

_token_cache: TTLCache = TTLCache(maxsize=1000, ttl=300)

# ---------------------------------------------------------------------------
# Permission cache for fleet commands: (token, permission_slug) -> ANF response
# ---------------------------------------------------------------------------

_permission_cache: TTLCache = TTLCache(maxsize=2000, ttl=300)

# Token -> (identifier, expires_at_ms). Primed from login (expires_at from ANF); backfill uses 300s.
_user_identifier_by_token: dict[str, tuple[str, int]] = {}

# Lock for thread-safe cache access (sync REST and async WS paths both touch caches).
_cache_lock = threading.Lock()

# ---------------------------------------------------------------------------
# FastAPI security scheme (shows "Authorize" button in /docs)
# ---------------------------------------------------------------------------

keyme_token_header = APIKeyHeader(name="KEYME-TOKEN", auto_error=False)

# ---------------------------------------------------------------------------
# Token validation (sync, callable from REST and WebSocket)
# ---------------------------------------------------------------------------


def _fetch_permissions_from_admin(token: str) -> list[str] | None:
    """Call admin /users/permission_check. Returns list of permission slugs or None on failure."""
    url = f"{LOGIN_BASE_URL}/users/permission_check"
    try:
        resp = httpx.request(
            "GET",
            url,
            json={"token": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("Admin permission check failed: %s", exc)
        return None
    if resp.status_code != 200:
        log.info("Admin returned %s for permission check", resp.status_code)
        return None
    data = resp.json()
    if not isinstance(data, list):
        log.warning("Admin permission check returned non-list: %s", type(data))
        return None
    return data


def validate_token(token: str | None) -> dict:
    """Validate the opaque KeyMe token via admin permission_check and return permission info.

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

    # Validate against admin --------------------------------------------------
    permissions = _fetch_permissions_from_admin(token)
    if permissions is None:
        raise HTTPException(status_code=401, detail="Token validation failed")

    granted = REQUIRED_PERMISSION_SLUG in permissions
    if API_ENV != "stg" and not granted:
        log.info(
            "Permission not granted: required=%s permissions=%s",
            REQUIRED_PERMISSION_SLUG,
            permissions[:5] if len(permissions) > 5 else permissions,
        )
        raise HTTPException(
            status_code=401,
            detail=(
                f'Access denied. Permission "{REQUIRED_PERMISSION_SLUG}" must be granted in '
                f"{PERMISSIONS_ADMIN_URL}"
            ),
        )

    # Cache successful validation ---------------------------------------------
    data = {"granted": granted, "permissions": permissions}
    with _cache_lock:
        _token_cache[token] = data
    return data


async def _fetch_permissions_from_admin_async(
    client: httpx.AsyncClient, token: str
) -> list[str] | None:
    """Call admin /users/permission_check (async). Returns list of permission slugs or None on failure."""
    url = f"{LOGIN_BASE_URL}/users/permission_check"
    try:
        resp = await client.request(
            "GET",
            url,
            json={"token": token},
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        log.warning("Admin permission check failed: %s", exc)
        return None
    if resp.status_code != 200:
        log.info("Admin returned %s for permission check", resp.status_code)
        return None
    data = resp.json()
    if not isinstance(data, list):
        log.warning("Admin permission check returned non-list: %s", type(data))
        return None
    return data


async def validate_token_async(client: httpx.AsyncClient, token: str | None) -> dict:
    """Async token validation for WebSocket path. Same contract as validate_token."""
    if not token:
        raise HTTPException(status_code=401, detail="Missing KEYME-TOKEN header")

    with _cache_lock:
        cached = _token_cache.get(token)
        if cached is not None:
            return cached

    permissions = await _fetch_permissions_from_admin_async(client, token)
    if permissions is None:
        raise HTTPException(status_code=401, detail="Token validation failed")

    granted = REQUIRED_PERMISSION_SLUG in permissions
    if API_ENV != "stg" and not granted:
        log.info(
            "Permission not granted: required=%s permissions=%s",
            REQUIRED_PERMISSION_SLUG,
            permissions[:5] if len(permissions) > 5 else permissions,
        )
        raise HTTPException(
            status_code=401,
            detail=(
                f'Access denied. Permission "{REQUIRED_PERMISSION_SLUG}" must be granted in '
                f"{PERMISSIONS_ADMIN_URL}"
            ),
        )

    data = {"granted": granted, "permissions": permissions}
    with _cache_lock:
        _token_cache[token] = data
    return data


# ---------------------------------------------------------------------------
# User identifier for audit logging (primed from login; optional backfill from permission/check)
# ---------------------------------------------------------------------------


def store_user_identifier_for_token(
    token: str, identifier: str | None, expires_at_ms: int | None = None
) -> None:
    """Store token -> user identifier for audit logging. expires_at_ms from admin login (ms since epoch); else 300s from now."""
    if not token or not identifier:
        return
    if expires_at_ms is None:
        expires_at_ms = int((time.time() + 300) * 1000)
    with _cache_lock:
        _user_identifier_by_token[token] = (identifier, expires_at_ms)


def get_user_identifier_for_token(token: str | None) -> str | None:
    """Return cached user identifier for a token, or None. Respects expires_at from login."""
    if not token:
        return None
    now_ms = int(time.time() * 1000)
    with _cache_lock:
        entry = _user_identifier_by_token.get(token)
        if entry is not None:
            identifier, expires_at_ms = entry
            if now_ms >= expires_at_ms:
                _user_identifier_by_token.pop(token, None)
                return None
            return identifier
        cached = _token_cache.get(token)
        if cached is not None:
            return cached.get("email") or cached.get("user_id")  # Admin doesn't return these
    return None


def evict_token_caches(token: str) -> None:
    """Evict token from token cache and user-identifier cache (e.g. on logout)."""
    with _cache_lock:
        _token_cache.pop(token, None)
        _user_identifier_by_token.pop(token, None)


# ---------------------------------------------------------------------------
# Permission check for a specific slug (e.g. fleet commands). Returns (granted, user_identifier).
# ---------------------------------------------------------------------------

def validate_permission(token: str | None, permission_slug: str) -> tuple[bool, str | None]:
    """Check if token has the given permission via admin permission_check. Returns (granted, user_identifier).

    user_identifier is None (admin doesn't return it in permission_check).
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
        # Check if we have permissions from validate_token cache
        token_cached = _token_cache.get(token)
        if token_cached is not None:
            perms = token_cached.get("permissions") or []
            granted = permission_slug in perms
            _permission_cache[key] = {"granted": granted}
            return (granted, None)

    permissions = _fetch_permissions_from_admin(token)
    if permissions is None:
        return (False, None)
    granted = permission_slug in permissions
    with _cache_lock:
        _permission_cache[key] = {"granted": granted}
        # Populate token cache so future validate_token hits are fast
        if _token_cache.get(token) is None:
            _token_cache[token] = {"granted": REQUIRED_PERMISSION_SLUG in permissions, "permissions": permissions}
    return (granted, None)


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
        token_cached = _token_cache.get(token)
        if token_cached is not None:
            perms = token_cached.get("permissions") or []
            granted = permission_slug in perms
            _permission_cache[key] = {"granted": granted}
            return (granted, None)

    permissions = await _fetch_permissions_from_admin_async(client, token)
    if permissions is None:
        return (False, None)
    granted = permission_slug in permissions
    with _cache_lock:
        _permission_cache[key] = {"granted": granted}
        if _token_cache.get(token) is None:
            _token_cache[token] = {"granted": REQUIRED_PERMISSION_SLUG in permissions, "permissions": permissions}
    return (granted, None)


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------


def get_current_user(token: str | None = Depends(keyme_token_header)) -> dict:
    """Validate the opaque KeyMe token via admin permission_check and return permission info.

    Usage::

        @router.get("/protected")
        def protected(user=Depends(get_current_user)):
            ...
    """
    return validate_token(token)
