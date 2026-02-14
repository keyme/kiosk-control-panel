# KeyMe imports.
import pylib as keyme

from control_panel.python.ws_server import emit_async_request


class ControlPanelParser(keyme.ipc.Parser):
    """Parser for CONTROL_PANEL: forwards async IPCs to WebSocket and handles PING."""

    def __init__(self, options_to_subscribe_to=None):
        if options_to_subscribe_to is None:
            options_to_subscribe_to = {}
        super().__init__(options_to_subscribe_to=options_to_subscribe_to)

    def handle_async(self, request):
        super().handle_async(request)
        emit_async_request(request)

    def handle_PING(self, request):
        """Sync handler so other services can validate the IPC path."""
        return request.response("OK", {"pong": True})
