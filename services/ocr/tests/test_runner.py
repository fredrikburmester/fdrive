from __future__ import annotations

import errno
import hashlib
import os
import signal
import stat
import subprocess
import sys
import time
from contextlib import nullcontext
from io import StringIO
from pathlib import Path

import psycopg
import pytest
from conftest import Journal, index_pdfs

from fdrive_ocr import db, runner
from fdrive_ocr.decide import STATUS_TIMEOUT
from fdrive_ocr.settings import Settings

DEFAULT_SETTINGS = Settings(
    hour=3,
    langs="swe+eng",
    exclude_globs=("Programs/**", "Photos/**", "Videos/**"),
    max_mb=200,
    keep_originals=True,
    originals_retention_days=0,
)


def _write_pdf(path: Path, marker: str, body: str = "") -> None:
    """A fixture PDF: the fakes act on `marker`; `body` makes its content distinct."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(f"{marker}\n{body}".encode())


def _indexed(root: Path, rel_path: str) -> db.IndexedPdf:
    """The file at `rel_path` as the indexer would have recorded it."""
    path = root / rel_path
    info = path.stat()
    return db.IndexedPdf(rel_path, info.st_size, info.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())


def _process(
    conn: psycopg.Connection,
    target: runner.RootTarget,
    rel_path: str,
    tmp_path: Path,
    settings: Settings = DEFAULT_SETTINGS,
    timeout_seconds: int = 30,
    log: list[str] | None = None,
) -> tuple[str, bool]:
    return runner.process_file(
        conn,
        target,
        _indexed(Path(target.abs_path), rel_path),
        settings,
        str(tmp_path / "state"),
        timeout_seconds,
        2,
        (log if log is not None else []).append,
    )


def _pass(conn: psycopg.Connection, target: runner.RootTarget, tmp_path: Path, **kwargs: object) -> runner.RunTotals:
    """A pass over what the indexer recorded for the target's folder right now."""
    index_pdfs(conn, target.root_id, target.abs_path)
    return runner.run_pass(conn, [target], DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 1, lambda _m: None, **kwargs)


