# Bump tower calibration: list runs and images from S3 (keyme-calibration/bump_tower_calibration/...).

from control_panel.cloud.api.run_based_calibration import list_images, list_runs

PREFIX = "bump_tower_calibration"


def list_bump_tower_runs(s3_client, bucket: str, kiosk: str):
    return list_runs(s3_client, bucket, kiosk, PREFIX)


def list_bump_tower_images(s3_client, bucket: str, kiosk: str, run_id: str):
    return list_images(s3_client, bucket, kiosk, run_id, PREFIX)
