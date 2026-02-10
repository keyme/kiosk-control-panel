# Shared logic for run-based calibrations (bump_tower_calibration, grip_calibration, etc.).
# S3 layout: {prefix}/{kiosk_short_name}/{folder_name}/ with images inside.
# Runs = groups of folders whose timestamps are within 5 minutes (flexible grouping).

from typing import Dict, List

import boto3

from control_panel.api.run_grouping import group_by_max_gap_minutes, parse_timestamp
from control_panel.api.testcuts import (
    BUCKET,
    PRESIGNED_EXPIRES,
)


def _kiosk_to_short_name(kiosk: str) -> str:
    """For S3 prefix: ns9201 or ns9201.keymekiosk.com -> ns9201."""
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


def list_runs(s3_client, bucket: str, kiosk: str, prefix: str) -> List[dict]:
    """List runs with run_id, start_ts, end_ts (earliest/latest per 5-min group), sorted descending."""
    short = _kiosk_to_short_name(kiosk)
    base = f"{prefix}/{short}/"
    items = []
    for p in _list_dirs(s3_client, bucket, base):
        folder_name = p.rstrip("/").split("/")[-1]
        if folder_name and parse_timestamp(folder_name) is not None:
            items.append((folder_name, folder_name))
    groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
    runs = [
        {"run_id": run_id, "start_ts": run_id, "end_ts": end_ts}
        for run_id, end_ts, _ in groups
    ]
    return sorted(runs, key=lambda r: r["run_id"], reverse=True)


def list_images(
    s3_client, bucket: str, kiosk: str, run_id: str, prefix: str
) -> Dict[str, List]:
    """
    List objects from all folders in the run that has this run_id (5-min grouping).
    Section = filename; merge lists if same filename from different folders.
    """
    short = _kiosk_to_short_name(kiosk)
    base = f"{prefix}/{short}/"
    items = []
    for p in _list_dirs(s3_client, bucket, base):
        folder_name = p.rstrip("/").split("/")[-1]
        if folder_name and parse_timestamp(folder_name) is not None:
            items.append((folder_name, folder_name))
    groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
    run_folders = None
    run_end_ts = None
    for rid, end_ts, folders in groups:
        if rid == run_id:
            run_folders = folders
            run_end_ts = end_ts
            break
    if not run_folders:
        return {}

    by_section = {}
    for folder_name in run_folders:
        folder_prefix = f"{prefix}/{short}/{folder_name}/"
        paginator = s3_client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=folder_prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.endswith("/"):
                    continue
                filename = key.split("/")[-1]
                item = {"key": key, "filename": filename, "last_modified": obj.get("LastModified")}
                by_section.setdefault(filename, []).append(item)

    result = {}
    for section in sorted(by_section.keys()):
        out = []
        for item in by_section[section]:
            url = s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": bucket, "Key": item["key"]},
                ExpiresIn=PRESIGNED_EXPIRES,
            )
            out.append({"key": item["key"], "filename": item["filename"], "url": url})
        result[section] = out
    result["run_start_ts"] = run_id
    result["run_end_ts"] = run_end_ts
    return result
