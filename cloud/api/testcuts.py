# Testcuts calibration: list IDs and images from S3 (keyme-calibration/testcuts/{kiosk_hostname}/{id_path}/).

import re

import boto3

from control_panel.cloud.api.s3_url_cache import get_presigned_url

BUCKET = "keyme-calibration"


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
