"""Backend implementations for the shared API. Device and cloud each use their own."""


class DeviceBackend:
    """Backend for the control panel when running on the device (IPC, local state)."""

    def ping(self):
        return {'status': 'ok', 'source': 'device'}
