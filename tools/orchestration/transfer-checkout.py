#!/usr/bin/env python3
"""Safe baseline snapshots and uncommitted worker-delta transfers."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Iterable, Mapping


STATE_DIR = ".fdrive-workflow"
MANIFEST_NAME = "baseline.json"
MANIFEST_VERSION = 1
BASELINE_DATA_DIR = "baseline-data"
SENSITIVE_NAMES = {b".env", b"id_rsa", b"id_dsa", b"id_ecdsa", b"id_ed25519"}
SENSITIVE_SUFFIXES = (b".pem", b".key", b".p12", b".pfx")


class TransferError(Exception):
    pass


class LockError(TransferError):
    pass


@dataclass(frozen=True)
class Entry:
    kind: str
    mode: int | None = None
    digest: str | None = None
    target: str | None = None


def fail(message: str) -> None:
    raise TransferError(message)


def git(root: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "-C", os.fspath(root), *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        fail(f"git {' '.join(args)} failed{': ' + detail if detail else ''}")
    return result.stdout


def checkout(value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_dir():
        fail(f"checkout is not a directory: {value}")
    root = Path(git(candidate, "rev-parse", "--show-toplevel").decode().strip())
    try:
        requested = candidate.resolve(strict=True)
        resolved = root.resolve(strict=True)
    except OSError as error:
        fail(f"cannot resolve checkout {value}: {error}")
    if requested != resolved:
        fail(f"checkout must name the Git repository root: {value}")
    return resolved


def common_dir(root: Path) -> Path:
    value = git(root, "rev-parse", "--git-common-dir").decode().strip()
    common = Path(value)
    if not common.is_absolute():
        common = root / common
    return common.resolve(strict=True)


def head(root: Path) -> str:
    return git(root, "rev-parse", "HEAD").decode().strip()


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def unb64(value: object, label: str) -> bytes:
    if not isinstance(value, str):
        fail(f"baseline manifest {label} must be a string")
    try:
        return base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, ValueError):
        fail(f"baseline manifest {label} is not valid base64")


def display(path: bytes) -> str:
    return os.fsdecode(path).replace("\n", "\\n")


def validate_path(path: bytes) -> None:
    if not path or path.startswith(b"/") or b"\x00" in path:
        fail("unsafe empty, absolute, or NUL path")
    parts = path.split(b"/")
    if any(part in (b"", b".", b"..") for part in parts):
        fail(f"unsafe path: {display(path)}")
    if parts[0] in (b".git", STATE_DIR.encode()):
        fail(f"reserved workflow path: {display(path)}")
    if (
        (parts[-1].startswith(b".env") and parts[-1] != b".env.example")
        or parts[-1] in SENSITIVE_NAMES
        or parts[-1].endswith(SENSITIVE_SUFFIXES)
    ):
        fail(f"refusing sensitive path: {display(path)}")


def checked_path(root: Path, rel: bytes, create_parents: bool = False) -> bytes:
    validate_path(rel)
    root_bytes = os.fsencode(root)
    current = root_bytes
    parts = rel.split(b"/")
    for index, part in enumerate(parts[:-1]):
        current = os.path.join(current, part)
        try:
            mode = os.lstat(current).st_mode
        except FileNotFoundError:
            if not create_parents:
                continue
            os.mkdir(current, 0o755)
            mode = os.lstat(current).st_mode
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            fail(f"symlink or non-directory ancestor for {display(rel)}")
    return os.path.join(root_bytes, *parts)


def safe_unlink(path: bytes) -> None:
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if stat.S_ISDIR(mode) and not stat.S_ISLNK(mode):
        fail(f"refusing to replace directory at {os.fsdecode(path)}")
    os.unlink(path)


def git_paths(root: Path) -> set[bytes]:
    tracked = git(root, "ls-files", "-z")
    untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
    paths = {value for value in tracked.split(b"\0") if value}
    state_prefix = STATE_DIR.encode() + b"/"
    if any(path == STATE_DIR.encode() or path.startswith(state_prefix) for path in paths):
        fail("workflow state paths must not be tracked")
    paths.update(
        value
        for value in untracked.split(b"\0")
        if value and value != STATE_DIR.encode() and not value.startswith(state_prefix)
    )
    for path in paths:
        validate_path(path)
    return paths


def digest_file(path: bytes) -> str:
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def entry_for(root: Path, rel: bytes) -> Entry:
    location = checked_path(root, rel)
    try:
        details = os.lstat(location)
    except FileNotFoundError:
        return Entry("absent")
    if stat.S_ISLNK(details.st_mode):
        target = os.readlink(location)
        return Entry("symlink", target=b64(target.encode() if isinstance(target, str) else target))
    if stat.S_ISREG(details.st_mode):
        return Entry("file", mode=stat.S_IMODE(details.st_mode), digest=digest_file(location))
    fail(f"unsupported file type: {display(rel)}")


def snapshot(root: Path, paths: Iterable[bytes] | None = None) -> dict[bytes, Entry]:
    candidates = git_paths(root) if paths is None else set(paths)
    return {path: entry_for(root, path) for path in candidates}


def entry_json(entry: Entry) -> dict[str, object]:
    value: dict[str, object] = {"kind": entry.kind}
    if entry.mode is not None:
        value["mode"] = entry.mode
    if entry.digest is not None:
        value["digest"] = entry.digest
    if entry.target is not None:
        value["target"] = entry.target
    return value


def read_entry(value: object) -> Entry:
    if not isinstance(value, dict):
        fail("baseline manifest entry must be an object")
    kind = value.get("kind")
    if kind == "absent":
        if set(value) != {"kind"}:
            fail("baseline absent entry has extra fields")
        return Entry("absent")
    if kind == "file":
        mode, digest = value.get("mode"), value.get("digest")
        if set(value) != {"kind", "mode", "digest"} or not isinstance(mode, int) or not isinstance(digest, str):
            fail("baseline file entry is malformed")
        if mode < 0 or mode > 0o7777 or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            fail("baseline file entry has invalid mode or digest")
        return Entry("file", mode=mode, digest=digest)
    if kind == "symlink":
        target = value.get("target")
        if set(value) != {"kind", "target"} or not isinstance(target, str):
            fail("baseline symlink entry is malformed")
        unb64(target, "symlink target")
        return Entry("symlink", target=target)
    fail("baseline entry has unknown kind")


def manifest_path(root: Path) -> Path:
    state = root / STATE_DIR
    if state.is_symlink():
        fail(f"workflow state directory must not be a symlink: {state}")
    return state / MANIFEST_NAME


def load_manifest(root: Path) -> tuple[str, dict[bytes, Entry]] | None:
    path = manifest_path(root)
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        fail(f"baseline manifest must be a regular file: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"cannot read baseline manifest: {error}")
    if not isinstance(raw, dict) or set(raw) != {"version", "head", "entries"}:
        fail("baseline manifest has an unexpected shape")
    if raw.get("version") != MANIFEST_VERSION or not isinstance(raw.get("head"), str) or not isinstance(raw.get("entries"), dict):
        fail("baseline manifest version, head, or entries is invalid")
    entries: dict[bytes, Entry] = {}
    for encoded, value in raw["entries"].items():
        path_bytes = unb64(encoded, "path")
        validate_path(path_bytes)
        if path_bytes in entries:
            fail("baseline manifest duplicates a path")
        entries[path_bytes] = read_entry(value)
    return raw["head"], entries


def write_manifest(root: Path, base_head: str, entries: Mapping[bytes, Entry]) -> None:
    path = manifest_path(root)
    state = path.parent
    if not state.exists():
        state.mkdir(mode=0o700)
    if state.is_symlink() or not state.is_dir():
        fail(f"workflow state directory is unsafe: {state}")
    payload = {
        "version": MANIFEST_VERSION,
        "head": base_head,
        "entries": {b64(key): entry_json(entries[key]) for key in sorted(entries)},
    }
    encoded = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix="baseline.", dir=state)
    try:
        os.write(fd, encoded)
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    try:
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def baseline_data_path(root: Path, rel: bytes) -> Path:
    token = hashlib.sha256(rel).hexdigest()
    return root / STATE_DIR / BASELINE_DATA_DIR / token


def save_non_head_files(root: Path, entries: Mapping[bytes, Entry], head_entries: Mapping[bytes, Entry]) -> None:
    directory = root / STATE_DIR / BASELINE_DATA_DIR
    if directory.is_symlink():
        fail(f"baseline data directory must not be a symlink: {directory}")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        fail(f"baseline data directory is unsafe: {directory}")
    for rel, entry in entries.items():
        if entry.kind != "file" or entry == head_entries.get(rel, Entry("absent")):
            continue
        source = checked_path(root, rel)
        destination = baseline_data_path(root, rel)
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            fail(f"baseline data path is unsafe: {destination}")
        temporary = destination.with_name(f"{destination.name}.tmp")
        if temporary.exists() or temporary.is_symlink():
            fail(f"baseline temporary data path exists: {temporary}")
        with open(source, "rb") as input_file, open(temporary, "xb") as output_file:
            shutil.copyfileobj(input_file, output_file, 1024 * 1024)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)


def baseline_file_bytes(root: Path, rel: bytes, entry: Entry, head_entries: Mapping[bytes, Entry]) -> bytes:
    if entry.kind != "file" or entry.digest is None:
        fail("internal invalid baseline file entry")
    if entry == head_entries.get(rel, Entry("absent")):
        record = next(
            (value for value in git(root, "ls-tree", "-r", "-z", "HEAD").split(b"\0") if value.endswith(b"\t" + rel)),
            None,
        )
        if record is None:
            fail(f"cannot find baseline Git blob: {display(rel)}")
        object_id = record.split(b"\t", 1)[0].split(b" ", 2)[2]
        return git(root, "cat-file", "blob", object_id.decode("ascii"))
    stored = baseline_data_path(root, rel)
    if stored.parent.is_symlink() or not stored.parent.is_dir():
        fail(f"baseline data directory is unsafe: {stored.parent}")
    if stored.is_symlink() or not stored.is_file():
        fail(f"baseline data missing or unsafe: {stored}")
    content = stored.read_bytes()
    if hashlib.sha256(content).hexdigest() != entry.digest:
        fail(f"baseline data digest mismatch: {display(rel)}")
    return content


class CheckoutLock:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / STATE_DIR / "command.lock"
        self.held = False
        self.token = ""

    def acquire(self) -> None:
        state = self.path.parent
        if state.is_symlink():
            fail(f"workflow state directory must not be a symlink: {state}")
        try:
            state.mkdir(mode=0o700, exist_ok=True)
        except OSError as error:
            fail(f"cannot create workflow state directory: {error}")
        if state.is_symlink() or not state.is_dir():
            fail(f"workflow state directory is unsafe: {state}")
        if self.path.is_symlink():
            fail(f"checkout operation lock must not be a symlink: {self.path}")
        try:
            self.path.mkdir()
        except FileExistsError:
            owner = self.path / "owner"
            lines = owner.read_text(encoding="utf-8", errors="replace").splitlines() if owner.is_file() else []
            detail = lines[0] if lines else ""
            raise LockError(f"checkout operation lock is held at {self.path}{' (' + detail + ')' if detail else ''}")
        self.held = True
        self.token = f"{os.getpid()}:{os.urandom(16).hex()}"
        (self.path / "owner").write_text(f"pid {os.getpid()} checkout {self.root}\n", encoding="utf-8")
        (self.path / "token").write_text(f"{self.token}\n", encoding="ascii")

    def release(self) -> None:
        if not self.held:
            return
        if self.path.is_symlink() or not self.path.is_dir():
            self.held = False
            return
        token_path = self.path / "token"
        try:
            token = token_path.read_text(encoding="ascii").strip()
        except OSError:
            token = ""
        if token == self.token:
            for child in (self.path / "owner", token_path):
                if child.is_file() and not child.is_symlink():
                    child.unlink()
            try:
                self.path.rmdir()
            except OSError:
                pass
        self.held = False


def lock_pair(one: Path, two: Path) -> list[CheckoutLock]:
    roots = sorted({one, two}, key=os.fspath)
    locks = [CheckoutLock(root) for root in roots]
    try:
        for lock in locks:
            lock.acquire()
    except BaseException:
        for lock in reversed(locks):
            lock.release()
        raise
    return locks


def unlock(locks: Iterable[CheckoutLock]) -> None:
    for lock in reversed(list(locks)):
        lock.release()


def ensure_same_repository(source: Path, target: Path) -> None:
    if source == target:
        fail("source and target must be different checkouts")
    if common_dir(source) != common_dir(target):
        fail("source and target must share a Git repository")


def copy_entry(source: Path, target: Path, rel: bytes, desired: Entry) -> None:
    destination = checked_path(target, rel, create_parents=desired.kind != "absent")
    if desired.kind == "absent":
        safe_unlink(destination)
        return
    parent = os.path.dirname(destination)
    descriptor, temporary = tempfile.mkstemp(prefix=b".fdrive-transfer-", dir=parent)
    if desired.kind == "symlink":
        assert desired.target is not None
        os.close(descriptor)
        os.unlink(temporary)
        try:
            os.symlink(unb64(desired.target, "symlink target"), temporary)
            os.replace(temporary, destination)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise
        return
    if desired.kind != "file" or desired.mode is None:
        os.close(descriptor)
        os.unlink(temporary)
        fail("internal invalid desired entry")
    source_path = checked_path(source, rel)
    try:
        with open(source_path, "rb") as input_file, os.fdopen(descriptor, "wb") as output_file:
            shutil.copyfileobj(input_file, output_file, 1024 * 1024)
            output_file.flush()
            os.fsync(output_file.fileno())
        if digest_file(temporary) != desired.digest:
            fail(f"source payload changed during transfer: {display(rel)}")
        os.chmod(temporary, desired.mode)
        os.replace(temporary, destination)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def current_with_base(root: Path, baseline: Mapping[bytes, Entry]) -> dict[bytes, Entry]:
    return snapshot(root, set(baseline) | git_paths(root))


def changed_entries(baseline: Mapping[bytes, Entry], current: Mapping[bytes, Entry]) -> list[bytes]:
    return sorted(path for path in set(baseline) | set(current) if baseline.get(path, Entry("absent")) != current.get(path, Entry("absent")))


def check_allowed(paths: Iterable[bytes], allowed: str) -> None:
    import re

    try:
        expression = re.compile(f"^({allowed})")
    except re.error as error:
        fail(f"ALLOWED is not a valid extended regular expression: {error}")
    for path in paths:
        text = os.fsdecode(path)
        if path != b"pnpm-lock.yaml" and expression.search(text) is None:
            fail(f"out of scope: {display(path)}")


def staged_paths(root: Path) -> set[bytes]:
    paths = {value for value in git(root, "diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD").split(b"\0") if value}
    for path in paths:
        validate_path(path)
    return paths


def reject_unfinished_state(root: Path) -> None:
    for state in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"):
        location = Path(git(root, "rev-parse", "--git-path", state).decode().strip())
        if not location.is_absolute():
            location = root / location
        if location.exists():
            fail(f"unfinished Git operation in {root} ({state})")


def reject_conflicts_and_stash(root: Path) -> None:
    status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
    entries = [entry for entry in status.split(b"\0") if entry]
    conflicts = {b"DD", b"AU", b"UD", b"UA", b"DU", b"AA", b"UU"}
    for entry in entries:
        if entry[:2] in conflicts:
            fail(f"unresolved conflict: {display(entry[3:])}")
    if git(root, "stash", "list"):
        fail("repository stash must be empty")


def destination_is_dirty(root: Path) -> bool:
    raw = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none")
    records = [record for record in raw.split(b"\0") if record]
    index = 0
    state_prefix = STATE_DIR.encode() + b"/"
    while index < len(records):
        record = records[index]
        if len(record) < 4:
            return True
        code, path = record[:2], record[3:]
        paths = [path]
        if b"R" in code or b"C" in code:
            index += 1
            if index >= len(records):
                return True
            paths.append(records[index])
        if code != b"??" or any(path != STATE_DIR.encode() and not path.startswith(state_prefix) for path in paths):
            return True
        index += 1
    return False


def baseline_for(root: Path) -> tuple[str, dict[bytes, Entry], bool]:
    loaded = load_manifest(root)
    if loaded is None:
        return head(root), snapshot_head(root), False
    base_head, entries = loaded
    if head(root) != base_head:
        fail("baseline manifest HEAD does not match checkout HEAD")
    return base_head, entries, True


def snapshot_head(root: Path) -> dict[bytes, Entry]:
    result: dict[bytes, Entry] = {}
    records = [value for value in git(root, "ls-tree", "-r", "-z", "HEAD").split(b"\0") if value]
    parsed: list[tuple[bytes, int, bytes]] = []
    for record in records:
        metadata, path = record.split(b"\t", 1)
        validate_path(path)
        mode_text, _kind, object_id = metadata.split(b" ", 2)
        parsed.append((path, int(mode_text, 8), object_id))
    process = subprocess.Popen(
        ["git", "-C", os.fspath(root), "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE
    )
    assert process.stdin is not None and process.stdout is not None
    try:
        for path, mode, object_id in parsed:
            process.stdin.write(object_id + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().rstrip(b"\n").split()
            if len(header) != 3 or header[0] != object_id or header[1] != b"blob":
                fail(f"cannot read baseline Git blob: {display(path)}")
            size = int(header[2])
            raw = process.stdout.read(size)
            if len(raw) != size or process.stdout.read(1) != b"\n":
                fail(f"truncated baseline Git blob: {display(path)}")
            if mode == 0o120000:
                result[path] = Entry("symlink", target=b64(raw))
            else:
                result[path] = Entry("file", mode=0o755 if mode & 0o111 else 0o644, digest=hashlib.sha256(raw).hexdigest())
    finally:
        process.stdin.close()
        process.stdout.close()
    if process.wait() != 0:
        fail("cannot read baseline Git blobs")
    return result


def run_baseline(source_arg: str, target_arg: str) -> None:
    source, target = checkout(source_arg), checkout(target_arg)
    ensure_same_repository(source, target)
    locks = lock_pair(source, target)
    try:
        reject_unfinished_state(source)
        reject_unfinished_state(target)
        reject_conflicts_and_stash(source)
        if load_manifest(target) is not None:
            fail("destination already has a baseline manifest")
        if destination_is_dirty(target):
            fail("destination checkout must be pristine before baseline copy")
        if head(source) != head(target):
            fail("source and destination HEAD must match before baseline copy")
        source_state = snapshot(source)
        destination_state = current_with_base(target, source_state)
        changes = changed_entries(destination_state, source_state)
        for rel in changes:
            copy_entry(source, target, rel, source_state.get(rel, Entry("absent")))
        verified = current_with_base(target, source_state)
        if verified != source_state:
            fail("baseline copy verification failed")
        head_entries = snapshot_head(target)
        save_non_head_files(target, source_state, head_entries)
        write_manifest(target, head(source), source_state)
        print(f"baseline recorded: {len(source_state)} paths")
    finally:
        unlock(locks)


def run_review(worktree_arg: str, allowed: str) -> None:
    root = checkout(worktree_arg)
    if not allowed:
        fail("ALLOWED must be a nonempty path-prefix regex")
    reject_unfinished_state(root)
    reject_conflicts_and_stash(root)
    _, baseline, _ = baseline_for(root)
    current = current_with_base(root, baseline)
    changes = changed_entries(baseline, current)
    check_allowed(set(changes) | staged_paths(root), allowed)
    for path in changes:
        print(f"delta {display(path)}")
    print("Review passed: scope, conflicts, stash.")


def run_transfer(source_arg: str, target_arg: str, allowed: str, check_only: bool) -> None:
    if not allowed:
        fail("ALLOWED must be a nonempty path-prefix regex")
    source, target = checkout(source_arg), checkout(target_arg)
    ensure_same_repository(source, target)
    locks = lock_pair(source, target)
    try:
        reject_unfinished_state(source)
        reject_unfinished_state(target)
        reject_conflicts_and_stash(source)
        _, baseline, _ = baseline_for(source)
        source_head = head(source)
        if head(target) != source_head:
            fail("source and target HEAD must match")
        current = current_with_base(source, baseline)
        changes = changed_entries(baseline, current)
        check_allowed(set(changes) | staged_paths(source), allowed)
        target_current = current_with_base(target, baseline)
        conflicts: list[bytes] = []
        for path in changes:
            before = baseline.get(path, Entry("absent"))
            desired = current.get(path, Entry("absent"))
            actual = target_current.get(path, Entry("absent"))
            if actual != before and actual != desired:
                conflicts.append(path)
        if conflicts:
            joined = ", ".join(display(path) for path in conflicts)
            fail(f"target conflicts with baseline: {joined}")
        action = "would transfer" if check_only else "transferred"
        for path in changes:
            print(f"{action}: {display(path)}")
        if check_only:
            print(f"Transfer check passed: {len(changes)} paths.")
            return
        for path in changes:
            desired = current.get(path, Entry("absent"))
            actual = target_current.get(path, Entry("absent"))
            if actual != desired:
                copy_entry(source, target, path, desired)
        verified = current_with_base(target, baseline)
        for path in changes:
            if verified.get(path, Entry("absent")) != current.get(path, Entry("absent")):
                fail(f"post-copy verification failed: {display(path)}")
        print(f"Transfer passed: {len(changes)} paths verified.")
    finally:
        unlock(locks)


def text_or_binary(content: bytes) -> str | None:
    if b"\0" in content:
        return None
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return None


def entry_summary(entry: Entry) -> str:
    if entry.kind == "absent":
        return "absent"
    if entry.kind == "file":
        assert entry.mode is not None and entry.digest is not None
        return f"file mode={entry.mode:04o} sha256={entry.digest}"
    assert entry.target is not None
    return f"symlink sha256={hashlib.sha256(unb64(entry.target, 'symlink target')).hexdigest()}"


def run_diff(worktree_arg: str, allowed: str) -> None:
    root = checkout(worktree_arg)
    if not allowed:
        fail("ALLOWED must be a nonempty path-prefix regex")
    _, baseline, _ = baseline_for(root)
    current = current_with_base(root, baseline)
    changes = changed_entries(baseline, current)
    check_allowed(changes, allowed)
    head_entries = snapshot_head(root)
    import difflib

    for path in changes:
        before = baseline.get(path, Entry("absent"))
        after = current.get(path, Entry("absent"))
        label = display(path)
        print(f"path {label}: {entry_summary(before)} -> {entry_summary(after)}")
        if before.kind == "file":
            before_content = baseline_file_bytes(root, path, before, head_entries)
        elif before.kind == "symlink":
            before_content = unb64(before.target, "symlink target")
        else:
            before_content = b""
        if after.kind == "file":
            after_content = checked_path(root, path)
            with open(after_content, "rb") as file:
                after_bytes = file.read()
        elif after.kind == "symlink":
            after_bytes = unb64(after.target, "symlink target")
        else:
            after_bytes = b""
        old_text, new_text = text_or_binary(before_content), text_or_binary(after_bytes)
        if old_text is None or new_text is None:
            print(f"Binary files differ: {label}")
            continue
        old_name = "/dev/null" if before.kind == "absent" else f"a/{label}"
        new_name = "/dev/null" if after.kind == "absent" else f"b/{label}"
        for line in difflib.unified_diff(
            old_text.splitlines(keepends=True), new_text.splitlines(keepends=True), old_name, new_name
        ):
            sys.stdout.write(line)
    print(f"Diff passed: {len(changes)} paths.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="transfer-checkout.py", description="Snapshot and transfer uncommitted worker deltas.")
    commands = result.add_subparsers(dest="command", required=True)
    baseline = commands.add_parser("baseline", help="copy source working tree and record destination baseline")
    baseline.add_argument("source")
    baseline.add_argument("destination")
    review = commands.add_parser("review", help="scope-check worker delta")
    review.add_argument("--allowed", required=True)
    review.add_argument("worktree")
    transfer = commands.add_parser("transfer", help="apply source delta to target without staging")
    transfer.add_argument("--allowed", required=True)
    transfer.add_argument("--check", action="store_true")
    transfer.add_argument("source")
    transfer.add_argument("target")
    diff = commands.add_parser("diff", help="print worker delta from its baseline")
    diff.add_argument("--allowed", required=True)
    diff.add_argument("worktree")
    return result


def main(argv: list[str]) -> int:
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "baseline":
            run_baseline(arguments.source, arguments.destination)
        elif arguments.command == "review":
            run_review(arguments.worktree, arguments.allowed)
        elif arguments.command == "diff":
            run_diff(arguments.worktree, arguments.allowed)
        else:
            run_transfer(arguments.source, arguments.target, arguments.allowed, arguments.check)
    except TransferError as error:
        print(f"transfer-checkout: {error}", file=sys.stderr)
        return 75 if isinstance(error, LockError) else 1
    except KeyboardInterrupt:
        print("transfer-checkout: interrupted", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    def interrupted(_signal: int, _frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main(sys.argv[1:]))
