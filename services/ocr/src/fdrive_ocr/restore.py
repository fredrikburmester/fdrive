"""I/O for kept originals: scanning `<state_dir>/originals` and its sidecars,
listing them with the current state of each source file, restoring one back
over its source path, deleting one, and pruning the ones a retention window has
aged out.

A restore is `runner.apply_rewrite` run backwards, and deliberately inherits its
durability properties: the replacement is staged in the destination directory,
hashed while it is copied, fsynced, given the destination's ownership and the
recorded mtime, and only then swapped in with `os.replace`, all inside the same
`db.backup_checkpoint` gate a rewrite takes. It then records a `restored` row in
the done-log for the restored file's own key, without which the next pass would
immediately OCR the file straight back again.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat as stat_module
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from . import db
from .originals import (
    REFUSAL_TARGET_CHANGED,
    REFUSAL_TARGET_MISSING,
    STATE_CHANGED,
    STATE_MISSING,
    STATUS_RESTORED,
    Mapping,
    TargetStat,
    classify_state,
    is_valid_id,
    mapping_document,
    matches_query,
    parse_mapping,
    restore_refusal,
    retention_cutoff,
)
from .runner import RootTarget, originals_dest

#: Never resolve a legacy original against more candidate rows than this; a
#: truncated candidate set cannot prove uniqueness, so it stays unresolved.
LEGACY_CANDIDATE_LIMIT = 1000

REASON_NOT_FOUND = "not_found"
REASON_UNRESOLVED = "unresolved"
REASON_UNKNOWN_ROOT = "unknown_root"
REASON_INVALID_PATH = "invalid_path"
REASON_PARENT_MISSING = "target_parent_missing"
REASON_CORRUPT = "corrupt"


def originals_dir(state_dir: str) -> str:
    return os.path.join(state_dir, "originals")


def mappings_dir(state_dir: str) -> str:
    return os.path.join(state_dir, "original-mappings")


def _mapping_path(state_dir: str, original_id: str) -> str:
    return os.path.join(mappings_dir(state_dir), f"{original_id}.json")


def read_mapping(state_dir: str, original_id: str) -> tuple[Mapping | None, float | None]:
    """The sidecar for `original_id`, plus the time it was written. A sidecar
    that is missing, unreadable or malformed reads as unresolved rather than
    raising: the kept bytes are still there to download."""
    path = _mapping_path(state_dir, original_id)
    try:
        with open(path, "rb") as handle:
            raw = json.load(handle)
            written_at = os.fstat(handle.fileno()).st_mtime
    except (OSError, ValueError):
        return None, None
    return parse_mapping(raw), written_at


def write_mapping(state_dir: str, mapping: Mapping, kept_at: float | None = None) -> None:
    """Atomically writes `mapping`'s sidecar. `kept_at`, when given, is stamped
    onto the file so a backfilled sidecar does not restart the retention clock
    for bytes that have been kept for months."""
    directory = mappings_dir(state_dir)
    os.makedirs(directory, exist_ok=True)
    fd, pending = tempfile.mkstemp(prefix=".mapping-", dir=directory)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(mapping_document(mapping), output)
            output.flush()
            os.fsync(output.fileno())
        if kept_at is not None:
            os.utime(pending, (kept_at, kept_at))
        os.replace(pending, _mapping_path(state_dir, mapping.original))
    finally:
        if os.path.exists(pending):
            os.remove(pending)


@dataclass(frozen=True)
class OriginalEntry:
    """One kept original as the listing sees it, before any live file is stat'd."""

    id: str
    size: int
    kept_at: float
    mapping: Mapping | None


def _kept_at(mapping: Mapping | None, sidecar_written_at: float | None, kept_stat: os.stat_result) -> float:
    """When the bytes were kept, best available source first.

    `apply_rewrite` copies the source's mtime onto the kept copy, so the kept
    file's own mtime is the age of the document, not of the copy, and must never
    drive retention. Newer keeps record `kept_at_ns` outright; older ones are
    dated by their sidecar; a legacy original with no sidecar at all falls back
    to the kept file's ctime, which `os.replace` set when it was put in place.
    """
    if mapping is not None and mapping.kept_at_ns is not None:
        return mapping.kept_at_ns / 1_000_000_000
    if sidecar_written_at is not None:
        return sidecar_written_at
    return kept_stat.st_ctime


