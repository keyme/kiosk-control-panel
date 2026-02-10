# Gripper LEDs check: flat list under gripper_leds_check/{kiosk_short_name}/.
# Filenames: {kiosk}_{timestamp}_{suffix}.jpg. Runs = 5-min flexible grouping by timestamp.

from typing import Dict, List

import boto3

from control_panel.cloud.run_based_calibration import _kiosk_to_short_name
from control_panel.cloud.run_grouping import group_by_max_gap_minutes
from control_panel.cloud.testcuts import BUCKET, PRESIGNED_EXPIRES

PREFIX = "gripper_leds_check"


def _ts_from_filename(filename: str) -> str:
    """Extract timestamp (second segment) from {kiosk}_{ts}_{suffix}.*."""
    parts = filename.split("_")
    return parts[1] if len(parts) >= 2 else ""


def list_gripper_leds_runs(s3_client, bucket: str, kiosk: str) -> List[str]:
    """List run IDs (earliest ts per 5-min group), sorted descending."""
    short = _kiosk_to_short_name(kiosk)
    base = f"{PREFIX}/{short}/"
    paginator = s3_client.get_paginator("list_objects_v2")
    items = []
    for page in paginator.paginate(Bucket=bucket, Prefix=base):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            filename = key.split("/")[-1]
            ts_str = _ts_from_filename(filename)
            if not ts_str:
                continue
            payload = (key, filename, obj.get("LastModified"))
            items.append((ts_str, payload))
    groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
    runs = [
        {"run_id": run_id, "start_ts": run_id, "end_ts": end_ts}
        for run_id, end_ts, _ in groups
    ]
    return sorted(runs, key=lambda r: r["run_id"], reverse=True)


def list_gripper_leds_images(
    s3_client, bucket: str, kiosk: str, run_id: str
) -> Dict[str, List]:
    """List objects in the run that has this run_id (5-min grouping). Section = filename."""
    short = _kiosk_to_short_name(kiosk)
    base = f"{PREFIX}/{short}/"
    paginator = s3_client.get_paginator("list_objects_v2")
    items = []
    for page in paginator.paginate(Bucket=bucket, Prefix=base):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            filename = key.split("/")[-1]
            ts_str = _ts_from_filename(filename)
            if not ts_str:
                continue
            payload = (key, filename, obj.get("LastModified"))
            items.append((ts_str, payload))
    groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
    run_payloads = None
    run_end_ts = None
    for rid, end_ts, payloads in groups:
        if rid == run_id:
            run_payloads = payloads
            run_end_ts = end_ts
            break
    if not run_payloads:
        return {}

    by_section = {}
    for key, filename, last_modified in run_payloads:
        by_section.setdefault(filename, []).append(
            {"key": key, "filename": filename, "last_modified": last_modified}
        )

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