def _ocrmypdf_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Records the input of every `ocrmypdf` run, which still runs."""
    calls: list[str] = []
    real = runner.run_ocrmypdf

    def recording(src: str, *args: object, **kwargs: object) -> tuple[int, str, bool]:
        calls.append(src)
        return real(src, *args, **kwargs)

    monkeypatch.setattr(runner, "run_ocrmypdf", recording)
    return calls


# -- candidates from the index ---------------------------------------------------------


@pytest.fixture
def files_root(db_conn: psycopg.Connection, tmp_path: Path) -> runner.RootTarget:
    root = tmp_path / "root"
    root.mkdir()
    return runner.RootTarget(name="files", root_id=db.upsert_root(db_conn, "files"), abs_path=str(root))


@pytest.mark.parametrize(
    "folder",
    [
        "alice/.trash",
        "alice/.Trash/old",
        "alice/Bin/.fdrive-move-v1/file/p/a.pdf/v",
        "alice/old-trash/.fdrive-move-v1",
        "alice/.fdrive-desktop/trash",
        "alice/.fdrive-desktop/staging",
        "alice/Backups/.fdrive-backups",
    ],
)
def test_fdrives_own_folders_are_never_candidates(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, folder: str
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / folder / "scan.pdf", "OK")
    _write_pdf(root / "alice" / "scan.pdf", "OK")
    index_pdfs(db_conn, files_root.root_id, root)

    candidates = db.pdf_candidates(db_conn, files_root.root_id, runner.RESERVED_FOLDERS)
    assert [pdf.path for pdf in candidates] == ["alice/scan.pdf"]

    totals = _pass(db_conn, files_root, tmp_path)
    assert (totals.seen, totals.ocred) == (1, 1)
    assert (root / folder / "scan.pdf").read_bytes() == b"OK\n"


def test_only_live_indexed_pdfs_are_candidates(db_conn: psycopg.Connection, files_root: runner.RootTarget) -> None:
    root = Path(files_root.abs_path)
    for name in ("a.pdf", "gone.pdf", "unread.pdf"):
        _write_pdf(root / name, "OK")
    (root / "notes.txt").write_text("OK\n")
    index_pdfs(db_conn, files_root.root_id, root)
    db_conn.execute(
        'INSERT INTO "idx"."files" (root_id, path, name, ext, size, mtime_ns, sha256) '
        "VALUES (%s, 'notes.txt', 'notes.txt', '.txt', 3, 1, 'x')",
        (files_root.root_id,),
    )
    db_conn.execute("""UPDATE "idx"."files" SET deleted_at = now() WHERE path = 'gone.pdf'""")
    db_conn.execute("""UPDATE "idx"."files" SET sha256 = NULL WHERE path = 'unread.pdf'""")

    assert [pdf.path for pdf in db.pdf_candidates(db_conn, files_root.root_id, runner.RESERVED_FOLDERS)] == ["a.pdf"]


def test_a_moved_pdf_is_not_processed_again(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "inbox" / "scan.pdf", "OK")
    _write_pdf(root / "inbox" / "broken.pdf", "FAIL")
    _write_pdf(root / "inbox" / "letter.pdf", "HASTEXT")
    first = _pass(db_conn, files_root, tmp_path)
    assert (first.seen, first.ocred, first.skipped, first.failed) == (3, 1, 1, 1)

    # Moved, as when restored from Trash; the index follows.
    db_conn.execute('DELETE FROM "idx"."files"')
    os.replace(root / "inbox", root / "archive")
    calls = _ocrmypdf_calls(monkeypatch)
    probes: list[str] = []

    def probe(path: str) -> bool:
        probes.append(path)
        return False

    monkeypatch.setattr(runner, "has_text_layer", probe)
    second = _pass(db_conn, files_root, tmp_path)
    assert (second.seen, second.ocred, second.skipped, second.failed) == (0, 0, 0, 0)
    assert calls == [] and probes == []


def test_a_copy_of_a_decided_pdf_is_seen_once_and_left_alone(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a" / "scan.pdf", "FAIL")
    _write_pdf(root / "b" / "scan.pdf", "FAIL")
    calls = _ocrmypdf_calls(monkeypatch)

    totals = _pass(db_conn, files_root, tmp_path)
    assert (totals.seen, totals.failed) == (2, 1)
    assert calls == [str(root / "a" / "scan.pdf")]


def test_a_copy_of_an_ocred_scan_gets_its_own_text_layer(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "scan.pdf", "OK")
    assert _pass(db_conn, files_root, tmp_path).ocred == 1
    _write_pdf(root / "copy" / "scan.pdf", "OK")

    second = _pass(db_conn, files_root, tmp_path)
    # The rewritten file is OCR's own output, which is done; the copy is a scan.
    assert (second.seen, second.ocred) == (1, 1)
    assert (root / "copy" / "scan.pdf").read_bytes() == b"OK-OCRED-OUTPUT\n"


@pytest.mark.parametrize("marker", ["HASTEXT", "TAGGED"])
def test_a_pdf_with_text_is_never_handed_to_ocrmypdf(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, marker: str
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "letter.pdf", marker)
    calls = _ocrmypdf_calls(monkeypatch)

    totals = _pass(db_conn, files_root, tmp_path)
    assert (totals.seen, totals.skipped, totals.ocred) == (1, 1, 0)
    assert calls == []
    assert (root / "letter.pdf").read_bytes() == f"{marker}\n".encode()
    assert db_conn.execute('SELECT status FROM "idx"."ocr_log"').fetchall() == [("has_text",)]


def test_a_pdf_pdftotext_cannot_read_is_left_to_ocrmypdf(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "odd.pdf", "UNREADABLE")
    calls = _ocrmypdf_calls(monkeypatch)

    assert _pass(db_conn, files_root, tmp_path).failed == 1
    assert calls == [str(root / "odd.pdf")]


def test_has_text_layer_gives_up_after_its_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def hangs(*_args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired(cmd="pdftotext", timeout=float(kwargs["timeout"]))  # type: ignore[arg-type]

    monkeypatch.setattr(runner.subprocess, "run", hangs)
    assert runner.has_text_layer("/scan.pdf") is False


def test_excluded_and_oversized_pdfs_are_not_candidates(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "Photos" / "scan.pdf", "OK")
    (root / "big.pdf").write_bytes(b"OK\n" + b"x" * 2 * 1024 * 1024)
    index_pdfs(db_conn, files_root.root_id, root)
    settings = Settings(
        hour=3, langs="eng", exclude_globs=("files/Photos/**",), max_mb=1, keep_originals=True, originals_retention_days=0
    )

    totals = runner.run_pass(db_conn, [files_root], settings, str(tmp_path / "state"), 30, 1, lambda _m: None)
    assert totals.seen == 0
    assert (root / "Photos" / "scan.pdf").read_bytes() == b"OK\n"
    # Nothing is recorded: a later change to the rules applies to them at once.
    assert db_conn.execute('SELECT count(*) FROM "idx"."ocr_log"').fetchone() == (0,)


# -- originals_dest --------------------------------------------------------------


def test_originals_dest_is_stable_for_same_key(tmp_path: Path) -> None:
    a = runner.originals_dest(str(tmp_path), "files", "docs/a.pdf", 100, 111)
    b = runner.originals_dest(str(tmp_path), "files", "docs/a.pdf", 100, 111)
    assert a == b
    assert a.endswith("_a.pdf")


def test_originals_dest_differs_for_different_keys(tmp_path: Path) -> None:
    a = runner.originals_dest(str(tmp_path), "files", "docs/a.pdf", 100, 111)
    b = runner.originals_dest(str(tmp_path), "files", "docs/a.pdf", 100, 222)
    assert a != b


# -- run_ocrmypdf ---------------------------------------------------------------


def test_run_ocrmypdf_success(tmp_path: Path) -> None:
    src = tmp_path / "in.pdf"
    dst = tmp_path / "out.pdf"
    _write_pdf(src, "OK")
    exit_code, stderr, timed_out = runner.run_ocrmypdf(str(src), str(dst), "swe+eng", 200, 30, 2)
    assert exit_code == 0
    assert timed_out is False
    assert dst.exists()


def test_run_ocrmypdf_has_text(tmp_path: Path) -> None:
    src = tmp_path / "in.pdf"
    dst = tmp_path / "out.pdf"
    _write_pdf(src, "HASTEXT")
    exit_code, _stderr, timed_out = runner.run_ocrmypdf(str(src), str(dst), "swe+eng", 200, 30, 2)
    assert exit_code == 6
    assert timed_out is False


def test_run_ocrmypdf_timeout() -> None:
    class FakeProcess:
        pid = 123
        returncode: int | None = None

        def __init__(self) -> None:
            self.communicate_calls: list[int] = []

        def communicate(self, timeout: int) -> tuple[str, str]:
            self.communicate_calls.append(timeout)
            if len(self.communicate_calls) == 1:
                raise subprocess.TimeoutExpired(cmd="ocrmypdf", timeout=timeout, output=None, stderr=b"partial output")
            self.returncode = -signal.SIGKILL
            return "", "partial output"

        def kill(self) -> None:
            raise AssertionError("process-group kill should succeed")

    process = FakeProcess()
    popen_kwargs: dict[str, object] = {}
    signals: list[tuple[int, int]] = []

    def fake_popen(*args: object, **kwargs: object) -> FakeProcess:
        popen_kwargs.update(kwargs)
        return process

    exit_code, stderr, timed_out = runner.run_ocrmypdf(
        "/in.pdf",
        "/out.pdf",
        "eng",
        200,
        1,
        2,
        popen=fake_popen,  # type: ignore[arg-type]
        killpg=lambda pid, sig: signals.append((pid, sig)),
    )
    assert timed_out is True
    assert exit_code == -1
    assert stderr == "partial output"
    assert popen_kwargs["start_new_session"] is True
    assert signals == [(123, signal.SIGKILL)]
    assert process.communicate_calls == [1, runner.PROCESS_GROUP_KILL_WAIT_SECONDS]


def test_run_ocrmypdf_timeout_with_no_stderr_captured() -> None:
    class FakeProcess:
        pid = 123
        returncode: int | None = None
        stdout = StringIO()
        stderr = StringIO()
        polled = False

        def communicate(self, timeout: int) -> tuple[str, str]:
            raise subprocess.TimeoutExpired(cmd="ocrmypdf", timeout=timeout)

        def kill(self) -> None:
            return None

        def poll(self) -> int:
            self.polled = True
            return -signal.SIGKILL

    process = FakeProcess()
    _exit_code, stderr, timed_out = runner.run_ocrmypdf(
        "/in.pdf",
        "/out.pdf",
        "eng",
        200,
        1,
        2,
        popen=lambda *_args, **_kwargs: process,  # type: ignore[arg-type]
        killpg=lambda _pid, _sig: None,
    )
    assert timed_out is True
    assert stderr == ""
    assert process.stdout.closed and process.stderr.closed
    assert process.polled


def test_run_ocrmypdf_timeout_kills_descendant_process_group(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    release_marker = tmp_path / "release-descendant"
    leak_marker = tmp_path / "descendant-survived"
    child_code = (
        "import time\n"
        "from pathlib import Path\n"
        f"release = Path({str(release_marker)!r})\n"
        "while not release.exists():\n"
        "    time.sleep(0.01)\n"
        f"Path({str(leak_marker)!r}).touch()\n"
    )
    executable = bin_dir / "ocrmypdf"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import subprocess\n"
        "import sys\n"
        "import time\n"
        f"child = subprocess.Popen([sys.executable, '-c', {child_code!r}])\n"
        "print(child.pid, file=sys.stderr, flush=True)\n"
        "time.sleep(30)\n"
    )
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")

    exit_code, stderr, timed_out = runner.run_ocrmypdf("/in.pdf", "/out.pdf", "eng", 200, 1, 2)

    assert exit_code == -1
    assert timed_out is True
    assert stderr.strip().isdigit()
    release_marker.touch()
    time.sleep(0.5)
    assert not leak_marker.exists()


# -- apply_rewrite ---------------------------------------------------------------


def test_apply_rewrite_preserves_mode_and_mtime_and_keeps_original(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"original bytes")
    os.chmod(src, 0o640)
    os.utime(src, (1_700_000_000, 1_700_000_000))
    st_before = os.stat(src)

    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten bytes")

    runner.apply_rewrite(str(src), str(tmp_out), str(state_dir), "files", "a.pdf", st_before, True)

    assert src.read_bytes() == b"rewritten bytes"
    new_st = os.stat(src)
    assert stat.S_IMODE(new_st.st_mode) == 0o640
    assert new_st.st_mtime_ns == st_before.st_mtime_ns
    originals = list((state_dir / "originals").iterdir())
    assert len(originals) == 1
    assert originals[0].read_bytes() == b"original bytes"
    assert originals[0].stat().st_mtime_ns == st_before.st_mtime_ns
    assert stat.S_IMODE(originals[0].stat().st_mode) == 0o640


def test_apply_rewrite_without_keep_originals_does_not_copy(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"original bytes")
    st_before = os.stat(src)
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten bytes")

    runner.apply_rewrite(str(src), str(tmp_out), str(state_dir), "files", "a.pdf", st_before, False)

    assert not (state_dir / "originals").exists()


def test_apply_rewrite_does_not_recopy_existing_original(tmp_path: Path) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    state_dir = tmp_path / "state"
    src = root_dir / "a.pdf"
    src.write_bytes(b"v1")
    st_before = os.stat(src)
    dest = runner.originals_dest(str(state_dir), "files", "a.pdf", st_before.st_size, st_before.st_mtime_ns)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    Path(dest).write_bytes(b"already-there")

    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"rewritten")
    runner.apply_rewrite(str(src), str(tmp_out), str(state_dir), "files", "a.pdf", st_before, True)

    assert Path(dest).read_bytes() == b"already-there"


def test_apply_rewrite_tolerates_chown_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root_dir = tmp_path / "root"
    root_dir.mkdir()
    src = root_dir / "a.pdf"
    src.write_bytes(b"v1")
    st_before = os.stat(src)
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"v2")

    def fake_chown(*args: object, **kwargs: object) -> None:
        raise PermissionError("not root")

    monkeypatch.setattr(os, "chown", fake_chown)
    runner.apply_rewrite(str(src), str(tmp_out), str(tmp_path / "state"), "files", "a.pdf", st_before, False)
    assert src.read_bytes() == b"v2"


def restore_originals(tmp_path: Path) -> list[Path]:
    originals = tmp_path / "state" / "originals"
    return sorted(originals.iterdir()) if originals.exists() else []


def _replace_keeping_size_and_mtime(path: Path, how: str) -> bytes:
    """Puts a different version at `path` with the same size and mtime, as an
    upload published by rename (`publish`), or as an edit in place (`edit`)."""
    before = path.stat()
    newer = b"N" * before.st_size
    if how == "publish":
        staged = path.parent / ".upload.partial"
        staged.write_bytes(newer)
        os.utime(staged, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(staged, path)
    else:
        time.sleep(0.05)  # a later ctime on filesystems with coarse timestamps
        path.write_bytes(newer)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    return newer


@pytest.mark.parametrize("how", ["publish", "edit"])
@pytest.mark.parametrize("keep_originals", [True, False])
def test_apply_rewrite_leaves_a_newer_version_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, how: str, keep_originals: bool
) -> None:
    src = tmp_path / "a.pdf"
    src.write_bytes(b"the scan OCR read")
    read = src.stat()
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"OCR output")
    newer = b""
    real_utime = os.utime

    def newer_version_lands(path: object, *args: object, **kwargs: object) -> None:
        # The last step before the swap: the newer version lands right before it.
        nonlocal newer
        real_utime(path, *args, **kwargs)  # type: ignore[arg-type]
        if path == str(tmp_out) and not newer:
            newer = _replace_keeping_size_and_mtime(src, how)

    monkeypatch.setattr(runner.os, "utime", newer_version_lands)
    with pytest.raises(runner.SourceChanged):
        runner.apply_rewrite(str(src), str(tmp_out), str(tmp_path / "state"), "files", "a.pdf", read, keep_originals)

    assert src.read_bytes() == newer
    assert tmp_out.read_bytes() == b"OCR output"
    # Kept already, it is the version OCR read; the listing shows it as changed.
    assert [p.read_bytes() for p in restore_originals(tmp_path)] == ([b"the scan OCR read"] if keep_originals else [])


@pytest.mark.parametrize("how", ["publish", "edit"])
def test_apply_rewrite_keeps_no_original_of_a_newer_version(tmp_path: Path, how: str) -> None:
    src = tmp_path / "a.pdf"
    src.write_bytes(b"the scan OCR read")
    read = src.stat()
    newer = _replace_keeping_size_and_mtime(src, how)
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"OCR output")
    state_dir = tmp_path / "state"

    with pytest.raises(runner.SourceChanged):
        runner.apply_rewrite(str(src), str(tmp_out), str(state_dir), "files", "a.pdf", read, True)

    assert src.read_bytes() == newer
    assert list((state_dir / "originals").iterdir()) == []
    assert not (state_dir / "original-mappings").exists()


def test_apply_rewrite_never_recreates_a_deleted_file(tmp_path: Path) -> None:
    src = tmp_path / "a.pdf"
    src.write_bytes(b"the scan OCR read")
    read = src.stat()
    src.unlink()
    tmp_out = tmp_path / "tmp_out.pdf"
    tmp_out.write_bytes(b"OCR output")

    with pytest.raises(runner.SourceChanged):
        runner.apply_rewrite(str(src), str(tmp_out), str(tmp_path / "state"), "files", "a.pdf", read, False)
    assert not src.exists()


# -- process_file ----------------------------------------------------------------


def test_process_file_uses_same_directory_for_atomic_replace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "mounted-root"
    root.mkdir()
    src = root / "a.pdf"
    _write_pdf(src, "OK")
    target = runner.RootTarget(name="files", root_id=1, abs_path=str(root))
    settings = Settings(hour=3, langs="eng", exclude_globs=(), max_mb=200, keep_originals=False, originals_retention_days=0)
    real_replace = os.replace

    def fake_run_ocrmypdf(
        _src: str, dst: str, _langs: str, _max_mb: int, _timeout_seconds: int, _jobs: int
    ) -> tuple[int, str, bool]:
        Path(dst).write_bytes(b"rewritten")
        return 0, "", False

    def replace_across_mounts_fails(src_path: str, dst_path: str) -> None:
        if os.path.dirname(src_path) != os.path.dirname(dst_path):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        real_replace(src_path, dst_path)

    monkeypatch.setattr(runner, "run_ocrmypdf", fake_run_ocrmypdf)
    monkeypatch.setattr(runner.db, "record_ocr_log", lambda *args: None)
    monkeypatch.setattr(runner.db, "is_done", lambda *args: False)
    monkeypatch.setattr(runner.db, "ocr_file_lock", lambda *args: nullcontext())
    monkeypatch.setattr(runner.db, "backup_checkpoint", lambda _conn: nullcontext())
    monkeypatch.setattr(runner.db, "journal_change", lambda *args: None)
    monkeypatch.setattr(runner.os, "replace", replace_across_mounts_fails)

    status, rewrite = _process(object(), target, "a.pdf", tmp_path, settings)  # type: ignore[arg-type]

    assert status == "ocred"
    assert rewrite is True
    assert src.read_bytes() == b"rewritten"
    assert list(root.glob("._fdrive-ocr-*.pdf")) == []


def test_process_file_skips_content_decided_since_the_pass_listed_it(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "OK")
    pdf = _indexed(root, "a.pdf")
    db.record_ocr_log(db_conn, files_root.root_id, "elsewhere/a.pdf", pdf.size, pdf.mtime_ns, pdf.sha256, "restored", None)
    calls = _ocrmypdf_calls(monkeypatch)

    assert _process(db_conn, files_root, "a.pdf", tmp_path) == ("done", False)
    assert calls == []
    assert (root / "a.pdf").read_bytes() == b"OK\n"


@pytest.mark.parametrize("change", ["deleted", "newer"])
def test_process_file_skips_a_file_the_index_has_not_caught_up_with(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "OK")
    pdf = _indexed(root, "a.pdf")
    if change == "deleted":
        (root / "a.pdf").unlink()
    else:
        _write_pdf(root / "a.pdf", "OK", "edited since")
    calls = _ocrmypdf_calls(monkeypatch)

    status = runner.process_file(db_conn, files_root, pdf, DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, lambda _m: None)
    assert status == ("changed", False)
    assert calls == []
    assert db_conn.execute('SELECT count(*) FROM "idx"."ocr_log"').fetchone() == (0,)


@pytest.mark.parametrize("how", ["publish", "edit"])
def test_a_file_replaced_while_ocr_reads_it_is_left_as_the_newer_version(
    db_conn: psycopg.Connection,
    files_root: runner.RootTarget,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    journal: Journal,
    how: str,
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "OK")
    real = runner.run_ocrmypdf
    newer = b""

    def upload_lands_during_ocr(src: str, *args: object) -> tuple[int, str, bool]:
        nonlocal newer
        result = real(src, *args)
        newer = _replace_keeping_size_and_mtime(Path(src), how)
        return result

    monkeypatch.setattr(runner, "run_ocrmypdf", upload_lands_during_ocr)
    totals = _pass(db_conn, files_root, tmp_path)
    assert (totals.seen, totals.ocred) == (1, 0)
    assert (root / "a.pdf").read_bytes() == newer
    assert db_conn.execute('SELECT count(*) FROM "idx"."ocr_log"').fetchone() == (0,)
    assert journal.rows() == []
    assert list(root.glob("._fdrive-ocr-*.pdf")) == []
    assert restore_originals(tmp_path) == []


@pytest.mark.parametrize("marker", ["FAIL", "HASTEXT"])
def test_a_decision_on_a_file_that_changed_meanwhile_is_not_recorded(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, marker: str
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", marker)
    pdf = _indexed(root, "a.pdf")
    real = runner.has_text_layer

    def edited_after_reading(path: str) -> bool:
        found = real(path)
        _replace_keeping_size_and_mtime(Path(path), "edit")
        return found

    monkeypatch.setattr(runner, "has_text_layer", edited_after_reading)
    status = runner.process_file(db_conn, files_root, pdf, DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, lambda _m: None)
    assert status == ("changed", False)
    assert db_conn.execute('SELECT count(*) FROM "idx"."ocr_log"').fetchone() == (0,)


def test_process_file_ocred_rewrites_and_logs(db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path) -> None:
    root = Path(files_root.abs_path)
    f = root / "a.pdf"
    _write_pdf(f, "OK")
    before = f.stat()
    logs: list[str] = []
    status, rewrite = _process(db_conn, files_root, "a.pdf", tmp_path, log=logs)
    assert status == "ocred"
    assert rewrite is True
    assert f.read_bytes() == b"OK-OCRED-OUTPUT\n"
    assert any("OCR'd" in line for line in logs)
    # Recorded under the output, which the indexer reads back.
    assert db_conn.execute('SELECT path, size, mtime_ns, sha256, status FROM "idx"."ocr_log"').fetchall() == [
        ("a.pdf", len(b"OK-OCRED-OUTPUT\n"), before.st_mtime_ns, hashlib.sha256(b"OK-OCRED-OUTPUT\n").hexdigest(), "ocred")
    ]


def test_process_file_has_text_leaves_file_untouched(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path
) -> None:
    root = Path(files_root.abs_path)
    f = root / "a.pdf"
    _write_pdf(f, "HASTEXT")
    original_bytes = f.read_bytes()
    status, rewrite = _process(db_conn, files_root, "a.pdf", tmp_path)
    assert status == "has_text"
    assert rewrite is False
    assert f.read_bytes() == original_bytes


def test_process_file_has_text_from_ocrmypdf(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "HASTEXT")
    # Text pdftotext misses but ocrmypdf finds is still left alone.
    monkeypatch.setattr(runner, "has_text_layer", lambda _path: False)
    assert _process(db_conn, files_root, "a.pdf", tmp_path) == ("has_text", False)
    assert (root / "a.pdf").read_bytes() == b"HASTEXT\n"


def test_process_file_signed_and_encrypted(db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "signed.pdf", "SIGNED")
    _write_pdf(root / "encrypted.pdf", "ENCRYPTED")

    assert _process(db_conn, files_root, "signed.pdf", tmp_path)[0] == "signed"
    assert _process(db_conn, files_root, "encrypted.pdf", tmp_path)[0] == "encrypted"


def test_process_file_failed_logs_detail(db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path) -> None:
    _write_pdf(Path(files_root.abs_path) / "a.pdf", "FAIL")
    logs: list[str] = []
    status, rewrite = _process(db_conn, files_root, "a.pdf", tmp_path, log=logs)
    assert status == "failed"
    assert rewrite is False
    assert any("failed" in line for line in logs)


def test_process_file_timeout(db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path) -> None:
    _write_pdf(Path(files_root.abs_path) / "a.pdf", "HANG")
    status, rewrite = _process(db_conn, files_root, "a.pdf", tmp_path, timeout_seconds=1)
    assert status == STATUS_TIMEOUT
    assert rewrite is False


# -- telling the indexer -------------------------------------------------------------


def test_process_file_journals_the_rewritten_pdf_for_the_indexer(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, journal: Journal
) -> None:
    _write_pdf(Path(files_root.abs_path) / "docs" / "a.pdf", "OK")
    assert _process(db_conn, files_root, "docs/a.pdf", tmp_path) == ("ocred", True)
    # No content hint: OCR changed the bytes, so the indexer reads them.
    assert journal.rows() == [(files_root.root_id, "docs/a.pdf", None, "ocr", None, None, None, None, None)]
    assert journal.notifications() == ["files"]


@pytest.mark.parametrize("marker", ["FAIL", "HASTEXT"])
def test_process_file_journals_nothing_when_it_leaves_the_pdf_alone(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, journal: Journal, marker: str
) -> None:
    _write_pdf(Path(files_root.abs_path) / "a.pdf", marker)
    status, rewrite = _process(db_conn, files_root, "a.pdf", tmp_path)
    assert rewrite is False, status
    assert journal.rows() == []
    assert journal.notifications() == []


@pytest.mark.usefixtures("failing_journal")
def test_a_failed_indexer_hint_is_logged_and_the_pass_goes_on(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, journal: Journal
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "OK")
    _write_pdf(root / "b.pdf", "OK", "another scan")
    index_pdfs(db_conn, files_root.root_id, root)
    logs: list[str] = []
    totals = runner.run_pass(db_conn, [files_root], DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 1, logs.append)

    assert (totals.ocred, totals.failed) == (2, 0)
    assert (root / "a.pdf").read_bytes() == b"OK-OCRED-OUTPUT\n"
    assert (root / "b.pdf").read_bytes() == b"OK-OCRED-OUTPUT\n"
    assert db_conn.execute('SELECT path, status FROM "idx"."ocr_log" ORDER BY path').fetchall() == [
        ("a.pdf", "ocred"),
        ("b.pdf", "ocred"),
    ]
    failures = [line for line in logs if "could not tell the indexer" in line]
    assert len(failures) == 2
    assert "[files] could not tell the indexer about a.pdf: idx.changes is unavailable" in failures[0]
    assert journal.rows() == []
    assert journal.notifications() == []


# -- run_pass ----------------------------------------------------------------------


def test_run_pass_over_multiple_roots(db_conn: psycopg.Connection, tmp_path: Path) -> None:
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    _write_pdf(root_a / "ok.pdf", "OK")
    _write_pdf(root_a / "has_text.pdf", "HASTEXT")
    _write_pdf(root_b / "fail.pdf", "FAIL")

    targets = [
        runner.RootTarget(name="a", root_id=db.upsert_root(db_conn, "a"), abs_path=str(root_a)),
        runner.RootTarget(name="b", root_id=db.upsert_root(db_conn, "b"), abs_path=str(root_b)),
    ]
    for target in targets:
        index_pdfs(db_conn, target.root_id, target.abs_path)
    logs: list[str] = []
    totals = runner.run_pass(db_conn, targets, DEFAULT_SETTINGS, str(tmp_path / "state"), 30, 2, logs.append)

    assert totals.seen == 3
    assert totals.ocred == 1
    assert totals.skipped == 1
    assert totals.failed == 1
    assert any("OCR pass start" in line for line in logs)
    assert any("OCR pass done" in line for line in logs)

    last = db.last_run(db_conn)
    assert last is not None
    assert last.seen == 3
    assert last.finished_at is not None


def test_run_pass_second_run_finds_nothing_left_to_do(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "has_text.pdf", "HASTEXT")
    _write_pdf(root / "scan.pdf", "OK")
    _write_pdf(root / "broken.pdf", "FAIL")

    first = _pass(db_conn, files_root, tmp_path)
    assert (first.seen, first.ocred, first.skipped, first.failed) == (3, 1, 1, 1)

    # The indexer reads the rewritten scan back; its new content is OCR's own.
    calls = _ocrmypdf_calls(monkeypatch)
    second = _pass(db_conn, files_root, tmp_path)
    assert (second.seen, second.ocred, second.skipped, second.failed) == (0, 0, 0, 0)
    assert calls == []


def test_run_pass_stops_when_pdf_ocr_is_switched_off(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path
) -> None:
    root = Path(files_root.abs_path)
    _write_pdf(root / "a.pdf", "OK")
    _write_pdf(root / "b.pdf", "OK", "another scan")
    stopped: list[bool] = []
    answers = iter([True, False])

    totals = _pass(db_conn, files_root, tmp_path, is_enabled=lambda: next(answers), on_stopped=lambda: stopped.append(True))
    assert (totals.seen, totals.ocred) == (1, 1)
    assert stopped == [True]
    assert (root / "b.pdf").read_bytes() == b"OK\nanother scan"


def test_run_pass_finishes_run_row_even_on_crash(
    db_conn: psycopg.Connection, files_root: runner.RootTarget, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_pdf(Path(files_root.abs_path) / "ok.pdf", "OK")

    def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("kaboom")

    monkeypatch.setattr(runner, "process_file", boom)
    with pytest.raises(RuntimeError):
        _pass(db_conn, files_root, tmp_path)

    last = db.last_run(db_conn)
    assert last is not None
    assert last.finished_at is not None


def test_page_megapixel_limit_is_independent_of_pdf_megabytes() -> None:
    calls: list[list[str]] = []

    class Process:
        returncode = 0

        def communicate(self, timeout: int) -> tuple[str, str]:
            return "", ""

    def popen(command: list[str], **_kwargs: object) -> Process:
        calls.append(command)
        return Process()

    runner.run_ocrmypdf("in.pdf", "out.pdf", "eng", runner.MAX_OCR_PAGE_MEGAPIXELS, 30, 2, popen=popen)
    assert calls[0][calls[0].index("--skip-big") + 1] == "50"
    assert DEFAULT_SETTINGS.max_mb == 200
