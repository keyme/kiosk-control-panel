# KeyMe imports.
import pylib as keyme

from control_panel.python.motion_waiter import notify_move_finished, notify_motor_error
from control_panel.python.ws_server import emit_async_request
from lib.save_image import got_response, success


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

    def handle_async_RESET_RESULT(self, request):
        """DEVICE_DIRECTOR sends RESET_RESULT per device to CONTROL_PANEL."""
        pass

    def handle_PING(self, request):
        """Sync handler so other services can validate the IPC path."""
        return request.response("OK", {"pong": True})

    # Camera take_image response handlers: set events so request_save_frame wait unblocks.
    def handle_async_IMAGE_SAVED(self, request):
        success.set()
        got_response.set()

    def handle_async_IMAGE_NOT_SAVED(self, request):
        got_response.set()

    def handle_async_TAKEN(self, request):
        success.set()
        got_response.set()

    def handle_async_NOT_TAKEN(self, request):
        got_response.set()

    def handle_async_MOVE_FINISHED(self, request):
        """MOTION notifies that a move completed; unblock motion_waiter if we are waiting."""
        rid = (request.get('data') or {}).get('request_id')
        if rid is not None:
            notify_move_finished(rid)

    def handle_async_MOTOR_ERROR(self, request):
        """MOTION notifies that a move failed; unblock motion_waiter with error."""
        data = request.get('data') or {}
        rid = data.get('request_id')
        if rid is not None:
            msg = data.get('error') or data.get('message') or 'Motion error'
            notify_motor_error(rid, str(msg))
