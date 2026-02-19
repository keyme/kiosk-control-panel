# Wire protocol for control panel WebSocket (JSON over WebSocket).
# Client <-> Server message shapes. Python 3.6 compatible.

# Request events (client sends "event", server responds with same id).
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
)

# Events that accept optional "data" in the request.
EVENTS_WITH_DATA = frozenset(('take_image', 'log_tail_start'))

# Push events (server -> client, no id).
PUSH_HELLO = 'hello'
PUSH_WELLNESS_PROGRESS = 'wellness_progress'
PUSH_LOG_TAIL_LINE = 'log_tail_line'
PUSH_ASYNC_PREFIX = 'async.'

# Response: success shape has "success": True and "data"; error has "success": False and "errors".
