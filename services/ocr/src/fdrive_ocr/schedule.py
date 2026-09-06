"""Pure computation of the next nightly OCR run time and timezone resolution.

`main.py` and `server.py` supply the current time (already resolved into the
configured timezone) as an argument, so everything here is a plain function of
its inputs and needs no mocking to test.
"""

from __future__ import annotations

from datetime import datetime, timedelta, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "UTC"


def resolve_timezone(name: str | None) -> tzinfo:
    """Resolves `name` (e.g. `TZ=Europe/Stockholm`) to a `tzinfo`, falling back
    to UTC for a missing or unknown name rather than raising."""
    if not name or not name.strip():
        return ZoneInfo(DEFAULT_TZ)
    try:
        return ZoneInfo(name.strip())
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def next_run_at(now: datetime, hour: int) -> datetime:
    """The next occurrence of `hour`:00:00 in `now`'s timezone: later today if
    that time has not passed yet, otherwise tomorrow. `hour` is clamped to
    0..23 so an out-of-range value (which `settings.py` should already have
    rejected) never raises here."""
    clamped = max(0, min(23, hour))
    candidate = now.replace(hour=clamped, minute=0, second=0, microsecond=0)
    if candidate <= now:
        candidate = candidate + timedelta(days=1)
    return candidate


def seconds_until(now: datetime, target: datetime) -> float:
    """Non-negative seconds from `now` to `target`, for feeding a sleep call."""
    return max(0.0, (target - now).total_seconds())
