"""KeyMe opaque-token authentication via the ANF service.

Token validation flow:
1. Extract ``KEYME-TOKEN`` header from the incoming request.
2. Check the in-memory TTL cache for a previous successful validation.
3. On cache miss, call ``GET {ANF_BASE_URL}/api/permission/check?permission_slug=admin_access``
   with the token forwarded in the ``KEYME-TOKEN`` header.
4. If the response is non-200 **or** ``granted`` is not ``true``, reject with HTTP 401.
5. On success, cache the result for 300 s and return it.
"""

import logging
import os

import httpx
from cachetools import TTLCache
from fastapi import Depends, HTTPException
from fastapi.security import APIKeyHeader

log = logging.getLogger(__name__)

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

# ---------------------------------------------------------------------------
# Token cache
# ---------------------------------------------------------------------------

_token_cache: TTLCache = TTLCache(maxsize=1000, ttl=300)

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
    cached = _token_cache.get(token)
    if cached is not None:
        return cached

    # Validate against ANF ----------------------------------------------------
    url = f"{ANF_BASE_URL}/api/permission/check"
    try:
        resp = httpx.get(
            url,
            params={"permission_slug": "admin_access"},
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
    if not data.get("granted"):
        log.info("Permission not granted: %s", data)
        raise HTTPException(status_code=401, detail="Insufficient permissions")

    # Cache successful validation ---------------------------------------------
    _token_cache[token] = data
    return data


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
