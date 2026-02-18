# System imports.
import os
import json

CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config')
PORTS = json.load(open(os.path.join(CFG_PATH, 'ports.json')))

# No controller options for control panel; parser accepts empty dict.
OPTIONS = {}

# WSS API key (device-only): keyring service/username for caching the secret.
WSS_KEYRING_SERVICE = "CONTROL_PANEL_WSS"
WSS_KEYRING_USERNAME = "kiosk"
