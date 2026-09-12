"""inotify watcher: gets changes into the index within seconds instead of at the next
scan. Linux only (uses `ctypes.CDLL("libc.so.6")` at import time), which is why this
module is imported lazily from `indexer.start_watcher` inside a try/except, and why
its tests are `skipif(sys.platform != "linux")`.

One inotify watch per directory under `root`. Kernel events become index actions:
  CLOSE_WRITE, unpaired MOVED_TO   -> (re)index the file, unless size+mtime already match its row
  DELETE, unpaired MOVED_FROM      -> mark the row (or the subtree) deleted and drop its chunks
  MOVED_FROM + MOVED_TO (cookie)   -> rename rows in place: no re-extraction, no re-embedding
  CREATE|ISDIR, MOVED_TO|ISDIR     -> watch the new directory and index whatever is already in it
Events are debounced per path. What is applied is decided by what is on disk at apply
time, not by event order.
"""

from __future__ import annotations

import ctypes
import errno
import os
import stat
import struct
import threading
import time
from collections import Counter
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor

IN_CLOSE_WRITE, IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE = 0x8, 0x40, 0x80, 0x100, 0x200
IN_Q_OVERFLOW, IN_IGNORED, IN_ISDIR = 0x4000, 0x8000, 0x40000000
IN_ONLYDIR, IN_DONT_FOLLOW, IN_EXCL_UNLINK = 0x1000000, 0x2000000, 0x4000000
MASK = IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO | IN_CREATE | IN_DELETE | IN_ONLYDIR | IN_DONT_FOLLOW | IN_EXCL_UNLINK
_HDR = struct.Struct("iIII")

DEFAULT_SKIP_NAMES = frozenset({".DS_Store", "Thumbs.db", "desktop.ini", ".localized"})
DEFAULT_SKIP_DIRS = frozenset({"@eaDir", ".Trash", ".Trashes", "node_modules", ".git"})

_libc = ctypes.CDLL("libc.so.6", use_errno=True)
_libc.inotify_init1.argtypes = [ctypes.c_int]
_libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
_libc.inotify_rm_watch.argtypes = [ctypes.c_int, ctypes.c_int]


def _junk(name: str, skip_names: frozenset[str]) -> bool:
    return name.startswith("._") or name in skip_names


