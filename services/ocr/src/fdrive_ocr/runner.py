"""I/O: takes each configured root's candidate PDFs from the index, invokes
`ocrmypdf` as a subprocess per file, and applies the resulting decision to the
filesystem and the done-log. Pure decision-making lives in `decide.py` and
`rules.py`; this module is the glue, mirroring filesai's `run.sh` behaviour:

- Candidates are the live PDFs in `idx.files` whose content (`sha256`) the
  done-log has no decision for, so a PDF moved or restored from Trash is never
  processed again. The pass walks no folder.
- A PDF in which `pdftotext` finds any text is recorded as `has_text` and never
  handed to `ocrmypdf`. `ocrmypdf` itself is never called with `--skip-text` or
  `--force-ocr`, so a text layer it finds is left untouched too (exit 6, or
  `TaggedPDFError`).
- Signed and encrypted PDFs are refused and only recorded, never touched.
- A rewritten file keeps the original's owner, mode, and mtime; the original
  bytes are kept under `<state_dir>/originals` when `keep_originals` is set.
  Nothing is written or recorded unless the file is still the version OCR read.
- A rewrite is journaled in `idx.changes` so the indexer reads the new text
  layer without waiting for its watcher or scan.
- Per-file timeouts and a size cap (`--skip-big` plus a pre-filter) bound the
  worst case.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import stat
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass

import psycopg

from . import db
from .decide import STATUS_FAILED, STATUS_HAS_TEXT, STATUS_TIMEOUT, Decision, decide
from .originals import Mapping, mapping_document
from .rules import RESERVED_FOLDERS, is_excluded, is_too_big
from .settings import Settings

PROCESS_GROUP_KILL_WAIT_SECONDS = 5
TEXT_PROBE_TIMEOUT_SECONDS = 120

#: Not decided on this time, so counted as seen only: the content was decided on
#: since the pass listed it (a copy earlier in the pass, or a restore), or the file
#: is not, or no longer, the version the index recorded. The next pass looks again.
STATUS_DONE = "done"
STATUS_CHANGED = "changed"


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
        if status in (STATUS_DONE, STATUS_CHANGED):
            return
        if rewrite:
            self.ocred += 1
        elif status in (STATUS_FAILED, STATUS_TIMEOUT):
            self.failed += 1
        else:
            self.skipped += 1


class SourceChanged(Exception):
    """The file is no longer the version OCR read."""


def _version(info: os.stat_result) -> tuple[int, int, int, int, int]:
    """What identifies one version of a file. Any write changes its ctime, which no
    client can set, and a rename over it, how fdrive publishes an upload or a save,
    gives the path a new inode."""
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def is_still(path: str, read: os.stat_result) -> bool:
    """Whether `path` is still the version `read` describes."""
    try:
        return _version(os.stat(path)) == _version(read)
    except FileNotFoundError:
        return False


def has_text_layer(path: str) -> bool:
    """Whether `pdftotext` finds any text in `path`, which `ocrmypdf` would refuse
    as already having text. Anything else, including a PDF it cannot read, leaves
    the decision to `ocrmypdf`."""
    try:
        result = subprocess.run(
            ["pdftotext", "-q", path, "-"], capture_output=True, timeout=TEXT_PROBE_TIMEOUT_SECONDS, check=False
        )
    except subprocess.TimeoutExpired:
        return False
    return result.returncode == 0 and bool(result.stdout.strip())


def originals_dest(state_dir: str, root: str, rel_path: str, size: int, mtime_ns: int) -> str:
    key = f"{root}:{rel_path}:{size}:{mtime_ns}"
    digest = hashlib.sha256(key.encode()).hexdigest()[:16]
    return os.path.join(state_dir, "originals", f"{digest}_{os.path.basename(rel_path)}")


MAX_OCR_PAGE_MEGAPIXELS = 50


def run_ocrmypdf(
    src: str,
    dst: str,
    langs: str,
    max_page_megapixels: int,
    timeout_seconds: int,
    jobs: int,
    popen: Callable[..., subprocess.Popen[str]] = subprocess.Popen,
    killpg: Callable[[int, int], None] = os.killpg,
) -> tuple[int, str, bool]:
    """Runs `ocrmypdf` without `--skip-text` / `--force-ocr`. Returns
    `(exit_code, stderr, timed_out)`."""
    process = popen(
        [
            "ocrmypdf",
            "--skip-big",
            str(max_page_megapixels),
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
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        _stdout, stderr = process.communicate(timeout=timeout_seconds)
        assert process.returncode is not None
        return process.returncode, stderr, False
    except subprocess.TimeoutExpired as error:
        stderr_text = _stderr_text(error.stderr)
        try:
            killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            process.kill()
        try:
            _stdout, final_stderr = process.communicate(timeout=PROCESS_GROUP_KILL_WAIT_SECONDS)
            stderr_text = final_stderr or stderr_text
        except subprocess.TimeoutExpired as cleanup_error:
            stderr_text = _stderr_text(cleanup_error.stderr) or stderr_text
            # A descendant that left the group may still hold an inherited pipe.
            # Drop our pipe handles and reap the parent without blocking again.
            for pipe in (process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
            process.poll()
        return -1, stderr_text, True


def _stderr_text(raw_stderr: str | bytes | None) -> str:
    return raw_stderr.decode(errors="replace") if isinstance(raw_stderr, bytes) else (raw_stderr or "")


def apply_rewrite(
    src: str,
    tmp_out: str,
    state_dir: str,
    root: str,
    rel_path: str,
    read: os.stat_result,
    keep_originals: bool,
) -> None:
    """Gives `tmp_out` the owner, mode, and mtime `read` recorded for `src`, keeps a
    copy of the original when `keep_originals`, then atomically replaces `src`.

    `read` is the version of `src` OCR read. When `src` is no longer that version,
    by the time its original is copied or right before the replace, this raises
    `SourceChanged` and leaves `src` as it is: a newer upload or edit wins."""
    size, mtime_ns = read.st_size, read.st_mtime_ns
    if keep_originals:
        originals_dir = os.path.join(state_dir, "originals")
        os.makedirs(originals_dir, exist_ok=True)
        dest = originals_dest(state_dir, root, rel_path, size, mtime_ns)
        if not os.path.exists(dest):
            fd, pending = tempfile.mkstemp(prefix=".original-", dir=originals_dir)
            try:
                with os.fdopen(fd, "wb") as output, open(src, "rb") as original:
                    # Keep exactly the bytes OCR read, or nothing.
                    if _version(os.fstat(original.fileno())) != _version(read):
                        raise SourceChanged
                    shutil.copyfileobj(original, output)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(pending, stat.S_IMODE(read.st_mode))
                os.utime(pending, ns=(read.st_atime_ns, mtime_ns))
                os.replace(pending, dest)
            finally:
                if os.path.exists(pending):
                    os.remove(pending)
        # The legacy filename is a hash, not a reversible mapping. Preserve exact
        # source facts alongside every newly accepted original before rewriting.
        # `kept_at_ns` is recorded because the copy carries the *source's* mtime,
        # so nothing else on disk says when the bytes were actually kept.
        mappings_dir = os.path.join(state_dir, "original-mappings")
        os.makedirs(mappings_dir, exist_ok=True)
        with open(dest, "rb") as original:
            digest = hashlib.file_digest(original, "sha256").hexdigest()
        mapping = mapping_document(
            Mapping(
                root=root,
                path=rel_path,
                size=size,
                mtime_ns=mtime_ns,
                original=os.path.basename(dest),
                sha256=digest,
                legacy=False,
                kept_at_ns=time.time_ns(),
            )
        )
        fd, pending = tempfile.mkstemp(prefix=".mapping-", dir=mappings_dir)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(mapping, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, os.path.join(mappings_dir, f"{os.path.basename(dest)}.json"))
        finally:
            if os.path.exists(pending):
                os.remove(pending)
        # Persist both directory entries before the source can be overwritten.
        for retained_dir in (originals_dir, mappings_dir, state_dir):
            directory_fd = os.open(retained_dir, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    os.chmod(tmp_out, stat.S_IMODE(read.st_mode))
    try:
        os.chown(tmp_out, read.st_uid, read.st_gid)
    except (PermissionError, OSError):
        pass  # not running as root, or filesystem does not support chown; best effort
    os.utime(tmp_out, ns=(read.st_atime_ns, mtime_ns))
    # The last moment to notice a newer version; see docs/OCR.md for what is left.
    if not is_still(src, read):
        raise SourceChanged
    os.replace(tmp_out, src)


def _record(
    conn: psycopg.Connection,
    target: RootTarget,
    pdf: db.IndexedPdf,
    abs_path: str,
    read: os.stat_result,
    decision: Decision,
    log: Callable[[str], None],
) -> tuple[str, bool]:
    """Records a decision that leaves the file alone, if it is still the version
    the decision was made on."""
    with db.ocr_file_lock(conn, target.root_id, pdf.path):
        if db.is_done(conn, pdf.sha256):
            return STATUS_DONE, False
        if not is_still(abs_path, read):
            return STATUS_CHANGED, False
        db.record_ocr_log(
            conn, target.root_id, pdf.path, read.st_size, read.st_mtime_ns, pdf.sha256, decision.status, decision.detail
        )
    if decision.status in (STATUS_FAILED, STATUS_TIMEOUT):
        log(f"[{target.name}] {decision.status}: {pdf.path}: {decision.detail}")
    return decision.status, False


def process_file(
    conn: psycopg.Connection,
    target: RootTarget,
    pdf: db.IndexedPdf,
    settings: Settings,
    state_dir: str,
    timeout_seconds: int,
    jobs: int,
    log: Callable[[str], None],
) -> tuple[str, bool]:
    """Processes one indexed PDF end to end. Returns `(status, rewrote)`."""
    abs_path = os.path.join(target.abs_path, pdf.path)
    try:
        read = os.stat(abs_path)
    except FileNotFoundError:
        return STATUS_CHANGED, False
    if (read.st_size, read.st_mtime_ns) != (pdf.size, pdf.mtime_ns):
        # The index has not read this version yet; its digest would not describe it.
        return STATUS_CHANGED, False
    if db.is_done(conn, pdf.sha256):
        return STATUS_DONE, False
    if has_text_layer(abs_path):
        return _record(conn, target, pdf, abs_path, read, Decision(STATUS_HAS_TEXT, None, rewrite=False), log)

    fd, tmp_out = tempfile.mkstemp(prefix="._fdrive-ocr-", suffix=".pdf", dir=os.path.dirname(abs_path))
    os.close(fd)
    try:
        exit_code, stderr, timed_out = run_ocrmypdf(
            abs_path, tmp_out, settings.langs, MAX_OCR_PAGE_MEGAPIXELS, timeout_seconds, jobs
        )
        decision = decide(exit_code, stderr, timed_out)
        if not decision.rewrite:
            return _record(conn, target, pdf, abs_path, read, decision, log)
        with open(tmp_out, "rb") as output:
            written_size = os.fstat(output.fileno()).st_size
            written_sha256 = hashlib.file_digest(output, "sha256").hexdigest()
        with db.ocr_file_lock(conn, target.root_id, pdf.path), db.backup_checkpoint(conn):
            # OCR runs outside the file lock. A restore may have completed
            # while the subprocess ran or while the backup gate was held.
            if db.is_done(conn, pdf.sha256):
                return STATUS_DONE, False
            try:
                apply_rewrite(abs_path, tmp_out, state_dir, target.name, pdf.path, read, settings.keep_originals)
            except SourceChanged:
                log(f"[{target.name}] left alone, it changed while OCR read it: {pdf.path}")
                return STATUS_CHANGED, False
            # Under the output's digest: once the indexer has read the rewrite back there is
            # nothing left to do for it, while a copy of the scan elsewhere still gets its own.
            db.record_ocr_log(
                conn, target.root_id, pdf.path, written_size, read.st_mtime_ns, written_sha256, decision.status, None
            )
        db.journal_change(conn, target.root_id, target.name, pdf.path, log)
        log(f"[{target.name}] OCR'd: {pdf.path}")
        return decision.status, True
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
    on_file: Callable[[str, bool], None] | None = None,
    on_stopped: Callable[[], None] | None = None,
) -> RunTotals:
    """One pass over every target's candidates from the index. `include_globs` is
    `Config.include_globs` (env `OCR_INCLUDE_GLOBS`), not part of `settings`: it is
    a deployment-fixed restriction, not something an admin edits at runtime."""
    totals = RunTotals()
    run_id = db.start_run(conn)
    log(f"OCR pass start (langs={settings.langs}, max {settings.max_mb}MB)")
    try:
        for target in targets:
            for pdf in db.pdf_candidates(conn, target.root_id, RESERVED_FOLDERS):
                if is_excluded(target.name, pdf.path, list(settings.exclude_globs), list(include_globs)):
                    continue
                if is_too_big(pdf.size, settings.max_mb):
                    continue
                if is_enabled is not None and not is_enabled():
                    if on_stopped is not None:
                        on_stopped()
                    log("OCR pass stopped: PDF OCR disabled")
                    return totals
                status, rewrite = process_file(conn, target, pdf, settings, state_dir, timeout_seconds, jobs, log)
                totals.add(status, rewrite)
                if on_file is not None:
                    on_file(status, rewrite)
    finally:
        db.finish_run(conn, run_id, totals.seen, totals.ocred, totals.skipped, totals.failed)
    log(f"OCR pass done: {totals.seen} pdfs seen, {totals.ocred} OCR'd, {totals.skipped} skipped, {totals.failed} failed")
    return totals
