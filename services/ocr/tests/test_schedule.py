from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from fdrive_ocr.schedule import next_run_at, resolve_timezone, seconds_until


def test_resolve_timezone_known_name() -> None:
    tz = resolve_timezone("Europe/Stockholm")
    assert tz.tzname(datetime(2026, 1, 1)) is not None
    assert str(tz) == "Europe/Stockholm"


def test_resolve_timezone_defaults_to_utc_when_missing() -> None:
    assert str(resolve_timezone(None)) == "UTC"
    assert str(resolve_timezone("")) == "UTC"
    assert str(resolve_timezone("   ")) == "UTC"


def test_resolve_timezone_defaults_to_utc_when_unknown() -> None:
    assert str(resolve_timezone("Not/AZone")) == "UTC"


def test_next_run_at_later_today() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 1, 0, tzinfo=tz)
    target = next_run_at(now, 3)
    assert target == datetime(2026, 1, 1, 3, 0, tzinfo=tz)


def test_next_run_at_tomorrow_when_hour_passed() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 5, 0, tzinfo=tz)
    target = next_run_at(now, 3)
    assert target == datetime(2026, 1, 2, 3, 0, tzinfo=tz)


def test_next_run_at_tomorrow_when_hour_is_exactly_now() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 3, 0, tzinfo=tz)
    target = next_run_at(now, 3)
    assert target == datetime(2026, 1, 2, 3, 0, tzinfo=tz)


def test_next_run_at_clamps_out_of_range_hour() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 1, 0, tzinfo=tz)
    assert next_run_at(now, 30).hour == 23
    assert next_run_at(now, -5).hour == 0


def test_seconds_until_positive() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 1, 0, tzinfo=tz)
    target = datetime(2026, 1, 1, 2, 0, tzinfo=tz)
    assert seconds_until(now, target) == 3600.0


def test_seconds_until_never_negative() -> None:
    tz = ZoneInfo("UTC")
    now = datetime(2026, 1, 1, 2, 0, tzinfo=tz)
    target = datetime(2026, 1, 1, 1, 0, tzinfo=tz)
    assert seconds_until(now, target) == 0.0
