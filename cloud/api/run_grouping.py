# Shared 5-minute flexible run grouping for calibration APIs.
# Groups items by timestamp: consecutive items within max_gap_minutes are one run.
# Each item appears in exactly one run. run_id = earliest timestamp in the run.

from datetime import datetime
from typing import TypeVar

T = TypeVar("T")
TIMESTAMP_FMT = "%Y-%m-%d-%H-%M-%S-UTC"


def parse_timestamp(ts_str: str) -> datetime | None:
    """Parse YYYY-MM-DD-HH-MM-SS-UTC; return None if invalid."""
    if not ts_str or not ts_str.strip():
        return None
    try:
        return datetime.strptime(ts_str.strip(), TIMESTAMP_FMT)
    except (ValueError, TypeError):
        return None


def group_by_max_gap_minutes(
    items: list[tuple[str, T]], max_gap_minutes: int = 5
) -> list[tuple[str, str, list[T]]]:
    """
    Take list of (timestamp_str, payload). Parse timestamps, skip invalid, sort by datetime.
    Group into runs: consecutive items (by time) are in the same run if
    (current_dt - previous_dt).total_seconds() <= max_gap_minutes * 60.
    Return list of (run_id, end_ts, list_of_payloads) where run_id is the earliest
    and end_ts the latest timestamp string in that run. Each payload appears in exactly one run.
    """
    parsed = []
    for ts_str, payload in items:
        dt = parse_timestamp(ts_str)
        if dt is not None:
            parsed.append((dt, ts_str, payload))
    parsed.sort(key=lambda x: x[0])

    if not parsed:
        return []

    runs = []
    run_start_ts_str = parsed[0][1]
    run_end_ts_str = parsed[0][1]
    run_items = [parsed[0][2]]
    run_last_dt = parsed[0][0]

    for i in range(1, len(parsed)):
        dt, ts_str, payload = parsed[i]
        gap_seconds = (dt - run_last_dt).total_seconds()
        if gap_seconds <= max_gap_minutes * 60:
            run_items.append(payload)
            run_last_dt = dt
            run_end_ts_str = ts_str
        else:
            runs.append((run_start_ts_str, run_end_ts_str, run_items))
            run_start_ts_str = ts_str
            run_end_ts_str = ts_str
            run_items = [payload]
            run_last_dt = dt

    runs.append((run_start_ts_str, run_end_ts_str, run_items))
    return runs
