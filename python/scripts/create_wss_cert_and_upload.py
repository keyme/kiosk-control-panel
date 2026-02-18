#!/usr/bin/env python3

"""Create a self-signed WSS device certificate and upload the public cert to S3.

This script is designed to run with **no arguments**:
- Salt provisioning can call it once as the `kiosk` user.
- `control_panel/python/ws_server.py` can import and call the same logic as a
  runtime fallback if the cert/key files are missing.

Idempotency:
- The cert/key are only created if missing.
- Upload is skipped if the marker file indicates the same cert was already
  uploaded (same SHA-256).
"""

import os
import time
import boto3
import hashlib
import subprocess
from typing import Optional, Tuple

import pylib as keyme

from control_panel.shared import DEVICE_CERTS_BUCKET, WSS_CERTS_S3_PREFIX

# WSS certs: on-device paths and naming. (Local to this script.)
WSS_FQDN_SUFFIX = ".keymekiosk.com"
CONTROL_PANEL_STATE_SUBDIR = "control_panel"
WSS_CERT_UPLOAD_MARKER_FILENAME = ".wss_cert_uploaded.sha256"
CERT_DIR = os.path.join(keyme.config.STATE_PATH, CONTROL_PANEL_STATE_SUBDIR)
FQDN = f"{keyme.config.KIOSK_NAME}{WSS_FQDN_SUFFIX}"
CERT_PATH = os.path.join(CERT_DIR, f"{FQDN}.crt")
KEY_PATH = os.path.join(CERT_DIR, f"{FQDN}.key")


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_device_certs(cert_dir: str, fqdn: str) -> Tuple[str, str, bool]:
    """Ensure {fqdn}.crt and {fqdn}.key exist in cert_dir; create with openssl if missing."""
    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, fqdn + ".crt")
    key_path = os.path.join(cert_dir, fqdn + ".key")
    if os.path.isfile(cert_path) and os.path.isfile(key_path):
        return cert_path, key_path, False

    keyme.log.info(f"Control panel device cert missing, creating self-signed cert for {fqdn}")
    subprocess.check_call(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-keyout",
            key_path,
            "-out",
            cert_path,
            "-days",
            "36500",  # ~100 years, effectively infinite
            "-nodes",
            "-subj",
            "/CN=" + fqdn,
            "-addext",
            "subjectAltName=DNS:" + fqdn,
        ],
        cwd=cert_dir,
    )
    return cert_path, key_path, True


def _s3_key_for_cert(kiosk_name: str, fqdn: str) -> str:
    return f"{WSS_CERTS_S3_PREFIX}/{kiosk_name.upper()}/{fqdn}.crt"


def upload_public_cert_to_s3(
    *,
    cert_path: str,
    bucket: str = DEVICE_CERTS_BUCKET,
) -> str:
    """Upload the public cert to S3. Returns s3key."""
    kiosk_name = keyme.config.KIOSK_NAME
    s3key = _s3_key_for_cert(kiosk_name, FQDN)
    marker_path = os.path.join(os.path.dirname(cert_path), WSS_CERT_UPLOAD_MARKER_FILENAME)
    current_hash = _sha256_file(cert_path)

    # Fast path: if marker matches current cert hash, assume upload already happened.
    try:
        if os.path.isfile(marker_path):
            prev_hash = (open(marker_path, "r").read().strip().split(" ", 1)[0] or "").strip()
            if prev_hash and prev_hash == current_hash:
                return s3key
    except Exception:
        pass

    client = boto3.client("s3")
    client.upload_file(cert_path, bucket, s3key)

    # Record successful upload.
    try:
        os.makedirs(os.path.dirname(marker_path), exist_ok=True)
        tmp_path = marker_path + ".tmp"
        with open(tmp_path, "w") as f:
            f.write(f"{current_hash} {s3key} {int(time.time())}\n")
        os.replace(tmp_path, marker_path)
    except Exception as e:
        keyme.log.warning(f"Failed to write WSS cert upload marker file: {e}")
    return s3key


def ensure_wss_device_certs_and_upload() -> Tuple[str, str]:
    cert_path, key_path, _created = ensure_device_certs(CERT_DIR, FQDN)
    s3key = upload_public_cert_to_s3(cert_path=cert_path)
    keyme.log.info(f"Control panel device cert uploaded s3://{DEVICE_CERTS_BUCKET}/{s3key}")
    return cert_path, key_path


def main() -> int:
    try:
        ensure_wss_device_certs_and_upload()
        return 0
    except Exception as e:
        keyme.log.error(f"Failed to ensure/upload WSS certs: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

