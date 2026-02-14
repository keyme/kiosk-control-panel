"""Utilities for the WebSocket server."""
import enum


@enum.unique
class SocketErrors(enum.Enum):
    IPC_REJECTED = "IPC_REJECTED"
    IPC_TIMED_OUT = "IPC_TIMED_OUT"
    IPC_ERROR = "IPC_ERROR"
    OTHER = "OTHER_ERROR"
    INVALID_INPUT = "INVALID_INPUT"

    def __str__(self):
        return self.value


class WebsocketError:
    def __init__(self, errors):
        if isinstance(errors, list):
            self.errors = [str(error) for error in errors]
        else:
            self.errors = [str(errors)]

    def to_json(self):
        return {"success": False,
                "errors": self.errors}


class WebsocketSuccess:
    def __init__(self, data=None):
        if data is None:
            self.data = {}
        else:
            self.data = data

    def to_json(self):
        return {"success": True,
                "data": self.data}
