# Bitting calibration: list dates and images from S3 (keyme-calibration/bitting_calibration/{kiosk_short_name}/{date}/).
# S3 uses short name (e.g. ns1136), not hostname.

from typing import Dict, List

import boto3

from control_panel.api.testcuts import (
    BUCKET,
    PRESIGNED_EXPIRES,
    kiosk_to_hostname,
)


def _kiosk_to_short_name(kiosk: str) -> str:
    """For S3 prefix: ns1136 or ns1136.keymekiosk.com -> ns1136."""
    if not kiosk:
        return ""
    if "." in kiosk:
        return kiosk.split(".")[0]
    return kiosk


def _list_dirs(s3_client, bucket: str, prefix: str):
    """Yield each CommonPrefix under the given prefix (one level)."""
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            yield cp["Prefix"]


def list_bitting_dates(s3_client, bucket: str, kiosk: str) -> List[str]:
    """List date folders under bitting_calibration/{short_name}/, return sorted descending (newest first)."""
    short = _kiosk_to_short_name(kiosk)
    base_prefix = f"bitting_calibration/{short}/"
    dates = []
    for prefix in _list_dirs(s3_client, bucket, base_prefix):
        date = prefix.rstrip("/").split("/")[-1]
        if date:
            dates.append(date)
    return sorted(dates, reverse=True)


def list_bitting_images(s3_client, bucket: str, kiosk: str, date: str) -> Dict[str, List]:
    """
    List objects under bitting_calibration/{short_name}/{date}/.
    Section = filename; one image per section. Same response shape as testcuts: { section_name: [ { key, filename, url } ] }.
    Sections sorted alphabetically by filename for stable order.
    """
    short = _kiosk_to_short_name(kiosk)
    prefix = f"bitting_calibration/{short}/{date}/"
    paginator = s3_client.get_paginator("list_objects_v2")
    by_section = {}
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            filename = key.split("/")[-1]
            by_section[filename] = [
                {"key": key, "filename": filename, "last_modified": obj.get("LastModified")}
            ]

    result = {}
    for section in sorted(by_section.keys()):
        items = by_section[section]
        out = []
        for item in items:
            url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": bucket, "Key": item["key"]},
                ExpiresIn=PRESIGNED_EXPIRES,
            )
            out.append(
                {
                    "key": item["key"],
                    "filename": item["filename"],
                    "url": url,
                }
            )
        result[section] = out
    return result