class Watcher:
    """Callbacks: index_file(abs, rel, st) -> "indexed"|"unchanged"|"error";
    mark_deleted(rel, is_dir) -> rows affected; rename(old_rel, new_rel, is_dir) -> rows
    moved (0 means nothing was in the index under the old path: the new path gets
    indexed instead)."""

    def __init__(
        self,
        root: str,
        log: Callable[[str], None],
        index_file: Callable[[str, str, os.stat_result], str],
        mark_deleted: Callable[[str, bool], int],
        rename: Callable[[str, str, bool], int],
        workers: int = 4,
        debounce: float = 2.0,
        skip_names: frozenset[str] = DEFAULT_SKIP_NAMES,
        skip_dirs: frozenset[str] = DEFAULT_SKIP_DIRS,
        on_queue: Callable[[str], Callable[[str], None]] | None = None,
    ) -> None:
        self.on_queue = on_queue
        self.root, self.log = root, log
        self.index_file, self.mark_deleted, self.rename = index_file, mark_deleted, rename
        self.workers, self.debounce = workers, debounce
        self.skip_names, self.skip_dirs = skip_names, skip_dirs
        self.wake = threading.Event()
        # Nonblocking reads let stop() terminate the reader deterministically;
        # closing a blocking inotify fd from another Python thread is not a
        # portable wakeup and can retain reader threads across feature toggles.
        self.fd = _libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        self._maps = threading.Lock()
        self._wd_path: dict[int, str] = {}
        self._mu = threading.Lock()
        self._pending: dict[str, tuple[str, bool, float]] = {}
        self._renames: list[tuple[str, str, bool, float]] = []
        self._move_from: dict[int, tuple[str, bool, float]] = {}
        self._rebuild = False
        self._stopped = threading.Event()
        self._reader_thread: threading.Thread | None = None
        self._dispatcher_thread: threading.Thread | None = None

    def stop(self) -> None:
        """Release inotify resources when every processing feature is disabled."""
        if self._stopped.is_set():
            return
        self._stopped.set()
        try:
            os.close(self.fd)
        except OSError:
            pass
        current = threading.current_thread()
        for thread in (self._reader_thread, self._dispatcher_thread):
            if thread is not None and thread is not current:
                thread.join(timeout=1)

    def _add_watch(self, path: str) -> bool:
        wd = _libc.inotify_add_watch(self.fd, os.fsencode(path), MASK)
        if wd < 0:
            err = ctypes.get_errno()
            if err not in (errno.ENOENT, errno.ENOTDIR):
                self.log(f"watch: cannot watch {path}: {os.strerror(err)}")
            return False
        with self._maps:
            self._wd_path[wd] = path
        return True

    def add_tree(self, top: str, collect_files: bool = False) -> list[str]:
        files: list[str] = []
        stack = [top]
        while stack:
            d = stack.pop()
            if not self._add_watch(d):
                continue
            try:
                with os.scandir(d) as it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                if e.name not in self.skip_dirs:
                                    stack.append(e.path)
                            elif collect_files and e.is_file(follow_symlinks=False) and not _junk(e.name, self.skip_names):
                                files.append(e.path)
                        except OSError:
                            pass
            except OSError as e:
                self.log(f"watch: cannot list {d}: {e}")
        return files

    def _rekey_dir(self, old_abs: str, new_abs: str) -> None:
        prefix = old_abs + "/"
        with self._maps:
            for wd, p in list(self._wd_path.items()):
                if p == old_abs or p.startswith(prefix):
                    self._wd_path[wd] = new_abs + p[len(old_abs) :]

    def _drop_dir(self, abs_path: str) -> None:
        prefix = abs_path + "/"
        with self._maps:
            for wd, p in list(self._wd_path.items()):
                if p == abs_path or p.startswith(prefix):
                    _libc.inotify_rm_watch(self.fd, wd)
                    del self._wd_path[wd]

    def _rebuild_watches(self) -> None:
        with self._maps:
            for wd in list(self._wd_path):
                _libc.inotify_rm_watch(self.fd, wd)
            self._wd_path.clear()
        self.add_tree(self.root)
        self.log(f"watch: rebuilt {self.dirs} directory watches after overflow")

    @property
    def dirs(self) -> int:
        with self._maps:
            return len(self._wd_path)

    def start(self) -> None:
        self.add_tree(self.root)
        self._reader_thread = threading.Thread(target=self._reader, name="inotify-reader", daemon=True)
        self._dispatcher_thread = threading.Thread(target=self._dispatcher, name="inotify-dispatch", daemon=True)
        self._reader_thread.start()
        self._dispatcher_thread.start()

    def _reader(self) -> None:
        while not self._stopped.is_set():
            try:
                buf = os.read(self.fd, 256 * 1024)
            except OSError as e:
                if self._stopped.is_set():
                    break
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    time.sleep(0.05)
                    continue
                self.log(f"watch: read failed: {e}")
                time.sleep(1)
                continue
            i = 0
            while i + _HDR.size <= len(buf):
                wd, mask, cookie, ln = _HDR.unpack_from(buf, i)
                i += _HDR.size
                name = os.fsdecode(buf[i : i + ln].split(b"\0", 1)[0])
                i += ln
                try:
                    self._on_event(wd, mask, cookie, name)
                except Exception as e:  # noqa: BLE001
                    self.log(f"watch: event handling failed: {type(e).__name__}: {e}")

    def _set(self, rel: str, kind: str, is_dir: bool, now: float) -> None:
        with self._mu:
            self._pending[rel] = (kind, is_dir, now)

    def _new_dir(self, abs_path: str, now: float) -> None:
        for f in self.add_tree(abs_path, collect_files=True):
            self._set(os.path.relpath(f, self.root), "changed", False, now)

    def _on_event(self, wd: int, mask: int, cookie: int, name: str) -> None:
        if mask & IN_Q_OVERFLOW:
            self.log("watch: kernel event queue overflowed; requesting a full scan")
            self._rebuild = True
            self.wake.set()
            return
        if mask & IN_IGNORED:
            with self._maps:
                self._wd_path.pop(wd, None)
            return
        with self._maps:
            base = self._wd_path.get(wd)
        if base is None or not name or _junk(name, self.skip_names):
            return
        is_dir = bool(mask & IN_ISDIR)
        if is_dir and name in self.skip_dirs:
            return
        abs_path = os.path.join(base, name)
        rel = os.path.relpath(abs_path, self.root)
        now = time.time()
        if mask & IN_MOVED_FROM:
            with self._mu:
                self._move_from[cookie] = (rel, is_dir, now)
        elif mask & IN_MOVED_TO:
            with self._mu:
                src = self._move_from.pop(cookie, None)
            if src is None:
                if is_dir:
                    self._new_dir(abs_path, now)
                else:
                    self._set(rel, "changed", False, now)
                return
            old_rel = src[0]
            if is_dir:
                self._rekey_dir(os.path.join(self.root, old_rel), abs_path)
            with self._mu:
                self._renames.append((old_rel, rel, is_dir, now))
                self._rekey_pending(old_rel, rel, is_dir)
        elif mask & IN_CREATE:
            if is_dir:
                self._new_dir(abs_path, now)
        elif mask & IN_CLOSE_WRITE:
            self._set(rel, "changed", False, now)
        elif mask & IN_DELETE:
            self._set(rel, "deleted", is_dir, now)

    def _rekey_pending(self, old_rel: str, new_rel: str, is_dir: bool) -> None:
        prefix = old_rel + "/"
        for key in list(self._pending):
            if key == old_rel or (is_dir and key.startswith(prefix)):
                self._pending[new_rel + key[len(old_rel) :]] = self._pending.pop(key)

    def _dispatcher(self) -> None:
        pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="inotify-index")
        while not self._stopped.is_set():
            time.sleep(0.5)
            try:
                self._flush(pool)
            except Exception as e:  # noqa: BLE001
                self.log(f"watch: flush failed: {type(e).__name__}: {e}")
        pool.shutdown(wait=False, cancel_futures=True)

    def _flush(self, pool: ThreadPoolExecutor) -> None:
        if self._rebuild:
            self._rebuild = False
            self._rebuild_watches()
        cutoff = time.time() - self.debounce
        with self._mu:
            n = 0
            while n < len(self._renames) and self._renames[n][3] <= cutoff:
                n += 1
            renames, self._renames = self._renames[:n], self._renames[n:]
            for cookie, (rel, is_dir, ts) in list(self._move_from.items()):
                if ts <= cutoff:
                    del self._move_from[cookie]
                    self._pending.setdefault(rel, ("deleted", is_dir, ts))
            due = {k: v for k, v in self._pending.items() if v[2] <= cutoff}
            for k in due:
                del self._pending[k]
        if not renames and not due:
            return

        t0 = time.time()
        tally: Counter[str] = Counter()
        for old_rel, new_rel, is_dir, _ in renames:
            try:
                moved = self.rename(old_rel, new_rel, is_dir)
                tally["renamed"] += moved
                if moved == 0:
                    due.setdefault(new_rel, ("changed", is_dir, 0.0))
            except Exception as e:  # noqa: BLE001
                tally["error"] += 1
                self.log(f"watch: rename {old_rel} -> {new_rel} failed: {type(e).__name__}: {e}")

        futures: list[Future[str]] = []
        for rel, (_kind, is_dir, _ts) in due.items():
            abs_path = os.path.join(self.root, rel)
            try:
                st = os.lstat(abs_path)
            except FileNotFoundError:
                if is_dir:
                    self._drop_dir(abs_path)
                try:
                    tally["deleted"] += self.mark_deleted(rel, is_dir)
                except Exception as e:  # noqa: BLE001
                    tally["error"] += 1
                    self.log(f"watch: delete {rel} failed: {type(e).__name__}: {e}")
                continue
            except OSError as e:
                tally["error"] += 1
                self.log(f"watch: stat {rel}: {e}")
                continue
            if stat.S_ISDIR(st.st_mode):
                for found_path in self.add_tree(abs_path, collect_files=True):
                    futures.append(self._submit(pool, found_path))
            elif stat.S_ISREG(st.st_mode):
                futures.append(self._submit(pool, abs_path))
        for future in futures:
            tally[future.result()] += 1
        self.log(
            f"watch: {tally['renamed']} renamed, {tally['deleted']} deleted, {tally['indexed']} indexed, "
            f"{tally['unchanged']} unchanged, {tally['error']} errors ({time.time() - t0:.1f}s)"
        )

    def _submit(self, pool: ThreadPoolExecutor, abs_path: str) -> Future[str]:
        finish = self.on_queue(abs_path) if self.on_queue is not None else None

        def run() -> str:
            result = "error"
            try:
                result = self._index(abs_path)
                return result
            finally:
                if finish is not None:
                    finish(result)
        try:
            return pool.submit(run)
        except Exception:
            if finish is not None:
                finish("error")
            raise

    def _index(self, abs_path: str) -> str:
        rel = os.path.relpath(abs_path, self.root)
        try:
            st = os.lstat(abs_path)
        except FileNotFoundError:
            self.mark_deleted(rel, False)
            return "deleted"
        except OSError as e:
            self.log(f"watch: stat {rel}: {e}")
            return "error"
        if not stat.S_ISREG(st.st_mode):
            return "skipped"
        return self.index_file(abs_path, rel, st)