def scan_originals(state_dir: str) -> list[OriginalEntry]:
    """Every kept original, newest first. Half-written `.original-`/`.mapping-`
    temporaries are skipped by the same identifier rule the HTTP API applies."""
    entries: list[OriginalEntry] = []
    try:
        with os.scandir(originals_dir(state_dir)) as scan:
            for entry in scan:
                if not is_valid_id(entry.name) or not entry.is_file(follow_symlinks=False):
                    continue
                kept_stat = entry.stat()
                mapping, written_at = read_mapping(state_dir, entry.name)
                entries.append(
                    OriginalEntry(
                        id=entry.name,
                        size=kept_stat.st_size,
                        kept_at=_kept_at(mapping, written_at, kept_stat),
                        mapping=mapping,
                    )
                )
    except FileNotFoundError:
        return []
    entries.sort(key=lambda item: (-item.kept_at, item.id))
    return entries


class OriginalsIndex:
    """A cached `scan_originals`, refreshed when either directory changes.

    The System page polls every five seconds, and both the stats tiles and the
    originals sheet need the same scan, so an unchanged state directory is
    walked once rather than once per poll per panel.
    """

    def __init__(self) -> None:
        self._key: tuple[int, int, int, int] | None = None
        self._entries: list[OriginalEntry] = []
        # The scheduler thread prunes with the same index the HTTP handlers read.
        self._lock = threading.Lock()

    @staticmethod
    def _directory_key(path: str) -> tuple[int, int]:
        try:
            info = os.stat(path)
        except OSError:
            return (0, 0)
        return (info.st_mtime_ns, info.st_size)

    def entries(self, state_dir: str) -> list[OriginalEntry]:
        key = self._directory_key(originals_dir(state_dir)) + self._directory_key(mappings_dir(state_dir))
        with self._lock:
            if key != self._key:
                self._entries = scan_originals(state_dir)
                self._key = key
            return self._entries

    def stats(self, state_dir: str) -> tuple[int, int]:
        entries = self.entries(state_dir)
        return len(entries), sum(entry.size for entry in entries)

    def invalidate(self) -> None:
        """Forces the next read to rescan, for a mutation a directory's mtime
        may not reflect (a sidecar rewritten in place at the same size)."""
        self._key = None


def originals_stats(state_dir: str) -> tuple[int, int]:
    """Count and total bytes of the kept originals under `state_dir`."""
    entries = scan_originals(state_dir)
    return len(entries), sum(entry.size for entry in entries)


def resolve_legacy(conn: psycopg.Connection, state_dir: str, entry: OriginalEntry) -> Mapping | None:
    """Recovers the source facts of an original kept before sidecars existed.

    The kept filename embeds a truncated hash of `root:path:size:mtime_ns` and
    the source's basename, and `apply_rewrite` copied the source's mtime onto
    the copy, so done-log rows with that mtime and basename are the candidates.
    Each is reverse-hashed and only an unambiguous single match is accepted. A
    match is written back out as a sidecar so the lookup happens once.
    """
    kept_path = os.path.join(originals_dir(state_dir), entry.id)
    try:
        kept_stat = os.stat(kept_path)
    except OSError:
        return None
    basename = entry.id[17:] if len(entry.id) > 17 and entry.id[16] == "_" else ""
    if not basename:
        return None
    candidates = db.legacy_candidates(conn, kept_stat.st_mtime_ns, basename, LEGACY_CANDIDATE_LIMIT)
    if len(candidates) > LEGACY_CANDIDATE_LIMIT:
        return None
    matches = [
        candidate
        for candidate in candidates
        if os.path.basename(originals_dest(state_dir, candidate[0], candidate[1], kept_stat.st_size, candidate[2])) == entry.id
    ]
    if len(matches) != 1:
        return None
    root, path, mtime_ns = matches[0]
    mapping = Mapping(
        root=root,
        path=path,
        size=kept_stat.st_size,
        mtime_ns=mtime_ns,
        original=entry.id,
        # Hashed from the bytes on disk now, not from the source as it was
        # kept: this detects damage after the backfill, not before it.
        sha256=_digest_file(kept_path),
        legacy=True,
        kept_at_ns=int(entry.kept_at * 1_000_000_000),
    )
    write_mapping(state_dir, mapping, kept_at=entry.kept_at)
    return mapping


