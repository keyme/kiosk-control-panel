# Testcuts calibration: list IDs and images from S3 (keyme-calibration/testcuts/{kiosk_hostname}/{id_path}/).

import re
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3

from control_panel.cloud.api.s3_url_cache import get_presigned_url

BUCKET = "keyme-calibration"


KEY_HEAD_FILENAME_REGEX = re.compile(r"key[_-]head_check", re.IGNORECASE)


def kiosk_to_hostname(kiosk: str) -> str:
    """Normalize kiosk param to S3 hostname (e.g. ns1136 -> ns1136.keymekiosk.com)."""
    if not kiosk or "." in kiosk:
        return kiosk or ""
    return f"{kiosk}.keymekiosk.com"


def list_dirs(s3_client, bucket: str, prefix: str):
    """Yield each CommonPrefix under the given prefix (one level)."""
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            yield cp["Prefix"]


def extract_id(prefix: str) -> int:
    """From full prefix (e.g. .../000/000/087/) return integer id (e.g. 87)."""
    parts = prefix.rstrip("/").split("/")
    a, b, c = parts[-3], parts[-2], parts[-1]
    return int(a) * 1_000_000 + int(b) * 1_000 + int(c)


def list_testcut_ids(s3_client, bucket: str, kiosk_hostname: str) -> list[int]:
    """Three-level list_dirs from testcuts/{host}/, extract_id, dedupe, return sorted(ids, reverse=True)."""
    base_prefix = f"testcuts/{kiosk_hostname}/"
    ids = set()
    for p1 in list_dirs(s3_client, bucket, base_prefix):
        for p2 in list_dirs(s3_client, bucket, p1):
            for p3 in list_dirs(s3_client, bucket, p2):
                ids.add(extract_id(p3))
    return sorted(ids, reverse=True)


def id_to_path(id_int: int) -> str:
    """Convert integer id to S3 path segment (e.g. 87 -> 000/000/087)."""
    s = f"{id_int:09d}"
    return "/".join(s[i : i + 3] for i in range(0, 9, 3))


def list_testcut_object_keys(
    s3_client, bucket: str, kiosk_hostname: str, id_int: int
):
    """Yield (key, filename) for each object under testcuts/{host}/{id_path}/. No presigning."""
    id_path = id_to_path(id_int)
    prefix = f"testcuts/{kiosk_hostname}/{id_path}/"
    prefix_len = len(prefix.rstrip("/").split("/"))

    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            parts = key.split("/")
            if len(parts) <= prefix_len:
                continue
            filename = parts[-1]
            yield (key, filename)


def _section_sort_key(section_name: str) -> int:
    """Extract numeric prefix from section name for ordering (e.g. 02_PRE_PICKUP -> 2)."""
    m = re.match(r"^(\d+)", section_name)
    return int(m.group(1)) if m else 0


def list_testcut_images(s3_client, bucket: str, kiosk_hostname: str, id_int: int) -> dict[str, list]:
    """
    List objects under testcuts/{host}/{id_path}/, group by section, sort sections and images.
    Each list item has key, filename, and presigned url.
    """
    id_path = id_to_path(id_int)
    prefix = f"testcuts/{kiosk_hostname}/{id_path}/"
    prefix_parts = prefix.rstrip("/").split("/")
    prefix_len = len(prefix_parts)

    # List all objects under prefix
    paginator = s3_client.get_paginator("list_objects_v2")
    by_section = {}
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            parts = key.split("/")
            if len(parts) <= prefix_len:
                continue
            section = parts[prefix_len]
            filename = parts[-1]
            by_section.setdefault(section, []).append(
                {"key": key, "filename": filename, "last_modified": obj.get("LastModified")}
            )

    # Sort sections by numeric prefix, sort images within each section by key
    section_order = sorted(by_section.keys(), key=_section_sort_key)
    result = {}
    for section in section_order:
        items = sorted(by_section[section], key=lambda x: x["key"])
        out = []
        for item in items:
            url = get_presigned_url(s3_client, bucket, item["key"])
            out.append(
                {
                    "key": item["key"],
                    "filename": item["filename"],
                    "url": url,
                }
            )
        result[section] = out
    return result


def _parse_magazine_from_filename(filename: str) -> int | None:
    """Extract magazine number from filename used in key head checks.

    Filenames are of the form PREFIX_<magazine>_...; this mirrors the
    frontend's parseMagazineFromFilename helper.
    """
    if not filename or not isinstance(filename, str):
        return None
    m = re.match(r"^[^_]+_(\d+)_", filename)
    if not m:
        return None
    try:
        n = int(m.group(1))
    except ValueError:
        return None
    return n if 1 <= n <= 20 else None


def _list_key_head_candidates_for_id(
    s3_client, bucket: str, kiosk_hostname: str, id_int: int
) -> tuple[int, list[tuple[str, str, int]]]:
    """List key_head_check objects for one testcut ID. Returns (id_int, [(key, filename, mag), ...])."""
    items: list[tuple[str, str, int]] = []
    for key, filename in list_testcut_object_keys(
        s3_client, bucket, kiosk_hostname, id_int
    ):
        if not KEY_HEAD_FILENAME_REGEX.search(filename):
            continue
        mag = _parse_magazine_from_filename(filename)
        if mag is not None:
            items.append((key, filename, mag))
    return (id_int, items)


def list_ejection_key_heads(
    s3_client,
    bucket: str,
    kiosk_hostname: str,
    *,
    max_ids: int = 80,
    max_magazines: int = 20,
    max_workers: int = 16,
) -> dict[int, dict]:
    """Return latest key-head-check image per magazine for a kiosk.

    Lists objects per testcut ID in parallel (ThreadPoolExecutor); filters for
    key_head_check, picks first image per magazine (newest first), then presigns
    only the selected images. Uses a larger S3 connection pool when the client
    is configured for it.
    """
    ids = list_testcut_ids(s3_client, bucket, kiosk_hostname)
    if not ids:
        return {}
    limited_ids = ids[:max_ids]
    # Run S3 listing per ID in parallel
    id_to_items: list[tuple[int, list[tuple[str, str, int]]]] = []
    workers = min(max_workers, len(limited_ids))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_id = {
            executor.submit(
                _list_key_head_candidates_for_id,
                s3_client,
                bucket,
                kiosk_hostname,
                id_int,
            ): id_int
            for id_int in limited_ids
        }
        for future in as_completed(future_to_id):
            id_int, items = future.result()
            if items:
                id_to_items.append((id_int, items))
    # Process in descending id order (newest first) so first-seen mag wins
    id_to_items.sort(key=lambda x: x[0], reverse=True)
    by_mag: dict[int, tuple[int, str, str]] = {}
    for id_int, items in id_to_items:
        for key, filename, mag in items:
            if mag not in by_mag:
                by_mag[mag] = (id_int, key, filename)
            if len(by_mag) >= max_magazines:
                break
        if len(by_mag) >= max_magazines:
            break

    result: dict[int, dict] = {}
    for mag, (id_int, key, filename) in by_mag.items():
        url = get_presigned_url(s3_client, bucket, key)
        result[mag] = {
            "id": id_int,
            "image": {"key": key, "filename": filename, "url": url},
        }
    return result
