"""Admin API: fetch kiosk inventory (stock) from admin.key.me."""

import logging
import os

import httpx

_log = logging.getLogger(__name__)

ADMIN_BASE_URL = "https://admin.key.me"
# STG_ADMIN_BASE_URL = "http://admin.k8s.staging.keymecloud.com"


def fetch_stock(kiosk: str) -> tuple[list | dict | None, str | None]:
    """Fetch stock/inventory for a kiosk from Admin.

    Returns (data, None) on success, or (None, error_message) on failure.
    Success: Admin returns a JSON array of inventory items.
    Error: Admin returns an object with success=false (e.g. invalid kiosk).
    """
    token = os.environ.get("ADMIN_ACCESS_TOKEN", "").strip()
    if not token:
        return (None, "ADMIN_ACCESS_TOKEN not configured")

    url = f"{ADMIN_BASE_URL}/kiosks/{kiosk}/stock.json"
    params = {"access_token": token}
    try:
        resp = httpx.get(url, params=params, timeout=10.0)
    except httpx.HTTPError as exc:
        _log.error("Admin stock request failed kiosk=%s: %s", kiosk, exc)
        return (None, f"Admin request failed: {exc}")

    if resp.status_code < 200 or resp.status_code >= 300:
        _log.error("Admin stock returned status %s kiosk=%s", resp.status_code, kiosk)
        return (None, f"Admin request failed: status {resp.status_code}")

    try:
        data = resp.json()
    except Exception as exc:
        _log.error("Admin stock JSON parse failed kiosk=%s: %s", kiosk, exc)
        return (None, f"Admin request failed: invalid JSON")

    # Error: Admin returns object with success=false (e.g. "Invalid Kiosk.")
    if isinstance(data, dict) and data.get("success") is False:
        msg = data.get("message", "Failed to fetch inventory stock from admin")
        return (None, msg)

    # Success: Admin returns array of inventory items
    if isinstance(data, list):
        return (data, None)

    # Forward other shapes as success
    return (data, None)