def _digest_file(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


@dataclass(frozen=True)
class ListedOriginal:
    """A kept original paired with the current state of its source path."""

    id: str
    root: str | None
    path: str | None
    size: int
    kept_at: float
    sha256: str | None
    legacy: bool
    state: str | None

    def as_json(self) -> dict[str, object]:
        return {
            "id": self.id,
            "root": self.root,
            "path": self.path,
            "size": self.size,
            "kept_at": self.kept_at,
            "sha256": self.sha256,
            "legacy": self.legacy,
            "state": self.state,
        }


def _target_stat(abs_path: str) -> TargetStat | None:
    try:
        info = os.stat(abs_path)
    except OSError:
        return None
    return TargetStat(size=info.st_size, mtime_ns=info.st_mtime_ns)


def resolve_target_path(root_abs: str, rel_path: str) -> str | None:
    """Joins a recorded relative path onto its root, refusing anything that does
    not stay inside it. The sidecar is service-written, but it is also the only
    caller-reachable path input here, so containment is enforced rather than
    assumed: absolute paths, `..` traversal, and a parent directory that resolves
    through a symlink out of the root are all rejected."""
    if not rel_path or rel_path.startswith("/") or "\0" in rel_path:
        return None
    root_normalized = os.path.normpath(root_abs)
    candidate = os.path.normpath(os.path.join(root_normalized, rel_path))
    if candidate != root_normalized and not candidate.startswith(root_normalized + os.sep):
        return None
    root_real = os.path.realpath(root_normalized)
    parent_real = os.path.realpath(os.path.dirname(candidate))
    if parent_real != root_real and not parent_real.startswith(root_real + os.sep):
        return None
    return candidate


def list_originals(
    conn: psycopg.Connection,
    state_dir: str,
    targets: list[RootTarget],
    index: OriginalsIndex,
    query: str = "",
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[ListedOriginal], int]:
    """One page of kept originals, with the live state of each source path.

    Only the page is stat'd and only its paths are looked up in the done-log, so
    the cost of opening the sheet does not grow with the size of the archive.
    Legacy originals on the page are resolved (and their sidecars backfilled) as
    they are listed.
    """
    entries = index.entries(state_dir)
    matched = [entry for entry in entries if matches_query(entry.mapping, entry.id, query)]
    page = matched[max(offset, 0) : max(offset, 0) + max(limit, 0)]

    resolved: list[tuple[OriginalEntry, Mapping | None]] = []
    backfilled = False
    for entry in page:
        mapping = entry.mapping
        if mapping is None:
            mapping = resolve_legacy(conn, state_dir, entry)
            backfilled = backfilled or mapping is not None
        resolved.append((entry, mapping))
    if backfilled:
        index.invalidate()

    targets_by_name = {target.name: target for target in targets}
    paths_by_root: dict[str, list[str]] = {}
    for _entry, mapping in resolved:
        if mapping is not None and mapping.root in targets_by_name:
            paths_by_root.setdefault(mapping.root, []).append(mapping.path)
    ocred: dict[str, dict[str, frozenset[tuple[int, int]]]] = {
        root: db.ocred_keys_for_paths(conn, targets_by_name[root].root_id, paths)
        for root, paths in paths_by_root.items()
    }

    listed: list[ListedOriginal] = []
    for entry, mapping in resolved:
        state: str | None = None
        if mapping is not None:
            target = targets_by_name.get(mapping.root)
            abs_path = None if target is None else resolve_target_path(target.abs_path, mapping.path)
            if abs_path is not None:
                state = classify_state(
                    _target_stat(abs_path),
                    mapping.size,
                    mapping.mtime_ns,
                    ocred.get(mapping.root, {}).get(mapping.path, frozenset()),
                )
        listed.append(
            ListedOriginal(
                id=entry.id,
                root=None if mapping is None else mapping.root,
                path=None if mapping is None else mapping.path,
                size=entry.size,
                kept_at=entry.kept_at,
                sha256=None if mapping is None else mapping.sha256,
                legacy=mapping.legacy if mapping is not None else True,
                state=state,
            )
        )
    return listed, len(matched)


@dataclass(frozen=True)
class RestoreOutcome:
    ok: bool
    reason: str | None = None
    state: str | None = None
    root: str | None = None
    path: str | None = None


def _copy_verified(source: str, destination_dir: str) -> tuple[str, str]:
    """Copies `source` into a temporary file in `destination_dir`, returning the
    staged path and the SHA-256 of what was actually written, so the caller can
    refuse to swap in bytes that no longer hash to what was kept."""
    digest = hashlib.sha256()
    fd, pending = tempfile.mkstemp(prefix="._fdrive-restore-", dir=destination_dir)
    try:
        with os.fdopen(fd, "wb") as output, open(source, "rb") as original:
            while chunk := original.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        if os.path.exists(pending):
            os.remove(pending)
        raise
    return pending, digest.hexdigest()


def _fsync_directory(path: str) -> None:
    directory_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _live_stat(path: str) -> os.stat_result | None:
    """Do not mistake unreadable files for absent ones, or follow leaf symlinks."""
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None


def _file_version(info: os.stat_result | None) -> tuple[int, ...] | None:
    if info is None:
        return None
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)


