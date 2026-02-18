"""Fleet command event -> permission slug mapping for WebSocket proxy."""

EVENT_TO_PERMISSION: dict[str, str] = {
    "fleet_reboot_kiosk": "reboot_kiosk",
    "fleet_clear_cutter_stuck": "clear_cutter_stuck",
    "fleet_restart_process": "restart_restart_all_process",
    "fleet_reset_device": "reset_all_cameras_device",
    "fleet_switch_process_list": "switch_processes",
}

FLEET_EVENTS_REQUIRING_PERMISSION: frozenset[str] = frozenset(EVENT_TO_PERMISSION)


def required_permission(event: str) -> str | None:
    """Return the permission slug required for this fleet event, or None if not a gated fleet command."""
    return EVENT_TO_PERMISSION.get(event)
