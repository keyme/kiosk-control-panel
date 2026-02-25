# Waiter for MOTION async responses (MOVE_FINISHED / MOTOR_ERROR).
# Used by inventory_rotate_and_capture to wait for carousel HOME/GOTO without fixed sleeps.

import threading

_MOTION_WAITER_LOCK = threading.Lock()
_MOTION_WAITER = {}  # request_id -> {'event': Event(), 'error': str or None}


def register(request_id):
    """Register a request_id we are waiting on. Call before sending the async MOTION request."""
    with _MOTION_WAITER_LOCK:
        e = threading.Event()
        _MOTION_WAITER[request_id] = {'event': e, 'error': None}


def notify_move_finished(request_id):
    """Call when MOVE_FINISHED is received for this request_id (from parser)."""
    with _MOTION_WAITER_LOCK:
        entry = _MOTION_WAITER.get(request_id)
        if entry:
            entry['error'] = None
            entry['event'].set()


def notify_motor_error(request_id, message):
    """Call when MOTOR_ERROR is received for this request_id (from parser)."""
    with _MOTION_WAITER_LOCK:
        entry = _MOTION_WAITER.get(request_id)
        if entry:
            entry['error'] = message or 'Motion error'
            entry['event'].set()


def wait(request_id, timeout):
    """Wait for MOVE_FINISHED or MOTOR_ERROR for this request_id. Returns (True, None) on
    MOVE_FINISHED, (False, error_message) on MOTOR_ERROR or timeout. Cleans up the entry."""
    with _MOTION_WAITER_LOCK:
        entry = _MOTION_WAITER.get(request_id)
        if not entry:
            return False, 'Unknown request_id'
        event = entry['event']
        err = entry['error']
    ok = event.wait(timeout=timeout)
    with _MOTION_WAITER_LOCK:
        entry = _MOTION_WAITER.pop(request_id, None)
        if entry and entry.get('error'):
            return False, entry['error']
    if not ok:
        return False, 'Carousel move timed out'
    return True, None
