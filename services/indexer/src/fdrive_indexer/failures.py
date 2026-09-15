"""Durable per-file diagnostics; observing a failure must not fail processing."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Protocol
from uuid import uuid4

import psycopg

FEATURES = ("thumbnails", "textSearch", "semanticSearch", "imageSearch")


class Root(Protocol):
    root_id: int

    def conn(self) -> psycopg.Connection: ...


@dataclass
class Attempt:
    operation_ids: dict[str, str] = field(default_factory=dict)
    outcomes: dict[str, tuple[bool, bool]] = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid4()))


_current: ContextVar[Attempt | None] = ContextVar("processing_attempt", default=None)


@contextmanager
def attempt(operation_ids: dict[str, str] | None = None) -> Iterator[Attempt]:
    existing = _current.get()
    value = existing or Attempt(operation_ids or {})
    token = _current.set(value)
    try:
        yield value
    finally:
        _current.reset(token)


class FileResult(str):
    outcomes: dict[str, tuple[bool, bool]]

    def __new__(cls, value: str, outcomes: dict[str, tuple[bool, bool]]) -> FileResult:
        result = super().__new__(cls, value)
        result.outcomes = dict(outcomes)
        return result


def describe(error: BaseException) -> str:
    # ffmpeg's CalledProcessError normally hides stderr, which contains the actual cause.
    detail = getattr(error, "stderr", None)
    if isinstance(detail, bytes):
        detail = detail.decode("utf-8", errors="replace")
    return f"{type(error).__name__}: {detail[-1500:] if isinstance(detail, str) and detail else error}"[:2000]


def report(
    root: Root, path: str, feature: str, log: Callable[[str], None],
    error: str | None = None, *, code: str | None = None, skipped: bool = False, resolves: bool = False,
) -> None:
    current = _current.get()
    if current is not None:
        current.outcomes[feature] = (skipped or error is None, skipped)
    if skipped and not resolves:
        return  # A dependency wait or skipped attempt is not evidence of recovery.
    # A resolving skip read the file and found nothing to process, which settles earlier failures.
    operation_id = current.operation_ids.get(feature, current.id) if current else str(uuid4())
    try:
        # Savepoint isolation also works when a caller owns a larger transaction.
        with root.conn().transaction(), root.conn().cursor() as cur:
            if error is None:
                cur.execute(
                    'UPDATE idx.processing_failures SET resolved_at = now() '
                    'WHERE root_id = %s AND path = %s AND feature = %s AND resolved_at IS NULL',
                    (root.root_id, path, feature),
                )
            else:
                cur.execute(
                    'INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id) '
                    'VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (root_id, path, feature) DO UPDATE SET '
                    'code = EXCLUDED.code, message = EXCLUDED.message, operation_id = EXCLUDED.operation_id, '
                    'attempts = CASE WHEN processing_failures.resolved_at IS NULL '
                    'THEN processing_failures.attempts + 1 ELSE 1 END, '
                    'first_failed_at = CASE WHEN processing_failures.resolved_at IS NULL '
                    'THEN processing_failures.first_failed_at ELSE now() END, last_failed_at = now(), resolved_at = NULL',
                    (root.root_id, path, feature, (code or error.split(":", 1)[0])[:100], error[:2000], operation_id),
                )
    except Exception as exc:  # noqa: BLE001 - always retain evidence in the independent diagnostic log
        log(f"failure history unavailable for {feature} {path}: {describe(exc)}; result: {error or 'resolved'}")


def prune(conn: psycopg.Connection) -> None:
    """Keep all unresolved issues and at most 30 days / 10,000 resolved records."""
    with conn.cursor() as cur:
        cur.execute(
            'UPDATE idx.processing_failures p SET resolved_at = now() FROM idx.files f '
            'WHERE p.root_id = f.root_id AND p.path = f.path AND f.deleted_at IS NOT NULL AND p.resolved_at IS NULL'
        )
        cur.execute(
            "DELETE FROM idx.processing_failures WHERE resolved_at < now() - interval '30 days' "
            'OR id IN (SELECT id FROM idx.processing_failures WHERE resolved_at IS NOT NULL '
            'ORDER BY resolved_at DESC, id DESC OFFSET 10000)'
        )
