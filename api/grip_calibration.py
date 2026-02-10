# Grip calibration: list runs and images from S3 (keyme-calibration/grip_calibration/...).

from control_panel.api.run_based_calibration import list_images, list_runs

PREFIX = "grip_calibration"


def list_grip_runs(s3_client, bucket: str, kiosk: str):
    return list_runs(s3_client, bucket, kiosk, PREFIX)


def list_grip_images(s3_client, bucket: str, kiosk: str, run_id: str):
    return list_images(s3_client, bucket, kiosk, run_id, PREFIX)
