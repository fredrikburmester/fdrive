"""I/O: walks each configured root for candidate PDFs, invokes `ocrmypdf` as a
subprocess per file, and applies the resulting decision to the filesystem and
the done-log. Pure decision-making lives in `decide.py` and `rules.py`; this
module is the glue, mirroring filesai's `run.sh` behaviour:

- `ocrmypdf` is never called with `--skip-text` or `--force-ocr`, so a PDF that
  already has a text layer is left untouched (exit 6, or `TaggedPDFError`).
- Signed and encrypted PDFs are refused and only recorded, never touched.
- A rewritten file keeps the original's owner, mode, and mtime; the original
  bytes are kept under `<state_dir>/originals` when `keep_originals` is set.
- Per-file timeouts and a size cap (`--skip-big` plus a pre-filter) bound the
  worst case.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass

import psycopg

from . import db
from .decide import STATUS_FAILED, STATUS_TIMEOUT, decide
from .rules import is_candidate_pdf, is_excluded, is_too_big
from .settings import Settings

SKIP_DIRS = frozenset({"@eaDir", ".Trash", ".Trashes", "node_modules", ".git"})


@dataclass(frozen=True)
class RootTarget:
    name: str
    root_id: int
    abs_path: str


@dataclass
class RunTotals:
    seen: int = 0
    ocred: int = 0
    skipped: int = 0
    failed: int = 0

    def add(self, status: str, rewrite: bool) -> None:
        self.seen += 1
        if status == "skipped_done":
            return
        if rewrite:
            self.ocred += 1
        elif status in (STATUS_FAILED, STATUS_TIMEOUT):
            self.failed += 1
        else:
            self.skipped += 1


def iter_candidate_pdfs(abs_root: str, skip_dirs: frozenset[str] = SKIP_DIRS) -> Iterator[str]:
    for dirpath, dirnames, filenames in os.walk(abs_root):
        dirnames[:] = sorted(d for d in dirnames if d not in skip_dirs)
        for name in sorted(filenames):
            if is_candidate_pdf(name):
                yield os.path.join(dirpath, name)


def originals_dest(state_dir: str, root: str, rel_path: str, size: int, mtime_ns: int) -> str:
    key = f"{root}:{rel_path}:{size}:{mtime_ns}"
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    return os.path.join(state_dir, "originals", f"{digest}_{os.path.basename(rel_path)}")


def originals_stats(state_dir: str) -> tuple[int, int]:
    """Count and total bytes of files under `<state_dir>/originals`."""
    originals_dir = os.path.join(state_dir, "originals")
    if not os.path.isdir(originals_dir):
        return 0, 0
    count = 0
    total = 0
    for entry in os.scandir(originals_dir):
        if entry.is_file():
            count += 1
            total += entry.stat().st_size
    return count, total


def run_ocrmypdf(
    src: str,
    dst: str,
    langs: str,
    max_mb: int,
    timeout_seconds: int,
    jobs: int,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> tuple[int, str, bool]:
    """Runs `ocrmypdf` without `--skip-text` / `--force-ocr`. Returns
    `(exit_code, stderr, timed_out)`."""
    try:
        proc = run(
            [
                "ocrmypdf",
                "--skip-big",
                str(max_mb),
                "-l",
                langs,
                "--output-type",
                "pdf",
                "--optimize",
                "0",
                "-j",
                str(jobs),
                "-q",
                src,
                dst,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        return proc.returncode, proc.stderr, False
    except subprocess.TimeoutExpired as e:
        raw_stderr = e.stderr
        stderr_text = raw_stderr.decode(errors="replace") if isinstance(raw_stderr, bytes) else (raw_stderr or "")
        return -1, stderr_text, True


def apply_rewrite(
    src: str,
    tmp_out: str,
    state_dir: str,
    root: str,
    rel_path: str,
    size: int,
    mtime_ns: int,
    keep_originals: bool,
) -> None:
    """Preserves owner, mode, and mtime from `src` onto `tmp_out`, keeps a copy
    of the original when `keep_originals`, then atomically replaces `src`."""
    st_before = os.stat(src)
    if keep_originals:
        originals_dir = os.path.join(state_dir, "originals")
        os.makedirs(originals_dir, exist_ok=True)
        dest = originals_dest(state_dir, root, rel_path, size, mtime_ns)
        if not os.path.exists(dest):
            shutil.copy2(src, dest)
    os.chmod(tmp_out, stat.S_IMODE(st_before.st_mode))
    try:
        os.chown(tmp_out, st_before.st_uid, st_before.st_gid)
    except (PermissionError, OSError):
        pass  # not running as root, or filesystem does not support chown; best effort
    os.utime(tmp_out, ns=(st_before.st_atime_ns, st_before.st_mtime_ns))
    os.replace(tmp_out, src)


def process_file(
    conn: psycopg.Connection,
    target: RootTarget,
    abs_path: str,
    settings: Settings,
    state_dir: str,
    timeout_seconds: int,
    jobs: int,
    done: set[tuple[str, int, int]],
    log: Callable[[str], None],
    include_globs: tuple[str, ...] = (),
) -> tuple[str, bool]:
    """Processes one candidate PDF end to end. Returns `(status, rewrote)`.
    `include_globs` is `Config.include_globs` (env `OCR_INCLUDE_GLOBS`), not
    part of `settings`: it is a deployment-fixed restriction, not something an
    admin edits at runtime through app.settings."""
    rel_path = os.path.relpath(abs_path, target.abs_path)
    st = os.stat(abs_path)
    size, mtime_ns = st.st_size, st.st_mtime_ns

    if (rel_path, size, mtime_ns) in done:
        return "skipped_done", False
    if is_excluded(target.name, rel_path, list(settings.exclude_globs), list(include_globs)):
        db.record_ocr_log(conn, target.root_id, rel_path, size, mtime_ns, "excluded", None)
        return "excluded", False
    if is_too_big(size, settings.max_mb):
        db.record_ocr_log(conn, target.root_id, rel_path, size, mtime_ns, "too_big", None)
        return "too_big", False

    fd, tmp_out = tempfile.mkstemp(prefix="._fdrive-ocr-", suffix=".pdf", dir=os.path.dirname(abs_path))
    os.close(fd)
    try:
        exit_code, stderr, timed_out = run_ocrmypdf(abs_path, tmp_out, settings.langs, settings.max_mb, timeout_seconds, jobs)
        decision = decide(exit_code, stderr, timed_out)
        if decision.rewrite:
            apply_rewrite(abs_path, tmp_out, state_dir, target.name, rel_path, size, mtime_ns, settings.keep_originals)
            new_st = os.stat(abs_path)
            db.record_ocr_log(
                conn, target.root_id, rel_path, new_st.st_size, new_st.st_mtime_ns, decision.status, decision.detail
            )
            log(f"[{target.name}] OCR'd: {rel_path}")
        else:
            db.record_ocr_log(conn, target.root_id, rel_path, size, mtime_ns, decision.status, decision.detail)
            if decision.status in (STATUS_FAILED, STATUS_TIMEOUT):
                log(f"[{target.name}] {decision.status}: {rel_path}: {decision.detail}")
        return decision.status, decision.rewrite
    finally:
        if os.path.exists(tmp_out):
            os.remove(tmp_out)


def run_pass(
    conn: psycopg.Connection,
    targets: list[RootTarget],
    settings: Settings,
    state_dir: str,
    timeout_seconds: int,
    jobs: int,
    log: Callable[[str], None],
    include_globs: tuple[str, ...] = (),
    is_enabled: Callable[[], bool] | None = None,
) -> RunTotals:
    totals = RunTotals()
    run_id = db.start_run(conn)
    log(f"OCR pass start (langs={settings.langs}, max {settings.max_mb}MB)")
    try:
        for target in targets:
            done = db.done_keys(conn, target.root_id)
            for abs_path in iter_candidate_pdfs(target.abs_path):
                if is_enabled is not None and not is_enabled():
                    log("OCR pass stopped: PDF OCR disabled")
                    return totals
                status, rewrite = process_file(
                    conn, target, abs_path, settings, state_dir, timeout_seconds, jobs, done, log, include_globs
                )
                totals.add(status, rewrite)
    finally:
        db.finish_run(conn, run_id, totals.seen, totals.ocred, totals.skipped, totals.failed)
    log(f"OCR pass done: {totals.seen} pdfs seen, {totals.ocred} OCR'd, {totals.skipped} skipped, {totals.failed} failed")
    return totals
