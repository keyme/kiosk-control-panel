"""Unit tests for run_grouping – pure functions, no mocking required."""

import pytest

from control_panel.cloud.api.run_grouping import (
    TIMESTAMP_FMT,
    group_by_max_gap_minutes,
    parse_timestamp,
)


# ── parse_timestamp ──────────────────────────────────────────────────────────


class TestParseTimestamp:
    def test_valid_timestamp(self):
        dt = parse_timestamp("2026-01-15-10-00-00-UTC")
        assert dt is not None
        assert dt.year == 2026
        assert dt.month == 1
        assert dt.day == 15
        assert dt.hour == 10

    def test_none_input(self):
        assert parse_timestamp(None) is None

    def test_empty_string(self):
        assert parse_timestamp("") is None

    def test_whitespace_only(self):
        assert parse_timestamp("   ") is None

    def test_garbage(self):
        assert parse_timestamp("not-a-timestamp") is None

    def test_wrong_format(self):
        # ISO format should not match
        assert parse_timestamp("2026-01-15T10:00:00Z") is None


# ── group_by_max_gap_minutes ─────────────────────────────────────────────────


class TestGroupByMaxGap:
    def test_empty(self):
        assert group_by_max_gap_minutes([]) == []

    def test_single_item(self):
        items = [("2026-01-15-10-00-00-UTC", "payload1")]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 1
        run_id, end_ts, payloads = groups[0]
        assert run_id == "2026-01-15-10-00-00-UTC"
        assert end_ts == "2026-01-15-10-00-00-UTC"
        assert payloads == ["payload1"]

    def test_items_within_gap_form_one_run(self):
        items = [
            ("2026-01-15-10-00-00-UTC", "a"),
            ("2026-01-15-10-03-00-UTC", "b"),
            ("2026-01-15-10-04-00-UTC", "c"),
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 1
        assert groups[0][2] == ["a", "b", "c"]

    def test_items_beyond_gap_form_separate_runs(self):
        items = [
            ("2026-01-15-10-00-00-UTC", "a"),
            ("2026-01-15-10-10-00-UTC", "b"),  # 10 min gap > 5 min
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 2
        assert groups[0][2] == ["a"]
        assert groups[1][2] == ["b"]

    def test_run_id_is_earliest_end_ts_is_latest(self):
        items = [
            ("2026-01-15-10-04-00-UTC", "c"),
            ("2026-01-15-10-00-00-UTC", "a"),  # deliberately out of order
            ("2026-01-15-10-02-00-UTC", "b"),
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 1
        run_id, end_ts, payloads = groups[0]
        assert run_id == "2026-01-15-10-00-00-UTC"
        assert end_ts == "2026-01-15-10-04-00-UTC"
        # payloads sorted by datetime
        assert payloads == ["a", "b", "c"]

    def test_invalid_timestamps_are_skipped(self):
        items = [
            ("bad-ts", "skip"),
            ("2026-01-15-10-00-00-UTC", "keep"),
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 1
        assert groups[0][2] == ["keep"]

    def test_all_invalid_returns_empty(self):
        items = [("bad1", "a"), ("bad2", "b")]
        assert group_by_max_gap_minutes(items, max_gap_minutes=5) == []

    def test_exact_boundary_stays_in_same_run(self):
        """Gap of exactly max_gap_minutes should stay in the same run (<=)."""
        items = [
            ("2026-01-15-10-00-00-UTC", "a"),
            ("2026-01-15-10-05-00-UTC", "b"),  # exactly 5 min
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 1

    def test_one_second_over_boundary_splits(self):
        """Gap of max_gap_minutes + 1 second should create a new run."""
        items = [
            ("2026-01-15-10-00-00-UTC", "a"),
            ("2026-01-15-10-05-01-UTC", "b"),  # 5m01s > 5m
        ]
        groups = group_by_max_gap_minutes(items, max_gap_minutes=5)
        assert len(groups) == 2
