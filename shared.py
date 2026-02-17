"""Constants shared by control panel device and cloud for WSS and device certs.

Single source of truth for bucket, secret id, S3 key prefix, and WebSocket
port/path so they can be changed in one place.
"""

# S3 bucket for device public certs (and other control panel assets).
DEVICE_CERTS_BUCKET = "keyme-calibration"

# TODO: tmp use of key-scanner secret need to gen new one for control panel
# AWS Secrets Manager secret id for WSS API key (cloud-to-device auth).
WSS_SECRET_ID = "/prod/key-scanner/env"
# JSON field name for the API key in the secret (plain SecretString also supported).
WSS_API_KEY_FIELD = "KEY_SCANNER_API_KEY"

# S3 key prefix for device WSS certs: {prefix}/{KIOSK_NAME}/{fqdn}.crt
WSS_CERTS_S3_PREFIX = "wss_certs"

# WebSocket: port the device server listens on; path both sides use.
WS_PORT = 2026
WS_PATH = "/ws"
