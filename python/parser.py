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
        """All async requests are forwarded to the UI here. Handlers below exist so get_handler() returns non-None."""
        if request.get('action') == 'RESET_RESULT':
            from control_panel.python import server
            server.deliver_reset_result(request)
        super().handle_async(request)
        emit_async_request(request)  # sends async.PROCESS_STARTED, async.PROCESS_STOPPED, etc. to WS clients

    def handle_async_PROCESS_STARTED(self, request):
        """Manager notifies that a process has started. Forwarded to UI in handle_async (channel calls handle_async, not this)."""
        pass

    def handle_async_PROCESS_STOPPED(self, request):
        """Manager notifies that a process has stopped. Forwarded to UI in handle_async (channel calls handle_async, not this)."""
        pass

    def handle_PING(self, request):
        """Sync handler so other services can validate the IPC path."""
        return request.response("OK", {"pong": True})
