# System imports.
import os
import json
import pylib as keyme

CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config')
_ports_path = os.path.join(CFG_PATH, 'ports.json')
with open(_ports_path) as f:
    PORTS = json.load(f)

# No controller options for control panel; parser accepts empty dict.
OPTIONS = {}

# WSS API key (device-only): keyring service/username for caching the secret.
WSS_KEYRING_SERVICE = "CONTROL_PANEL_WSS"
WSS_KEYRING_USERNAME = "kiosk"

# WSS cert paths (used by ws_server). Keep minimal exports here.
CERT_PATH = os.path.join(
    keyme.config.STATE_PATH,
    "control_panel",
    f"{keyme.config.KIOSK_NAME}.keymekiosk.com.crt",
)
KEY_PATH = os.path.join(
    keyme.config.STATE_PATH,
    "control_panel",
    f"{keyme.config.KIOSK_NAME}.keymekiosk.com.key",
)

# Marker written by `create_wss_cert_and_upload.py` after a successful S3 upload.
WSS_CERT_UPLOAD_MARKER_FILENAME = ".wss_cert_uploaded.sha256"
CERT_MARKER_PATH = os.path.join(os.path.dirname(CERT_PATH), WSS_CERT_UPLOAD_MARKER_FILENAME)
