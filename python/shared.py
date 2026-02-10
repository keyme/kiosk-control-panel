# System imports.
import os
import json

CFG_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config')
PORTS = json.load(open(os.path.join(CFG_PATH, 'ports.json')))

# No controller options for control panel; parser accepts empty dict.
OPTIONS = {}
