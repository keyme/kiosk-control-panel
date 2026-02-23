#!/usr/bin/env python3

# KeyMe imports.
import signal

import pylib as keyme

from control_panel.python.parser import ControlPanelParser
from control_panel.python.shared import OPTIONS
from control_panel.python.ws_server import run as run_ws_server


def _shutdown_handler(signum, frame):
    keyme.log.info('Received signal %s, shutting down...', signum)
    keyme.process.quit_flag.set()


if __name__ == '__main__':
    # Start the WebSocket server on its own thread.
    keyme.Thread(target=run_ws_server).start()

    # Initialize the process and IPC parser.
    ipc_parser = keyme.process.init('CONTROL_PANEL', ControlPanelParser, args=[OPTIONS])

    # Start processing asynchronous messages in their own thread.
    if ipc_parser is not None:
        ipc_parser.spawn_async_handler_thread()

    # Subscribe to config options (optional; control panel uses empty OPTIONS).
    if ipc_parser is not None:
        ipc_parser.subscribe_to_config_options()

    # Handle SIGTERM/SIGINT so the IPC loop exits and atexit cleanup runs.
    signal.signal(signal.SIGTERM, _shutdown_handler)
    signal.signal(signal.SIGINT, _shutdown_handler)

    # Start listening for IPC messages.
    keyme.ipc.listen()