def restore_original(
    conn: psycopg.Connection,
    state_dir: str,
    targets: list[RootTarget],
    index: OriginalsIndex,
    original_id: str,
    allow_recreate: bool,
    allow_overwrite_changed: bool,
    log: Callable[[str], None],
) -> RestoreOutcome:
    """Puts one kept original back at its source path. See the module docstring
    for the ordering guarantees; nothing is removed from `<state_dir>/originals`,
    so a restore can be repeated and the kept bytes stay available."""
    if not is_valid_id(original_id):
        return RestoreOutcome(False, REASON_NOT_FOUND)
    kept_path = os.path.join(originals_dir(state_dir), original_id)
    try:
        kept_stat = os.lstat(kept_path)
    except OSError:
        return RestoreOutcome(False, REASON_NOT_FOUND)
    if not stat_module.S_ISREG(kept_stat.st_mode):
        return RestoreOutcome(False, REASON_NOT_FOUND)

    mapping, sidecar_written_at = read_mapping(state_dir, original_id)
    if mapping is None:
        entry = OriginalEntry(
            id=original_id,
            size=kept_stat.st_size,
            kept_at=_kept_at(None, sidecar_written_at, kept_stat),
            mapping=None,
        )
        mapping = resolve_legacy(conn, state_dir, entry)
        if mapping is not None:
            index.invalidate()
    if mapping is None:
        return RestoreOutcome(False, REASON_UNRESOLVED)

    target = next((item for item in targets if item.name == mapping.root), None)
    if target is None:
        return RestoreOutcome(False, REASON_UNKNOWN_ROOT, root=mapping.root, path=mapping.path)
    with db.ocr_file_lock(conn, target.root_id, mapping.path), db.backup_checkpoint(conn):
        abs_path = resolve_target_path(target.abs_path, mapping.path)
        if abs_path is None:
            return RestoreOutcome(False, REASON_INVALID_PATH, root=mapping.root, path=mapping.path)
        live = _live_stat(abs_path)
        if live is not None and not stat_module.S_ISREG(live.st_mode):
            return RestoreOutcome(False, REASON_INVALID_PATH, root=mapping.root, path=mapping.path)
        current = None if live is None else TargetStat(live.st_size, live.st_mtime_ns)
        version = _file_version(live)
        ocred = db.ocred_keys_for_paths(conn, target.root_id, [mapping.path]).get(mapping.path, frozenset())
        state = classify_state(current, mapping.size, mapping.mtime_ns, ocred)
        refusal = restore_refusal(state, allow_recreate, allow_overwrite_changed)
        if refusal is not None:
            return RestoreOutcome(False, refusal, state=state, root=mapping.root, path=mapping.path)

        parent = os.path.dirname(abs_path)
        if not os.path.isdir(parent):
            # Recreating the tree would invent ownership and permissions.
            return RestoreOutcome(False, REASON_PARENT_MISSING, state=state, root=mapping.root, path=mapping.path)
        pending, digest = _copy_verified(kept_path, parent)
        try:
            if mapping.sha256 is not None and digest != mapping.sha256:
                return RestoreOutcome(False, REASON_CORRUPT, state=state, root=mapping.root, path=mapping.path)
            # Ownership and permissions come from the file being replaced. When
            # it is gone, the kept copy carries the source's mode (`apply_rewrite`
            # copied it) and the parent directory is the only owner evidence left.
            reference = live if live is not None else os.stat(parent)
            os.chmod(pending, stat_module.S_IMODE(reference.st_mode if live is not None else kept_stat.st_mode))
            try:
                os.chown(pending, reference.st_uid, reference.st_gid)
            except (PermissionError, OSError):
                pass  # not running as root, or the filesystem has no ownership; best effort
            os.utime(pending, ns=(mapping.mtime_ns, mapping.mtime_ns))
            # Storage writers do not take the OCR lock. Opt-ins authorize the
            # version inspected above, not edits/deletion/recreation during I/O.
            if resolve_target_path(target.abs_path, mapping.path) != abs_path:
                return RestoreOutcome(False, REASON_INVALID_PATH, root=mapping.root, path=mapping.path)
            latest = _live_stat(abs_path)
            if _file_version(latest) != version:
                missing = latest is None
                return RestoreOutcome(
                    False, REFUSAL_TARGET_MISSING if missing else REFUSAL_TARGET_CHANGED,
                    state=STATE_MISSING if missing else STATE_CHANGED, root=mapping.root, path=mapping.path,
                )
            os.replace(pending, abs_path)
        finally:
            if os.path.exists(pending):
                os.remove(pending)
        _fsync_directory(parent)
        db.record_ocr_log(
            conn, target.root_id, mapping.path, mapping.size, mapping.mtime_ns, STATUS_RESTORED, "original restored"
        )
    index.invalidate()
    log(f"[{mapping.root}] restored original: {mapping.path}")
    return RestoreOutcome(True, state=state, root=mapping.root, path=mapping.path)


