"""Tests for fleet event -> permission slug mapping."""

import pytest

from control_panel.cloud.api.ws_fleet_permissions import (
    EVENT_TO_PERMISSION,
    FLEET_EVENTS_REQUIRING_PERMISSION,
    required_permission,
)


class TestRequiredPermission:
    def test_fleet_reboot_kiosk_returns_reboot_kiosk(self):
        assert required_permission("fleet_reboot_kiosk") == "reboot_kiosk"

    def test_fleet_clear_cutter_stuck_returns_clear_cutter_stuck(self):
        assert required_permission("fleet_clear_cutter_stuck") == "clear_cutter_stuck"

    def test_fleet_restart_process_returns_restart_restart_all_process(self):
        assert required_permission("fleet_restart_process") == "restart_restart_all_process"

    def test_fleet_reset_device_returns_reset_all_cameras_device(self):
        assert required_permission("fleet_reset_device") == "reset_all_cameras_device"

    def test_fleet_switch_process_list_returns_switch_processes(self):
        assert required_permission("fleet_switch_process_list") == "switch_processes"

    def test_unknown_event_returns_none(self):
        assert required_permission("get_kiosk_name") is None
        assert required_permission("unknown_event") is None

    def test_fleet_events_set_matches_mapping(self):
        assert FLEET_EVENTS_REQUIRING_PERMISSION == frozenset(EVENT_TO_PERMISSION)
