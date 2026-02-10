# Calibration trace: list trace runs and get trace.json with presigned URLs for artifacts.
# S3 layout: gripper_cam_calibration/{kiosk_short}/trace_{run_id}/trace.json and artifacts.

import urllib.request
from typing import Any, Dict, List, Optional, Tuple

import boto3
import cv2
import numpy as np

from control_panel.cloud.run_based_calibration import _kiosk_to_short_name
from control_panel.cloud.testcuts import BUCKET, PRESIGNED_EXPIRES

PREFIX = "gripper_cam_calibration"
TRACE_FILENAME = "trace.json"


def list_trace_runs(s3_client, bucket: str, kiosk: str) -> List[dict]:
    """
    List calibration trace runs: folders under PREFIX/{short}/ named trace_*.
    Returns [ { "run_id": "2026-02-09-20-46-20-UTC" }, ... ] sorted newest first.
    """
    short = _kiosk_to_short_name(kiosk)
    base = f"{PREFIX}/{short}/"
    paginator = s3_client.get_paginator("list_objects_v2")
    run_ids = []
    for page in paginator.paginate(Bucket=bucket, Prefix=base, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            folder = cp["Prefix"].rstrip("/").split("/")[-1]
            if folder.startswith("trace_"):
                run_id = folder[len("trace_"):]
                if run_id:
                    run_ids.append(run_id)
    return [{"run_id": rid} for rid in sorted(run_ids, reverse=True)]


def _run_prefix(short: str, run_id: str) -> str:
    return f"{PREFIX}/{short}/trace_{run_id}/"


def _artifact_key(bucket: str, run_prefix: str, path: str) -> str:
    """
    Resolve artifact path from trace.json to S3 key.
    path can be: filename only, or ns1136/filename, or keyme-calibration/prefix/... or prefix/...
    """
    p = path.strip()
    if p.startswith(f"{bucket}/"):
        p = p[len(bucket) + 1:]
    if p.startswith(f"{PREFIX}/"):
        return p
    return run_prefix + p.lstrip("/")


def get_trace(s3_client, bucket: str, kiosk: str, run_id: str) -> Dict[str, Any]:
    """
    Get trace.json from S3 for the given run_id, and add presigned url to each artifact.
    Returns the trace dict (trace_version, calibration_type, run_id, started_at, steps)
    with each step's artifacts[].url set.
    """
    short = _kiosk_to_short_name(kiosk)
    run_prefix = _run_prefix(short, run_id)
    trace_key = run_prefix + TRACE_FILENAME

    from botocore.exceptions import ClientError
    import json
    try:
        obj = s3_client.get_object(Bucket=bucket, Key=trace_key)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "NoSuchKey":
            return None
        raise
    trace = json.loads(obj["Body"].read().decode("utf-8"))

    for step in trace.get("steps", []):
        artifacts = step.get("artifacts")
        if not artifacts:
            continue
        for a in artifacts:
            path = a.get("path") or ""
            key = _artifact_key(bucket, run_prefix, path)
            try:
                url = s3_client.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": bucket, "Key": key},
                    ExpiresIn=PRESIGNED_EXPIRES,
                )
                a["url"] = url
            except Exception:
                a["url"] = None

    return trace


def dewarp_image(image_url: str, homography: List[List[float]]) -> Tuple[Optional[bytes], Optional[str]]:
    """
    Fetch image from URL, apply perspective warp with homography (3x3), return PNG bytes.
    Returns (png_bytes, None) on success or (None, error_message) on failure.
    """
    if not homography or len(homography) != 3 or not all(len(row) == 3 for row in homography):
        return None, "Invalid homography: expected 3x3 matrix"
    try:
        with urllib.request.urlopen(image_url, timeout=30) as resp:
            raw = resp.read()
    except Exception as e:
        return None, "Failed to fetch image: {}".format(e)
    arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        return None, "Failed to decode image"
    h_mat = np.array(homography, dtype=np.float64)
    h, w = image.shape[:2]
    dewarped = cv2.warpPerspective(image, h_mat, (w, h))
    _, png_bytes = cv2.imencode(".png", dewarped)
    return png_bytes.tobytes(), None
