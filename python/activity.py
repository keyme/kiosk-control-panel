# Single source of truth for kiosk activity (inactive / active / service).
# Used by control panel server for panel info and by fleet_commands for "kiosk in use" check.

import pylib as keyme

_IPC_ERRORS = (keyme.ipc.exceptions.TimeoutException, keyme.ipc.exceptions.IPCException)


def get_activity():
    """Activity from new_activity_check logic (gui5/scripts/activity_check.py).
    Returns 'inactive' | 'active' | 'service'."""
    try:
        svc = keyme.status.remote.get(
            'processes.MANAGER.configuration.service',
            logging=False,
            raise_on_error=keyme.ipc.NO_ERRORS)
        if svc is True:
            return 'service'
    except _IPC_ERRORS as e:
        keyme.log.error("Activity service check failed, assuming not service: %s", e)
    try:
        idle = keyme.status.remote.get(
            'abilities.idle_kiosk',
            logging=False,
            raise_on_error=keyme.ipc.NO_ERRORS)
        if idle is None or idle is True:
            return 'inactive'
        return 'active'
    except _IPC_ERRORS as e:
        keyme.log.error("Activity idle check failed, assuming inactive: %s", e)
        return 'inactive'


def is_kiosk_in_use():
    """True if kiosk is active (customer in use). For fleet command gating."""
    return get_activity() == 'active'
