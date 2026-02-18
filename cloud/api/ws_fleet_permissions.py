"""Fleet command event -> permission slug mapping for WebSocket proxy. Re-exports from shared module."""

from control_panel.fleet_permissions import (
    EVENT_TO_PERMISSION,
    FLEET_EVENTS_REQUIRING_PERMISSION,
    required_permission,
)

__all__ = ["EVENT_TO_PERMISSION", "FLEET_EVENTS_REQUIRING_PERMISSION", "required_permission"]
