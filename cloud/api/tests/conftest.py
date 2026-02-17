"""Shared fixtures: moto-mocked S3 bucket with seed data and FastAPI TestClient."""

import json

import boto3
import pytest
from moto import mock_aws
from starlette.testclient import TestClient

BUCKET = "keyme-calibration"
KIOSK_SHORT = "ns9999"
KIOSK_HOST = f"{KIOSK_SHORT}.keymekiosk.com"

# Timestamps used in seed data (within 5-min grouping window)
TS1 = "2026-01-15-10-00-00-UTC"
TS2 = "2026-01-15-10-03-00-UTC"

# A second run well outside the 5-min window
TS_OTHER = "2026-01-20-14-00-00-UTC"

_DUMMY_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64  # minimal fake PNG bytes


def _seed_bucket(s3):
    """Populate the mock S3 bucket with representative objects for every calibration type."""
    put = lambda key: s3.put_object(Bucket=BUCKET, Key=key, Body=_DUMMY_PNG)

    # ── testcuts (three-level dirs, hostname-based) ──────────────────────
    put(f"testcuts/{KIOSK_HOST}/000/000/001/01_PRE_PICKUP/img_a.png")
    put(f"testcuts/{KIOSK_HOST}/000/000/001/01_PRE_PICKUP/img_b.png")
    put(f"testcuts/{KIOSK_HOST}/000/000/001/02_POST_PICKUP/img_c.png")
    # second testcut id = 2
    put(f"testcuts/{KIOSK_HOST}/000/000/002/01_PRE_PICKUP/img_d.png")

    # ── bitting calibration (short name, date folders) ───────────────────
    put(f"bitting_calibration/{KIOSK_SHORT}/2026-01-15/image1.png")
    put(f"bitting_calibration/{KIOSK_SHORT}/2026-01-15/image2.png")
    put(f"bitting_calibration/{KIOSK_SHORT}/2026-01-10/other.png")

    # ── run-based folder calibrations (bump_tower, grip) ─────────────────
    for prefix in ("bump_tower_calibration", "grip_calibration"):
        put(f"{prefix}/{KIOSK_SHORT}/{TS1}/image.png")
        put(f"{prefix}/{KIOSK_SHORT}/{TS2}/image2.png")

    # ── flat-file calibrations (gripper_cam, gripper_leds, overhead_cam, pickup_y) ──
    flat_types = {
        "gripper_cam_calibration": ".png",
        "gripper_leds_check": ".jpg",
        "overhead_cam_calibration": ".png",
        "pickup_y_calibration": ".jpg",
    }
    for prefix, ext in flat_types.items():
        put(f"{prefix}/{KIOSK_SHORT}/{KIOSK_SHORT}_{TS1}_front{ext}")
        put(f"{prefix}/{KIOSK_SHORT}/{KIOSK_SHORT}_{TS2}_front{ext}")

    # ── calibration trace ────────────────────────────────────────────────
    trace_run_prefix = f"gripper_cam_calibration/{KIOSK_SHORT}/trace_{TS1}/"
    trace_json = {
        "trace_version": "1.0",
        "calibration_type": "gripper_cam",
        "run_id": TS1,
        "started_at": "2026-01-15T10:00:00Z",
        "steps": [
            {
                "name": "capture",
                "artifacts": [
                    {"path": "capture.png", "type": "image"},
                ],
            }
        ],
    }
    s3.put_object(
        Bucket=BUCKET,
        Key=f"{trace_run_prefix}trace.json",
        Body=json.dumps(trace_json).encode(),
    )
    put(f"{trace_run_prefix}capture.png")


@pytest.fixture(scope="session")
def _mock_aws_session():
    """Session-wide moto mock — keeps the fake S3 alive for all tests."""
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        _seed_bucket(s3)
        yield


_FAKE_USER = {"granted": True, "permission": "check_kiosk_status"}


@pytest.fixture(scope="session")
def client(_mock_aws_session):
    """FastAPI TestClient with mocked S3 underneath.

    Auth is bypassed: ``get_current_user`` always returns a fake user so
    existing tests don't need a real KeyMe/ANF token.
    """
    from control_panel.cloud.api.auth import get_current_user
    from control_panel.cloud.api.main import app

    app.dependency_overrides[get_current_user] = lambda: _FAKE_USER
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)