def delete_original(conn: psycopg.Connection, state_dir: str, index: OriginalsIndex, original_id: str) -> bool:
    """Removes the kept bytes and their sidecar. Irreversible, and the only way
    to reclaim the space a kept original occupies."""
    if not is_valid_id(original_id):
        return False
    with db.backup_checkpoint(conn):
        kept_path = os.path.join(originals_dir(state_dir), original_id)
        try:
            os.remove(kept_path)
        except OSError:
            return False
        try:
            os.remove(_mapping_path(state_dir, original_id))
        except OSError:
            pass  # a legacy original has no sidecar, and a missing one is not a failure
    index.invalidate()
    return True


def open_original(state_dir: str, original_id: str) -> tuple[str, int] | None:
    """The absolute path and size of a kept original's bytes, for download."""
    if not is_valid_id(original_id):
        return None
    kept_path = os.path.join(originals_dir(state_dir), original_id)
    try:
        info = os.lstat(kept_path)
    except OSError:
        return None
    if not stat_module.S_ISREG(info.st_mode):
        return None
    return kept_path, info.st_size


def prune_originals(
    conn: psycopg.Connection,
    state_dir: str,
    index: OriginalsIndex,
    retention_days: int,
    log: Callable[[str], None],
    now: Callable[[], float] = time.time,
) -> tuple[int, int]:
    """Deletes kept originals older than the retention window, returning
    `(count, bytes)` reclaimed. Retention is off by default, so an installation
    that upgrades into this setting never silently loses bytes."""
    cutoff = retention_cutoff(now(), retention_days)
    if cutoff is None:
        return 0, 0
    removed, reclaimed = 0, 0
    for entry in list(index.entries(state_dir)):
        if entry.kept_at >= cutoff:
            continue
        if delete_original(conn, state_dir, index, entry.id):
            removed += 1
            reclaimed += entry.size
    if removed:
        log(f"pruned {removed} kept original(s) older than {retention_days} days, reclaiming {reclaimed} bytes")
    return removed, reclaimed
