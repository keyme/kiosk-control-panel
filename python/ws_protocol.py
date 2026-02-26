# Wire protocol for control panel WebSocket (JSON over WebSocket).
# Client <-> Server message shapes. Python 3.6 compatible.

PROTOCOL_VERSION = 1

# Structured error code for unsupported command (version skew).
ERROR_UNSUPPORTED_COMMAND = 'unsupported_command'

# Request events (client sends "event", server responds with same id).
# Legacy list for reference; SUPPORTED_REQUEST_EVENTS is the single source of truth for capabilities.
REQUEST_EVENTS = (
    'get_kiosk_name',
    'get_panel_info',
    'get_activity',
    'get_computer_stats',
    'get_terminals',
    'get_wtf_why_degraded',
    'get_status_sections',
    'get_connection_count',
    'get_status_snapshot',
    'get_all_configs',
    'take_image',
    'get_wellness_check',
    'get_data_usage',
    'get_log_list',
    'log_tail_start',
    'log_tail_stop',
    'get_log_range',
    'get_roi',
    'save_roi',
)

# All request events the server supports (used for hello capabilities and unknown-command check).
# Must match event_handlers in ws_server.py.
SUPPORTED_REQUEST_EVENTS = (
    'get_kiosk_name',
    'get_panel_info',
    'get_activity',
    'get_computer_stats',
    'get_terminals',
    'get_wtf_why_degraded',
    'get_status_sections',
    'get_connection_count',
    'get_status_snapshot',
    'get_all_configs',
    'take_image',
    'get_wellness_check',
    'get_data_usage',
    'get_log_list',
    'log_tail_start',
    'log_tail_stop',
    'get_log_range',
    'run_log_analyze',
    'fleet_restart_process',
    'fleet_reset_device',
    'fleet_switch_process_list',
    'fleet_reboot_kiosk',
    'fleet_clear_cutter_stuck',
    'fleet_load_mom',
    'fleet_restore_cutting',
    'get_roi',
    'save_roi',
    'get_inventory_list',
    'get_inventory_disabled_reasons',
    'get_inventory_millings_styles',
    'inventory_enable_magazine',
    'inventory_disable_magazine',
    'inventory_set_key_count',
    'inventory_advanced_action',
    'inventory_update_api_pricing',
    'inventory_rotate_and_capture',
)

# Events that accept optional "data" in the request.
EVENTS_WITH_DATA = frozenset((
    'take_image', 'log_tail_start', 'get_log_range', 'run_log_analyze', 'get_roi', 'save_roi',
    'inventory_enable_magazine', 'inventory_disable_magazine', 'inventory_set_key_count',
    'inventory_advanced_action',
    'inventory_rotate_and_capture',
))

# Push events (server -> client, no id).
PUSH_HELLO = 'hello'
PUSH_WELLNESS_PROGRESS = 'wellness_progress'
PUSH_LOG_TAIL_LINE = 'log_tail_line'
PUSH_RESTART_ALL_LINE = 'restart_all_line'
PUSH_RESTART_ALL_DONE = 'restart_all_done'
PUSH_LOG_RANGE_BATCH = 'log_range_batch'
PUSH_LOG_RANGE_DONE = 'log_range_done'
PUSH_ASYNC_PREFIX = 'async.'

# Response: success shape has "success": True and "data"; error has "success": False and "errors".
