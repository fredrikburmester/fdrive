//! inotify watcher: gets changes into the index within seconds instead of at the next scan.
//! Linux only; elsewhere [`Watcher::new`] fails and the indexer relies on periodic scans.
//!
//! One inotify watch per directory under the root. Kernel events become index actions:
//!   CLOSE_WRITE, unpaired MOVED_TO   -> (re)index the file, unless size+mtime already match its row
//!   DELETE, unpaired MOVED_FROM      -> mark the row (or the subtree) deleted and drop its chunks
//!   MOVED_FROM + MOVED_TO (cookie)   -> rename rows in place: no re-extraction, no re-embedding
//!   CREATE|ISDIR, MOVED_TO|ISDIR     -> watch the new directory, record its folders and index whatever
//!                                       is already in it
//! Events are debounced per path. What is applied is decided by what is on disk at apply
//! time, not by event order.

use std::fs::Metadata;
use std::path::Path;

use crate::failures::FileResult;

/// What the watcher calls back into. Root-relative paths are `/`-joined.
pub trait WatchHandler: Send + Sync + 'static {
    /// Index one regular file; returns its result (status "indexed" | "unchanged" | "error" | "disabled" …).
    fn index_file(&self, abs: &Path, rel: &str, metadata: &Metadata) -> FileResult;
    /// Soft-delete a path or subtree; returns rows affected.
    fn mark_deleted(&self, rel: &str, is_dir: bool) -> usize;
    /// Rename rows; returns rows moved (0 means nothing was indexed under the old path, so the new path
    /// gets indexed instead).
    fn rename(&self, old_rel: &str, new_rel: &str, is_dir: bool) -> usize;
    /// A folder appeared or changed: record it and the folders in it. Its files are indexed
    /// separately.
    fn folder_changed(&self, _rel: &str) {}
    /// Called when a file is queued for indexing; the returned closure is called exactly once with the
    /// job's result (including synthetic results "cancelled", "error", "deleted", "skipped").
    fn on_queue(&self, abs: &Path) -> Box<dyn FnOnce(&FileResult) + Send>;
    fn log(&self, message: &str);
}

#[cfg(target_os = "linux")]
pub use linux::Watcher;
#[cfg(not(target_os = "linux"))]
pub use stub::Watcher;

#[cfg(target_os = "linux")]
mod linux {
    use std::any::Any;
    use std::collections::{HashMap, HashSet};
    use std::ffi::{OsStr, OsString};
    use std::fs::{self, ReadDir};
    use std::io::{self, ErrorKind};
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
    use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask};

    use super::WatchHandler;
    use crate::config::{SKIP_DIRS, SKIP_NAMES};
    use crate::failures::FileResult;

    const MASK: WatchMask = WatchMask::CLOSE_WRITE
        .union(WatchMask::MOVED_FROM)
        .union(WatchMask::MOVED_TO)
        .union(WatchMask::CREATE)
        .union(WatchMask::DELETE)
        .union(WatchMask::ONLYDIR)
        .union(WatchMask::DONT_FOLLOW)
        .union(WatchMask::EXCL_UNLINK);
    const READ_BUFFER: usize = 256 * 1024;
    const IDLE_POLL: Duration = Duration::from_millis(50);
    const READ_RETRY: Duration = Duration::from_secs(1);
    const FLUSH_EVERY: Duration = Duration::from_millis(500);
    const JOIN_WAIT: Duration = Duration::from_secs(1);

    type ListDir = fn(&Path) -> io::Result<ReadDir>;
    type Finish = Box<dyn FnOnce(&FileResult) + Send>;

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn panic_message(payload: &(dyn Any + Send)) -> String {
        payload
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_owned())
    }

    /// Runs `work`, turning a panic into its message, as the Python watcher isolated callback
    /// exceptions.
    fn guarded<R>(work: impl FnOnce() -> R) -> Result<R, String> {
        catch_unwind(AssertUnwindSafe(work)).map_err(|payload| panic_message(&*payload))
    }

    fn read_dir(path: &Path) -> io::Result<ReadDir> {
        fs::read_dir(path)
    }

    fn is_junk(name: &OsStr) -> bool {
        name.to_str()
            .map_or(name.as_encoded_bytes().starts_with(b"._"), |name| {
                crate::paths::is_junk_name(name, SKIP_NAMES)
            })
    }

    fn is_skipped_dir(name: &OsStr) -> bool {
        SKIP_DIRS.iter().any(|skip| name == OsStr::new(skip))
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    /// `path` with its `old` prefix (itself or an ancestor) replaced by `new`.
    fn rebase(path: &Path, old: &Path, new: &Path) -> Option<PathBuf> {
        let rest = path.strip_prefix(old).ok()?;
        Some(if rest.as_os_str().is_empty() {
            new.to_path_buf()
        } else {
            new.join(rest)
        })
    }

    struct RawEvent {
        wd: i32,
        mask: EventMask,
        cookie: u32,
        name: Option<OsString>,
    }

    struct Pending {
        is_dir: bool,
        at: Instant,
        /// Insertion order, so paths apply in the order their events arrived.
        seq: u64,
    }

    struct Rename {
        old: PathBuf,
        new: PathBuf,
        is_dir: bool,
        at: Instant,
    }

    #[derive(Default)]
    struct State {
        pending: HashMap<PathBuf, Pending>,
        seq: u64,
        renames: Vec<Rename>,
        move_from: HashMap<u32, (PathBuf, bool, Instant)>,
        /// Submitted index jobs by path: queued ones read the file when they start, so a newer
        /// event for the same path needs no second job until one is running.
        queued: HashSet<PathBuf>,
        running: HashMap<PathBuf, usize>,
        /// Folders that appeared, reported once their events settle. Their files are pending
        /// on their own.
        folders: HashMap<PathBuf, Instant>,
    }

    impl State {
        fn next_seq(&mut self) -> u64 {
            self.seq += 1;
            self.seq
        }

        fn set(&mut self, rel: PathBuf, is_dir: bool, at: Instant) {
            let seq = self.next_seq();
            let entry = self.pending.entry(rel).or_insert(Pending { is_dir, at, seq });
            entry.is_dir = is_dir;
            entry.at = at;
        }

        fn set_default(&mut self, rel: PathBuf, is_dir: bool, at: Instant) {
            let seq = self.next_seq();
            self.pending.entry(rel).or_insert(Pending { is_dir, at, seq });
        }

        fn rekey_pending(&mut self, old: &Path, new: &Path, is_dir: bool) {
            let keys: Vec<PathBuf> = self
                .pending
                .keys()
                .filter(|key| key.as_path() == old || (is_dir && key.starts_with(old)))
                .cloned()
                .collect();
            for key in keys {
                let (Some(to), Some(mut entry)) = (rebase(&key, old, new), self.pending.remove(&key)) else {
                    continue;
                };
                entry.seq = self.next_seq();
                self.pending.insert(to, entry);
            }
        }
    }

    /// One flush's tally, reported once all of its jobs are done.
    struct Batch {
        handler: Arc<dyn WatchHandler>,
        started: Instant,
        /// Counts by status, and outstanding shares.
        tally: Mutex<(HashMap<String, usize>, usize)>,
    }

    impl Batch {
        /// Starts with one outstanding share, released when the flush has submitted everything.
        fn new(handler: Arc<dyn WatchHandler>) -> Arc<Self> {
            Arc::new(Self {
                handler,
                started: Instant::now(),
                tally: Mutex::new((HashMap::new(), 1)),
            })
        }

        fn add(&self, key: &str, n: usize) {
            *lock(&self.tally).0.entry(key.to_owned()).or_default() += n;
        }

        fn begin(&self) {
            lock(&self.tally).1 += 1;
        }

        fn end(&self, status: Option<&str>) {
            let report = {
                let mut tally = lock(&self.tally);
                if let Some(status) = status {
                    *tally.0.entry(status.to_owned()).or_default() += 1;
                }
                tally.1 -= 1;
                (tally.1 == 0).then(|| {
                    let n = |key: &str| tally.0.get(key).copied().unwrap_or(0);
                    format!(
                        "watch: {} renamed, {} deleted, {} indexed, {} unchanged, {} errors ({:.1}s)",
                        n("renamed"),
                        n("deleted"),
                        n("indexed"),
                        n("unchanged"),
                        n("error"),
                        self.started.elapsed().as_secs_f64()
                    )
                })
            };
            if let Some(report) = report {
                self.handler.log(&report);
            }
        }
    }

    struct Job {
        abs: PathBuf,
        rel: PathBuf,
        finish: Finish,
        batch: Arc<Batch>,
    }

    /// Paths to apply in one flush, in order, each once.
    struct Due {
        items: Vec<(PathBuf, bool)>,
        seen: HashSet<PathBuf>,
    }

    impl Due {
        fn new(items: impl Iterator<Item = (PathBuf, bool)>) -> Self {
            let mut due = Self {
                items: Vec::new(),
                seen: HashSet::new(),
            };
            for (rel, is_dir) in items {
                due.add(rel, is_dir);
            }
            due
        }

        fn add(&mut self, rel: PathBuf, is_dir: bool) {
            if self.seen.insert(rel.clone()) {
                self.items.push((rel, is_dir));
            }
        }
    }

    struct Inner {
        root: PathBuf,
        handler: Arc<dyn WatchHandler>,
        workers: usize,
        debounce: Duration,
        list: ListDir,
        /// `None` once stopped: dropping it closes the descriptor.
        inotify: Mutex<Option<Inotify>>,
        wds: Mutex<HashMap<i32, (WatchDescriptor, PathBuf)>>,
        state: Mutex<State>,
        rebuild: AtomicBool,
        overflow: AtomicBool,
        stopped: AtomicBool,
        /// Dropped on stop, which wakes every stop-aware pause.
        stop_tx: Mutex<Option<Sender<()>>>,
        stop_rx: Receiver<()>,
        jobs_tx: Mutex<Option<Sender<Job>>>,
        jobs_rx: Mutex<Option<Receiver<Job>>>,
    }

    impl Inner {
        fn log(&self, message: &str) {
            self.handler.log(message);
        }

        fn is_stopped(&self) -> bool {
            self.stopped.load(Ordering::SeqCst)
        }

        /// Sleeps up to `duration`; true when the watcher stopped meanwhile.
        fn pause(&self, duration: Duration) -> bool {
            matches!(self.stop_rx.recv_timeout(duration), Err(RecvTimeoutError::Disconnected)) || self.is_stopped()
        }

        fn rel_of(&self, abs: &Path) -> Option<PathBuf> {
            abs.strip_prefix(&self.root).ok().map(Path::to_path_buf)
        }

        fn add_watch(&self, path: &Path) -> bool {
            let added = match lock(&self.inotify).as_ref() {
                Some(inotify) => inotify.watches().add(path, MASK),
                None => return false,
            };
            match added {
                Ok(wd) => {
                    lock(&self.wds).insert(wd.get_watch_descriptor_id(), (wd, path.to_path_buf()));
                    true
                }
                Err(e) => {
                    if !matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) {
                        self.log(&format!("watch: cannot watch {}: {e}", path.display()));
                    }
                    false
                }
            }
        }

        fn remove_watches(&self, wds: Vec<WatchDescriptor>) {
            if let Some(inotify) = lock(&self.inotify).as_ref() {
                let mut watches = inotify.watches();
                for wd in wds {
                    let _ = watches.remove(wd);
                }
            }
        }

        /// Watches `top` and every directory below it; with `collect_files`, also returns the
        /// regular files found on the way.
        fn add_tree(&self, top: &Path, collect_files: bool) -> Vec<PathBuf> {
            let mut files = Vec::new();
            let mut stack = vec![top.to_path_buf()];
            while let Some(dir) = stack.pop() {
                if !self.add_watch(&dir) {
                    continue;
                }
                let entries = match (self.list)(&dir) {
                    Ok(entries) => entries,
                    Err(e) => {
                        self.log(&format!("watch: cannot list {}: {e}", dir.display()));
                        continue;
                    }
                };
                for entry in entries {
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(e) => {
                            self.log(&format!("watch: cannot list {}: {e}", dir.display()));
                            break;
                        }
                    };
                    let Ok(file_type) = entry.file_type() else { continue };
                    let name = entry.file_name();
                    if file_type.is_dir() {
                        if !is_skipped_dir(&name) {
                            stack.push(entry.path());
                        }
                    } else if collect_files && file_type.is_file() && !is_junk(&name) {
                        files.push(entry.path());
                    }
                }
            }
            files
        }

        fn rekey_dir(&self, old_abs: &Path, new_abs: &Path) {
            for (_, path) in lock(&self.wds).values_mut() {
                if let Some(moved) = rebase(path, old_abs, new_abs) {
                    *path = moved;
                }
            }
        }

        fn drop_dir(&self, abs: &Path) {
            let removed: Vec<WatchDescriptor> = {
                let mut wds = lock(&self.wds);
                let ids: Vec<i32> = wds
                    .iter()
                    .filter(|(_, (_, p))| p.starts_with(abs))
                    .map(|(id, _)| *id)
                    .collect();
                ids.into_iter()
                    .filter_map(|id| wds.remove(&id))
                    .map(|(wd, _)| wd)
                    .collect()
            };
            self.remove_watches(removed);
        }

        fn rebuild_watches(&self) {
            let all: Vec<WatchDescriptor> = lock(&self.wds).drain().map(|(_, (wd, _))| wd).collect();
            self.remove_watches(all);
            self.add_tree(&self.root, false);
            self.log(&format!(
                "watch: rebuilt {} directory watches after overflow",
                self.dirs()
            ));
        }

        fn dirs(&self) -> usize {
            lock(&self.wds).len()
        }

        fn read_raw(&self, buffer: &mut [u8]) -> io::Result<Vec<RawEvent>> {
            let mut inotify = lock(&self.inotify);
            let Some(inotify) = inotify.as_mut() else {
                return Err(io::Error::new(ErrorKind::NotConnected, "inotify is closed"));
            };
            Ok(inotify
                .read_events(buffer)?
                .map(|event| RawEvent {
                    wd: event.wd.get_watch_descriptor_id(),
                    mask: event.mask,
                    cookie: event.cookie,
                    name: event.name.map(OsStr::to_os_string),
                })
                .collect())
        }

        fn reader(&self) {
            let mut buffer = vec![0u8; READ_BUFFER];
            self.read_loop(|| self.read_raw(&mut buffer), |event| guarded(|| self.on_event(event)));
        }

        /// Nonblocking reads let stop() end this loop deterministically.
        fn read_loop(
            &self,
            mut read: impl FnMut() -> io::Result<Vec<RawEvent>>,
            mut handle: impl FnMut(&RawEvent) -> Result<(), String>,
        ) {
            while !self.is_stopped() {
                match read() {
                    Ok(events) => {
                        for event in &events {
                            if let Err(message) = handle(event) {
                                self.log(&format!("watch: event handling failed: {message}"));
                            }
                        }
                    }
                    Err(_) if self.is_stopped() => break,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {
                        self.pause(IDLE_POLL);
                    }
                    Err(e) if e.kind() == ErrorKind::Interrupted => {}
                    Err(e) => {
                        self.log(&format!("watch: read failed: {e}"));
                        self.pause(READ_RETRY);
                    }
                }
            }
        }

        fn new_dir(&self, abs: &Path, now: Instant) {
            let files = self.add_tree(abs, true);
            let mut state = lock(&self.state);
            if let Some(rel) = self.rel_of(abs) {
                state.folders.insert(rel, now);
            }
            for file in files {
                if let Some(rel) = self.rel_of(&file) {
                    state.set(rel, false, now);
                }
            }
        }

        fn on_event(&self, event: &RawEvent) {
            let mask = event.mask;
            if mask.contains(EventMask::Q_OVERFLOW) {
                self.log("watch: kernel event queue overflowed; requesting a full scan");
                self.rebuild.store(true, Ordering::SeqCst);
                self.overflow.store(true, Ordering::SeqCst);
                return;
            }
            if mask.contains(EventMask::IGNORED) {
                lock(&self.wds).remove(&event.wd);
                return;
            }
            let Some(base) = lock(&self.wds).get(&event.wd).map(|(_, path)| path.clone()) else {
                return;
            };
            let Some(name) = event.name.as_deref().filter(|name| !name.is_empty() && !is_junk(name)) else {
                return;
            };
            let is_dir = mask.contains(EventMask::ISDIR);
            if is_dir && is_skipped_dir(name) {
                return;
            }
            let abs = base.join(name);
            let Some(rel) = self.rel_of(&abs) else { return };
            let now = Instant::now();
            if mask.contains(EventMask::MOVED_FROM) {
                lock(&self.state).move_from.insert(event.cookie, (rel, is_dir, now));
            } else if mask.contains(EventMask::MOVED_TO) {
                let source = lock(&self.state).move_from.remove(&event.cookie);
                let Some((old_rel, _, _)) = source else {
                    if is_dir {
                        self.new_dir(&abs, now);
                    } else {
                        lock(&self.state).set(rel, false, now);
                    }
                    return;
                };
                if is_dir {
                    self.rekey_dir(&self.root.join(&old_rel), &abs);
                }
                let mut state = lock(&self.state);
                state.rekey_pending(&old_rel, &rel, is_dir);
                state.renames.push(Rename {
                    old: old_rel,
                    new: rel,
                    is_dir,
                    at: now,
                });
            } else if mask.contains(EventMask::CREATE) {
                if is_dir {
                    self.new_dir(&abs, now);
                }
            } else if mask.contains(EventMask::CLOSE_WRITE) {
                lock(&self.state).set(rel, false, now);
            } else if mask.contains(EventMask::DELETE) {
                lock(&self.state).set(rel, is_dir, now);
            }
        }

        fn dispatcher(&self) {
            while !self.pause(FLUSH_EVERY) {
                match guarded(|| self.flush()) {
                    Ok(Ok(())) => {}
                    Ok(Err(message)) | Err(message) => self.log(&format!("watch: flush failed: {message}")),
                }
            }
            self.shutdown_pool();
        }

        /// Paths submitted or running under `rel` (itself, or below it for a directory).
        fn submitted_under(&self, rel: &Path, is_dir: bool) -> Vec<PathBuf> {
            let state = lock(&self.state);
            let matches = |path: &&PathBuf| path.as_path() == rel || (is_dir && path.starts_with(rel));
            let mut paths: Vec<PathBuf> = state.queued.iter().filter(matches).cloned().collect();
            paths.extend(
                state
                    .running
                    .keys()
                    .filter(matches)
                    .filter(|p| !state.queued.contains(*p))
                    .cloned(),
            );
            paths
        }

        fn flush(&self) -> Result<(), String> {
            if self.rebuild.swap(false, Ordering::SeqCst) {
                self.rebuild_watches();
            }
            let now = Instant::now();
            let ready = |at: Instant| now.saturating_duration_since(at) >= self.debounce;
            let (folders, renames, mut due) = {
                let mut state = lock(&self.state);
                let mut folders: Vec<PathBuf> = state
                    .folders
                    .extract_if(|_, at| ready(*at))
                    .map(|(rel, _)| rel)
                    .collect();
                folders.sort();
                let n = state.renames.iter().take_while(|r| ready(r.at)).count();
                let renames: Vec<Rename> = state.renames.drain(..n).collect();
                let expired: Vec<u32> = state
                    .move_from
                    .iter()
                    .filter(|(_, (_, _, at))| ready(*at))
                    .map(|(cookie, _)| *cookie)
                    .collect();
                for cookie in expired {
                    if let Some((rel, is_dir, at)) = state.move_from.remove(&cookie) {
                        state.set_default(rel, is_dir, at);
                    }
                }
                let mut due: Vec<(PathBuf, Pending)> = state.pending.extract_if(|_, p| ready(p.at)).collect();
                due.sort_by_key(|(_, p)| p.seq);
                (
                    folders,
                    renames,
                    Due::new(due.into_iter().map(|(rel, p)| (rel, p.is_dir))),
                )
            };
            if folders.is_empty() && renames.is_empty() && due.items.is_empty() {
                return Ok(());
            }

            let batch = Batch::new(Arc::clone(&self.handler));
            for rel in folders {
                // Moved or removed since: its rename or delete covers it.
                if fs::symlink_metadata(self.root.join(&rel)).is_ok_and(|m| m.is_dir()) {
                    self.folder_changed(&text(&rel), &batch);
                }
            }
            for Rename { old, new, is_dir, .. } in renames {
                // Jobs submitted for the old path may run from it after the move; recheck the new
                // path so a change they missed is not left for the next scan. Only this thread
                // submits, so nothing joins the list before the rename applies.
                let submitted = self.submitted_under(&old, is_dir);
                let (old_text, new_text) = (text(&old), text(&new));
                match guarded(|| self.handler.rename(&old_text, &new_text, is_dir)) {
                    Ok(moved) => {
                        batch.add("renamed", moved);
                        if moved == 0 {
                            due.add(new.clone(), is_dir);
                        }
                        for path in submitted {
                            if let Some(moved_path) = rebase(&path, &old, &new) {
                                due.add(moved_path, false);
                            }
                        }
                    }
                    Err(message) => {
                        batch.add("error", 1);
                        self.log(&format!("watch: rename {old_text} -> {new_text} failed: {message}"));
                    }
                }
            }

            for (rel, is_dir) in due.items {
                let abs = self.root.join(&rel);
                let rel_text = text(&rel);
                let metadata = match fs::symlink_metadata(&abs) {
                    Ok(metadata) => metadata,
                    Err(e) if e.kind() == ErrorKind::NotFound => {
                        if is_dir {
                            self.drop_dir(&abs);
                        }
                        match guarded(|| self.handler.mark_deleted(&rel_text, is_dir)) {
                            Ok(n) => batch.add("deleted", n),
                            Err(message) => {
                                batch.add("error", 1);
                                self.log(&format!("watch: delete {rel_text} failed: {message}"));
                            }
                        }
                        continue;
                    }
                    Err(e) => {
                        batch.add("error", 1);
                        self.log(&format!("watch: stat {rel_text}: {e}"));
                        continue;
                    }
                };
                let found = if metadata.is_dir() {
                    self.folder_changed(&rel_text, &batch);
                    self.add_tree(&abs, true)
                } else if metadata.is_file() {
                    vec![abs]
                } else {
                    continue;
                };
                for path in found {
                    self.submit(&path, &batch)?;
                }
            }
            // Waiting for the batch here held every later event behind its slowest file.
            batch.end(None);
            Ok(())
        }

        fn folder_changed(&self, rel: &str, batch: &Batch) {
            if let Err(message) = guarded(|| self.handler.folder_changed(rel)) {
                batch.add("error", 1);
                self.log(&format!("watch: folder {rel} failed: {message}"));
            }
        }

        fn submit(&self, abs: &Path, batch: &Arc<Batch>) -> Result<(), String> {
            let Some(rel) = self.rel_of(abs) else { return Ok(()) };
            if !lock(&self.state).queued.insert(rel.clone()) {
                return Ok(());
            }
            let finish = self.handler.on_queue(abs);
            batch.begin();
            let job = Job {
                abs: abs.to_path_buf(),
                rel,
                finish,
                batch: Arc::clone(batch),
            };
            // Sending under the lock: once shutdown took the sender, no job can slip past its drain.
            let rejected = match lock(&self.jobs_tx).as_ref() {
                Some(tx) => tx.send(job).err().map(|e| e.into_inner()),
                None => Some(job),
            };
            let Some(job) = rejected else { return Ok(()) };
            lock(&self.state).queued.remove(&job.rel);
            let _ = guarded(|| (job.finish)(&FileResult::plain("error")));
            job.batch.end(None);
            Err("cannot schedule new index jobs after shutdown".to_owned())
        }

        fn start_pool(self: &Arc<Self>) -> io::Result<()> {
            let (tx, rx) = crossbeam_channel::unbounded::<Job>();
            *lock(&self.jobs_tx) = Some(tx);
            *lock(&self.jobs_rx) = Some(rx.clone());
            for i in 0..self.workers {
                let (inner, rx) = (Arc::clone(self), rx.clone());
                thread::Builder::new()
                    .name(format!("inotify-index-{i}"))
                    .spawn(move || inner.work(&rx))?;
            }
            Ok(())
        }

        /// Stops accepting jobs; those that never started report "cancelled".
        fn shutdown_pool(&self) {
            lock(&self.jobs_tx).take();
            let rx = lock(&self.jobs_rx).take();
            if let Some(rx) = rx {
                while let Ok(job) = rx.try_recv() {
                    self.cancel(job);
                }
            }
        }

        fn cancel(&self, job: Job) {
            lock(&self.state).queued.remove(&job.rel);
            let status = match guarded(|| (job.finish)(&FileResult::plain("cancelled"))) {
                Ok(()) => "cancelled",
                Err(_) => "error",
            };
            job.batch.end(Some(status));
        }

        fn work(&self, rx: &Receiver<Job>) {
            while let Ok(job) = rx.recv() {
                if self.is_stopped() {
                    self.cancel(job);
                    continue;
                }
                {
                    let mut state = lock(&self.state);
                    state.queued.remove(&job.rel);
                    *state.running.entry(job.rel.clone()).or_default() += 1;
                }
                let result = guarded(|| self.index(&job.abs, &job.rel)).unwrap_or_else(|_| FileResult::plain("error"));
                {
                    let mut state = lock(&self.state);
                    if let Some(count) = state.running.get_mut(&job.rel) {
                        *count -= 1;
                        if *count == 0 {
                            state.running.remove(&job.rel);
                        }
                    }
                }
                let status = match guarded(|| (job.finish)(&result)) {
                    Ok(()) => result.status,
                    Err(_) => "error".to_owned(),
                };
                job.batch.end(Some(&status));
            }
        }

        fn index(&self, abs: &Path, rel: &Path) -> FileResult {
            let rel = text(rel);
            match fs::symlink_metadata(abs) {
                Err(e) if e.kind() == ErrorKind::NotFound => {
                    self.handler.mark_deleted(&rel, false);
                    FileResult::plain("deleted")
                }
                Err(e) => {
                    self.log(&format!("watch: stat {rel}: {e}"));
                    FileResult::plain("error")
                }
                Ok(metadata) if !metadata.is_file() => FileResult::plain("skipped"),
                Ok(metadata) => self.handler.index_file(abs, &rel, &metadata),
            }
        }
    }

    /// Watches one root with inotify and turns its changes into index actions.
    pub struct Watcher {
        inner: Arc<Inner>,
        threads: Mutex<Vec<JoinHandle<()>>>,
        started: AtomicBool,
    }

    impl Watcher {
        pub fn new(
            root: PathBuf,
            handler: Arc<dyn WatchHandler>,
            workers: usize,
            debounce: Duration,
        ) -> io::Result<Self> {
            Self::build(root, handler, workers, debounce, read_dir)
        }

        fn build(
            root: PathBuf,
            handler: Arc<dyn WatchHandler>,
            workers: usize,
            debounce: Duration,
            list: ListDir,
        ) -> io::Result<Self> {
            let inotify = Inotify::init()?;
            let (stop_tx, stop_rx) = crossbeam_channel::bounded(0);
            Ok(Self {
                inner: Arc::new(Inner {
                    root,
                    handler,
                    workers: workers.max(1),
                    debounce,
                    list,
                    inotify: Mutex::new(Some(inotify)),
                    wds: Mutex::new(HashMap::new()),
                    state: Mutex::new(State::default()),
                    rebuild: AtomicBool::new(false),
                    overflow: AtomicBool::new(false),
                    stopped: AtomicBool::new(false),
                    stop_tx: Mutex::new(Some(stop_tx)),
                    stop_rx,
                    jobs_tx: Mutex::new(None),
                    jobs_rx: Mutex::new(None),
                }),
                threads: Mutex::new(Vec::new()),
                started: AtomicBool::new(false),
            })
        }

        /// Watches the whole tree and starts the reader, dispatcher and index workers.
        pub fn start(&self) -> io::Result<()> {
            if self.inner.is_stopped() {
                return Err(io::Error::other("watcher is stopped"));
            }
            if self.started.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            self.inner.add_tree(&self.inner.root, false);
            self.inner.start_pool()?;
            let reader = Arc::clone(&self.inner);
            let dispatcher = Arc::clone(&self.inner);
            let mut threads = lock(&self.threads);
            threads.push(
                thread::Builder::new()
                    .name("inotify-reader".to_owned())
                    .spawn(move || reader.reader())?,
            );
            threads.push(
                thread::Builder::new()
                    .name("inotify-dispatch".to_owned())
                    .spawn(move || dispatcher.dispatcher())?,
            );
            Ok(())
        }

        /// Releases inotify and the threads; idempotent. Waits up to a second for each thread.
        pub fn stop(&self) {
            if self.inner.stopped.swap(true, Ordering::SeqCst) {
                return;
            }
            lock(&self.inner.stop_tx).take();
            lock(&self.inner.inotify).take();
            let threads = std::mem::take(&mut *lock(&self.threads));
            if threads.is_empty() {
                self.inner.shutdown_pool();
            }
            let current = thread::current().id();
            for handle in threads {
                if handle.thread().id() == current {
                    continue;
                }
                let deadline = Instant::now() + JOIN_WAIT;
                while !handle.is_finished() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(5));
                }
                if handle.is_finished() {
                    let _ = handle.join();
                }
            }
        }

        pub fn dirs(&self) -> usize {
            self.inner.dirs()
        }

        /// True once after the kernel queue overflowed: the caller should run a full scan.
        pub fn take_overflow(&self) -> bool {
            self.inner.overflow.swap(false, Ordering::SeqCst)
        }
    }

    impl Drop for Watcher {
        fn drop(&mut self) {
            self.stop();
        }
    }

    #[cfg(test)]
    mod tests {
        use std::collections::HashSet;
        use std::fs;
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::{Duration, Instant};

        use inotify::EventMask;

        use super::{Batch, RawEvent, Rename, Watcher, guarded, lock};
        use crate::failures::FileResult;
        use crate::watcher::WatchHandler;

        fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if predicate() {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            predicate()
        }

        #[derive(Default)]
        struct Recorder {
            root: PathBuf,
            indexed: Mutex<Vec<String>>,
            deleted: Mutex<Vec<(String, bool)>>,
            renamed: Mutex<Vec<(String, String, bool)>>,
            folders: Mutex<Vec<String>>,
            logs: Mutex<Vec<String>>,
            started: Mutex<Vec<String>>,
            finished: Arc<Mutex<Vec<(String, String)>>>,
            blocked: HashSet<String>,
            released: Mutex<bool>,
            release_cv: Condvar,
            moved: usize,
            fail_rename: bool,
            fail_delete: bool,
            fail_folder: bool,
        }

        impl Recorder {
            fn new(root: &Path) -> Self {
                Self {
                    root: root.to_path_buf(),
                    moved: 1,
                    ..Self::default()
                }
            }

            fn blocking(root: &Path, blocked: &[&str]) -> Self {
                Self {
                    blocked: blocked.iter().map(|s| (*s).to_owned()).collect(),
                    ..Self::new(root)
                }
            }

            fn release(&self) {
                *lock(&self.released) = true;
                self.release_cv.notify_all();
            }

            fn indexed(&self) -> Vec<String> {
                lock(&self.indexed).clone()
            }

            fn logs(&self) -> Vec<String> {
                lock(&self.logs).clone()
            }

            fn logged(&self, needle: &str) -> usize {
                self.logs().iter().filter(|line| line.contains(needle)).count()
            }
        }

        impl WatchHandler for Recorder {
            fn index_file(&self, _abs: &Path, rel: &str, _metadata: &fs::Metadata) -> FileResult {
                lock(&self.started).push(rel.to_owned());
                if self.blocked.contains(rel) {
                    let released = lock(&self.released);
                    let (released, _) = self
                        .release_cv
                        .wait_timeout_while(released, Duration::from_secs(5), |r| !*r)
                        .unwrap();
                    assert!(*released);
                }
                lock(&self.indexed).push(rel.to_owned());
                FileResult::plain("indexed")
            }

            fn mark_deleted(&self, rel: &str, is_dir: bool) -> usize {
                assert!(!self.fail_delete, "db down");
                lock(&self.deleted).push((rel.to_owned(), is_dir));
                1
            }

            fn rename(&self, old_rel: &str, new_rel: &str, is_dir: bool) -> usize {
                assert!(!self.fail_rename, "db down");
                lock(&self.renamed).push((old_rel.to_owned(), new_rel.to_owned(), is_dir));
                self.moved
            }

            fn folder_changed(&self, rel: &str) {
                assert!(!self.fail_folder, "db down");
                lock(&self.folders).push(rel.to_owned());
            }

            fn on_queue(&self, abs: &Path) -> Box<dyn FnOnce(&FileResult) + Send> {
                let rel = abs.strip_prefix(&self.root).unwrap().to_string_lossy().into_owned();
                let finished = Arc::clone(&self.finished);
                lock(&finished).push((rel.clone(), "queued".to_owned()));
                Box::new(move |result| lock(&finished).push((rel, result.status.clone())))
            }

            fn log(&self, message: &str) {
                lock(&self.logs).push(message.to_owned());
            }
        }

        fn watcher(root: &Path, recorder: &Arc<Recorder>, workers: usize, debounce: f64) -> Watcher {
            let handler: Arc<dyn WatchHandler> = recorder.clone();
            Watcher::new(root.to_path_buf(), handler, workers, Duration::from_secs_f64(debounce)).unwrap()
        }

        fn started(root: &Path, recorder: &Arc<Recorder>, debounce: f64) -> Watcher {
            let w = watcher(root, recorder, 4, debounce);
            w.start().unwrap();
            w
        }

        /// A watcher whose pool runs but whose flushes the test drives by hand.
        fn manual(root: &Path, recorder: &Arc<Recorder>, workers: usize) -> Watcher {
            let w = watcher(root, recorder, workers, 0.0);
            w.inner.start_pool().unwrap();
            w
        }

        fn queue(w: &Watcher, rel: &str) {
            lock(&w.inner.state).set(PathBuf::from(rel), false, Instant::now());
        }

        fn push_rename(w: &Watcher, old: &str, new: &str, is_dir: bool) {
            let rename = Rename {
                old: old.into(),
                new: new.into(),
                is_dir,
                at: Instant::now(),
            };
            lock(&w.inner.state).renames.push(rename);
        }

        fn flush(w: &Watcher) {
            w.inner.flush().unwrap();
        }

        fn event(wd: i32, mask: EventMask) -> RawEvent {
            RawEvent {
                wd,
                mask,
                cookie: 0,
                name: None,
            }
        }

        fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
            items.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect()
        }

        #[test]
        fn detects_new_file() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let _w = started(tmp.path(), &rec, 0.2);
            fs::write(tmp.path().join("a.txt"), "hello").unwrap();
            assert!(wait_until(|| rec.indexed().len() == 1));
            assert_eq!(rec.indexed(), ["a.txt"]);
            assert!(wait_until(|| rec
                .logged("watch: 0 renamed, 0 deleted, 1 indexed, 0 unchanged, 0 errors (")
                == 1));
        }

        #[test]
        fn reports_a_new_folder_before_indexing_its_files() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let _w = started(tmp.path(), &rec, 0.2);
            fs::create_dir(tmp.path().join("Microlärande")).unwrap();
            assert!(wait_until(|| lock(&rec.folders).len() == 1));
            assert_eq!(*lock(&rec.folders), ["Microlärande"]);
            assert!(rec.indexed().is_empty());
        }

        #[test]
        fn a_failed_folder_report_is_logged_and_its_files_still_indexed() {
            let tmp = tempfile::tempdir().unwrap();
            fs::create_dir_all(tmp.path().join("d")).unwrap();
            fs::write(tmp.path().join("d/a.txt"), "x").unwrap();
            let rec = Arc::new(Recorder {
                fail_folder: true,
                ..Recorder::new(tmp.path())
            });
            let w = manual(tmp.path(), &rec, 1);
            lock(&w.inner.state).set(PathBuf::from("d"), true, Instant::now());
            flush(&w);
            assert!(wait_until(|| rec.indexed() == ["d/a.txt"]));
            assert_eq!(rec.logged("watch: folder d failed: db down"), 1);
            assert!(wait_until(|| rec.logged("1 indexed, 0 unchanged, 1 errors (") == 1));
        }

        #[test]
        fn detects_delete() {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("a.txt"), "hello").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 0.2);
            assert_eq!(w.dirs(), 1);
            fs::remove_file(tmp.path().join("a.txt")).unwrap();
            assert!(wait_until(|| lock(&rec.deleted).len() == 1));
            assert_eq!(lock(&rec.deleted)[0], ("a.txt".to_owned(), false));
        }

        #[test]
        fn detects_rename() {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("old.txt"), "hello").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let _w = started(tmp.path(), &rec, 0.2);
            fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
            assert!(wait_until(|| lock(&rec.renamed).len() == 1));
            assert_eq!(
                lock(&rec.renamed)[0],
                ("old.txt".to_owned(), "new.txt".to_owned(), false)
            );
            std::thread::sleep(Duration::from_millis(700));
            assert!(
                rec.indexed().is_empty(),
                "a paired rename moves rows instead of reindexing"
            );
        }

        #[test]
        fn rename_of_an_unindexed_path_indexes_the_new_path() {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("old.txt"), "hello").unwrap();
            let rec = Arc::new(Recorder {
                moved: 0,
                ..Recorder::new(tmp.path())
            });
            let _w = started(tmp.path(), &rec, 0.1);
            fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
            assert!(wait_until(|| rec.indexed() == ["new.txt"]));
        }

        #[test]
        fn detects_new_directory_and_its_files() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 0.2);
            fs::create_dir(tmp.path().join("sub")).unwrap();
            fs::write(tmp.path().join("sub/inner.txt"), "hi").unwrap();
            assert!(wait_until(|| rec.indexed().iter().any(|rel| rel == "sub/inner.txt")));
            assert_eq!(w.dirs(), 2);
        }

        #[test]
        fn renames_directory_and_rekeys_watches() {
            let tmp = tempfile::tempdir().unwrap();
            fs::create_dir(tmp.path().join("srcdir")).unwrap();
            fs::write(tmp.path().join("srcdir/a.txt"), "hi").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 0.2);
            assert_eq!(w.dirs(), 2);
            fs::rename(tmp.path().join("srcdir"), tmp.path().join("dstdir")).unwrap();
            assert!(wait_until(|| lock(&rec.renamed).len() == 1));
            assert_eq!(lock(&rec.renamed)[0], ("srcdir".to_owned(), "dstdir".to_owned(), true));
            // The moved directory's watch now reports under its new name.
            fs::write(tmp.path().join("dstdir/b.txt"), "hi").unwrap();
            assert!(wait_until(|| rec.indexed() == ["dstdir/b.txt"]));
            assert_eq!(w.dirs(), 2);
        }

        #[test]
        fn ignores_skip_dirs_and_junk_names() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 0.2);
            fs::create_dir(tmp.path().join("node_modules")).unwrap();
            fs::write(tmp.path().join("node_modules/x.txt"), "x").unwrap();
            fs::write(tmp.path().join(".DS_Store"), "junk").unwrap();
            fs::write(tmp.path().join("._real.txt"), "junk").unwrap();
            fs::write(tmp.path().join("real.txt"), "real").unwrap();
            assert!(wait_until(|| rec.indexed().len() == 1));
            std::thread::sleep(Duration::from_millis(700));
            assert_eq!(rec.indexed(), ["real.txt"]);
            assert_eq!(w.dirs(), 1);
        }

        #[test]
        fn add_watch_of_a_missing_path_fails_quietly() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 2.0);
            fs::write(tmp.path().join("file"), "x").unwrap();
            assert!(!w.inner.add_watch(&tmp.path().join("does-not-exist")));
            assert!(!w.inner.add_watch(&tmp.path().join("file")));
            assert!(rec.logs().is_empty());
            assert_eq!(w.dirs(), 0);
        }

        #[test]
        fn stop_joins_idle_reader_dispatcher_and_workers() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 2.0);
            assert_eq!(lock(&w.threads).len(), 2);
            assert!(lock(&w.threads).iter().all(|t| !t.is_finished()));
            let begun = Instant::now();
            w.stop();
            assert!(
                begun.elapsed() < Duration::from_millis(900),
                "stop must not wait for the bounded timeout"
            );
            assert!(lock(&w.threads).is_empty());
            assert!(lock(&w.inner.inotify).is_none());
            // Every thread held a reference; only the watcher's own remains once they all exit.
            assert!(wait_until(|| Arc::strong_count(&w.inner) == 1));
            assert!(w.start().is_err());
            assert!(rec.logs().is_empty());
        }

        #[test]
        fn stop_is_idempotent() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            w.stop();
            w.stop();
            assert!(w.inner.is_stopped());
            let w = started(tmp.path(), &rec, 0.0);
            w.stop();
            w.stop();
            assert!(!w.inner.add_watch(tmp.path()));
        }

        #[test]
        fn reader_retries_a_nonblocking_empty_queue() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            // The real descriptor is nonblocking: an idle read returns at once.
            let mut buffer = vec![0u8; 4096];
            assert_eq!(
                w.inner.read_raw(&mut buffer).err().map(|e| e.kind()),
                Some(std::io::ErrorKind::WouldBlock)
            );
            let reads = AtomicUsize::new(0);
            let begun = Instant::now();
            w.inner.read_loop(
                || {
                    if reads.fetch_add(1, Ordering::SeqCst) == 1 {
                        w.inner.stopped.store(true, Ordering::SeqCst);
                    }
                    Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
                },
                |_| Ok(()),
            );
            assert_eq!(reads.load(Ordering::SeqCst), 2);
            assert!(begun.elapsed() >= Duration::from_millis(50));
            assert!(rec.logs().is_empty());
        }

        #[test]
        fn reader_recovers_from_a_read_error() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            let reads = AtomicUsize::new(0);
            let handled = AtomicUsize::new(0);
            w.inner.read_loop(
                || match reads.fetch_add(1, Ordering::SeqCst) {
                    0 => Err(std::io::Error::other("boom")),
                    1 => Ok(vec![event(1, EventMask::CLOSE_WRITE)]),
                    _ => {
                        w.inner.stopped.store(true, Ordering::SeqCst);
                        Ok(Vec::new())
                    }
                },
                |_| {
                    handled.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            );
            assert_eq!(handled.load(Ordering::SeqCst), 1);
            assert_eq!(rec.logs(), ["watch: read failed: boom"]);
        }

        #[test]
        fn reader_isolates_one_bad_kernel_event() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            let reads = AtomicUsize::new(0);
            w.inner.read_loop(
                || {
                    if reads.fetch_add(1, Ordering::SeqCst) > 0 {
                        w.inner.stopped.store(true, Ordering::SeqCst);
                    }
                    Ok(vec![event(1, EventMask::CLOSE_WRITE), event(1, EventMask::CLOSE_WRITE)])
                },
                |_| guarded(|| panic!("bad event")),
            );
            assert_eq!(rec.logged("watch: event handling failed: bad event"), 4);
        }

        #[test]
        fn move_from_without_move_to_is_treated_as_delete() {
            let outer = tempfile::tempdir().unwrap();
            let root = outer.path().join("root");
            fs::create_dir(&root).unwrap();
            fs::write(root.join("a.txt"), "hi").unwrap();
            let rec = Arc::new(Recorder::new(&root));
            let _w = started(&root, &rec, 0.1);
            fs::rename(root.join("a.txt"), outer.path().join("moved-out.txt")).unwrap();
            assert!(wait_until(|| lock(&rec.deleted).len() == 1));
            assert_eq!(lock(&rec.deleted)[0], ("a.txt".to_owned(), false));
            assert!(lock(&rec.renamed).is_empty());
        }

        #[test]
        fn move_to_from_outside_is_treated_as_new() {
            let outer = tempfile::tempdir().unwrap();
            let root = outer.path().join("root");
            fs::create_dir(&root).unwrap();
            fs::write(outer.path().join("a.txt"), "hi").unwrap();
            fs::create_dir(outer.path().join("dir")).unwrap();
            fs::write(outer.path().join("dir/b.txt"), "hi").unwrap();
            let rec = Arc::new(Recorder::new(&root));
            let w = started(&root, &rec, 0.1);
            fs::rename(outer.path().join("a.txt"), root.join("a.txt")).unwrap();
            fs::rename(outer.path().join("dir"), root.join("dir")).unwrap();
            assert!(wait_until(|| rec.indexed().len() == 2));
            let mut indexed = rec.indexed();
            indexed.sort();
            assert_eq!(indexed, ["a.txt", "dir/b.txt"]);
            assert_eq!(w.dirs(), 2);
        }

        #[test]
        fn overflow_requests_a_scan_and_rebuilds_watches() {
            let tmp = tempfile::tempdir().unwrap();
            fs::create_dir(tmp.path().join("sub")).unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.1);
            w.inner.add_tree(tmp.path(), false);
            assert_eq!(w.dirs(), 2);
            w.inner.on_event(&event(-1, EventMask::Q_OVERFLOW));
            assert!(w.take_overflow());
            assert!(!w.take_overflow());
            assert_eq!(
                rec.logs(),
                ["watch: kernel event queue overflowed; requesting a full scan"]
            );
            flush(&w);
            assert_eq!(rec.logged("watch: rebuilt 2 directory watches after overflow"), 1);
            assert_eq!(w.dirs(), 2);
            flush(&w);
            assert_eq!(rec.logs().len(), 2, "a rebuild happens once per overflow");
        }

        #[test]
        fn ignored_event_drops_the_watch() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.1);
            w.inner.add_tree(tmp.path(), false);
            let wd = *lock(&w.inner.wds).keys().next().unwrap();
            w.inner.on_event(&event(wd, EventMask::IGNORED));
            assert_eq!(w.dirs(), 0);
        }

        #[test]
        fn flush_logs_a_rename_failure() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder {
                fail_rename: true,
                ..Recorder::new(tmp.path())
            });
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            push_rename(&w, "old.txt", "new.txt", false);
            flush(&w);
            assert_eq!(rec.logged("watch: rename old.txt -> new.txt failed: db down"), 1);
            assert_eq!(
                rec.logged("watch: 0 renamed, 0 deleted, 0 indexed, 0 unchanged, 1 errors"),
                1
            );
        }

        #[test]
        fn flush_logs_a_delete_failure() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder {
                fail_delete: true,
                ..Recorder::new(tmp.path())
            });
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            queue(&w, "missing.txt");
            flush(&w);
            assert_eq!(rec.logged("watch: delete missing.txt failed: db down"), 1);
        }

        #[test]
        fn flush_logs_a_stat_error() {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("a.txt"), "hi").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            queue(&w, "a.txt/x"); // ENOTDIR: an error other than not-found
            flush(&w);
            assert_eq!(rec.logged("watch: stat a.txt/x: "), 1);
            assert!(lock(&rec.deleted).is_empty());
        }

        #[test]
        fn flush_waits_for_the_debounce() {
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("a.txt"), "hi").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 60.0);
            w.inner.start_pool().unwrap();
            queue(&w, "a.txt");
            push_rename(&w, "b.txt", "c.txt", false);
            flush(&w);
            assert!(rec.logs().is_empty());
            assert_eq!(lock(&w.inner.state).pending.len(), 1);
            assert_eq!(lock(&w.inner.state).renames.len(), 1);
        }

        #[test]
        fn flush_does_not_wait_for_a_slow_file() {
            let tmp = tempfile::tempdir().unwrap();
            for name in ["slow.pdf", "next.txt"] {
                fs::write(tmp.path().join(name), name).unwrap();
            }
            let rec = Arc::new(Recorder::blocking(tmp.path(), &["slow.pdf"]));
            let w = manual(tmp.path(), &rec, 2);
            queue(&w, "slow.pdf");
            flush(&w);
            queue(&w, "next.txt");
            flush(&w);
            assert!(wait_until(|| rec.indexed() == ["next.txt"]));
            // Each batch reports once its own jobs are done; the slow batch has not finished.
            assert!(wait_until(|| rec.logged("1 indexed") == 1));
            rec.release();
            assert!(wait_until(|| rec.indexed().len() == 2));
            let mut indexed = rec.indexed();
            indexed.sort();
            assert_eq!(indexed, ["next.txt", "slow.pdf"]);
            assert!(wait_until(|| rec.logged("1 indexed") == 2));
        }

        #[test]
        fn flush_submits_a_queued_path_once() {
            let tmp = tempfile::tempdir().unwrap();
            for name in ["busy.pdf", "a.txt"] {
                fs::write(tmp.path().join(name), name).unwrap();
            }
            let rec = Arc::new(Recorder::blocking(tmp.path(), &["busy.pdf"]));
            let w = manual(tmp.path(), &rec, 1);
            queue(&w, "busy.pdf");
            flush(&w);
            assert!(wait_until(|| *lock(&rec.started) == ["busy.pdf"]));
            for _ in 0..3 {
                queue(&w, "a.txt");
                flush(&w);
            }
            // A change while a job runs needs one more pass, since it may have read the old file.
            queue(&w, "busy.pdf");
            flush(&w);
            rec.release();
            assert!(wait_until(|| rec.indexed().len() == 3));
            std::thread::sleep(Duration::from_millis(100));
            assert_eq!(rec.indexed(), ["busy.pdf", "a.txt", "busy.pdf"]);
        }

        #[test]
        fn stopping_ends_the_activity_of_jobs_that_never_started() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::blocking(tmp.path(), &["slow.pdf"]));
            let w = watcher(tmp.path(), &rec, 1, 0.0);
            w.start().unwrap();
            fs::write(tmp.path().join("slow.pdf"), "slow").unwrap();
            assert!(wait_until(|| *lock(&rec.started) == ["slow.pdf"]));
            for name in ["a.txt", "b.txt"] {
                fs::write(tmp.path().join(name), name).unwrap();
            }
            let expected: HashSet<PathBuf> = ["a.txt", "b.txt"].into_iter().map(PathBuf::from).collect();
            assert!(wait_until(|| lock(&w.inner.state).queued == expected));
            w.stop();
            rec.release();
            let ended = || {
                let mut ended: Vec<(String, String)> = lock(&rec.finished)
                    .iter()
                    .filter(|(_, status)| status != "queued")
                    .cloned()
                    .collect();
                ended.sort();
                ended
            };
            assert!(wait_until(|| ended().len() == 3));
            assert_eq!(
                ended(),
                pairs(&[("a.txt", "cancelled"), ("b.txt", "cancelled"), ("slow.pdf", "indexed")])
            );
            assert_eq!(rec.indexed(), ["slow.pdf"]);
        }

        #[test]
        fn rename_rechecks_the_new_path_of_a_file_still_being_indexed() {
            let tmp = tempfile::tempdir().unwrap();
            fs::create_dir(tmp.path().join("docs")).unwrap();
            fs::write(tmp.path().join("docs/report.pdf"), "edited").unwrap();
            let rec = Arc::new(Recorder::blocking(tmp.path(), &["docs/report.pdf"]));
            let w = manual(tmp.path(), &rec, 1);
            queue(&w, "docs/report.pdf");
            flush(&w);
            assert!(wait_until(|| *lock(&rec.started) == ["docs/report.pdf"]));
            fs::rename(tmp.path().join("docs"), tmp.path().join("archive")).unwrap();
            push_rename(&w, "docs", "archive", true);
            flush(&w);
            rec.release();
            assert!(wait_until(|| rec.indexed().len() == 2));
            assert_eq!(*lock(&rec.renamed), [("docs".to_owned(), "archive".to_owned(), true)]);
            assert_eq!(rec.indexed(), ["docs/report.pdf", "archive/report.pdf"]);
        }

        #[test]
        fn rename_rekeys_pending_paths() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 60.0);
            let mut state = lock(&w.inner.state);
            for rel in ["docs/a.txt", "docs/sub/b.txt", "docsx/c.txt", "docs"] {
                state.set(rel.into(), false, Instant::now());
            }
            state.rekey_pending(Path::new("docs"), Path::new("archive"), true);
            let mut keys: Vec<String> = state.pending.keys().map(|k| k.to_string_lossy().into_owned()).collect();
            keys.sort();
            assert_eq!(keys, ["archive", "archive/a.txt", "archive/sub/b.txt", "docsx/c.txt"]);
            state.rekey_pending(Path::new("docsx/c.txt"), Path::new("c.txt"), false);
            assert!(state.pending.contains_key(Path::new("c.txt")));
        }

        #[test]
        fn index_marks_a_missing_file_deleted() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 2.0);
            let result = w.inner.index(&tmp.path().join("missing.txt"), Path::new("missing.txt"));
            assert_eq!(result.status, "deleted");
            assert_eq!(*lock(&rec.deleted), [("missing.txt".to_owned(), false)]);
        }

        #[test]
        fn index_skips_non_regular_files() {
            let tmp = tempfile::tempdir().unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = watcher(tmp.path(), &rec, 1, 2.0);
            fs::write(tmp.path().join("target.txt"), "x").unwrap();
            std::os::unix::fs::symlink(tmp.path().join("target.txt"), tmp.path().join("link")).unwrap();
            assert_eq!(
                w.inner.index(&tmp.path().join("link"), Path::new("link")).status,
                "skipped"
            );
            assert_eq!(
                w.inner
                    .index(&tmp.path().join("target.txt"), Path::new("target.txt"))
                    .status,
                "indexed"
            );
            let bad = tmp.path().join("target.txt/x");
            assert_eq!(w.inner.index(&bad, Path::new("target.txt/x")).status, "error");
            assert_eq!(rec.logged("watch: stat target.txt/x: "), 1);
        }

        #[test]
        fn removes_descendant_watches_after_directory_delete() {
            let tmp = tempfile::tempdir().unwrap();
            fs::create_dir_all(tmp.path().join("removed/child")).unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = started(tmp.path(), &rec, 0.0);
            assert_eq!(w.dirs(), 3);
            fs::remove_dir_all(tmp.path().join("removed")).unwrap();
            assert!(wait_until(|| lock(&rec.deleted).contains(&("removed".to_owned(), true))));
            assert!(wait_until(|| w.dirs() == 1));
        }

        #[test]
        fn logs_directory_enumeration_failure() {
            fn denied(_path: &Path) -> std::io::Result<fs::ReadDir> {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied"))
            }
            let tmp = tempfile::tempdir().unwrap();
            fs::write(tmp.path().join("a.txt"), "x").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let handler: Arc<dyn WatchHandler> = rec.clone();
            let w = Watcher::build(tmp.path().to_path_buf(), handler, 1, Duration::ZERO, denied).unwrap();
            assert!(w.inner.add_tree(tmp.path(), true).is_empty());
            w.stop();
            assert_eq!(rec.logged("cannot list"), 1);
            assert_eq!(rec.logged("denied"), 1);
        }

        #[test]
        fn tracks_queued_work_and_cleans_up_a_submission_after_shutdown() {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("one.txt");
            fs::write(&path, "one").unwrap();
            let rec = Arc::new(Recorder::new(tmp.path()));
            let w = manual(tmp.path(), &rec, 1);
            queue(&w, "one.txt");
            flush(&w);
            let calls = |items: &[&str]| -> Vec<(String, String)> {
                items.iter().map(|s| ("one.txt".to_owned(), (*s).to_owned())).collect()
            };
            assert!(wait_until(|| *lock(&rec.finished) == calls(&["queued", "indexed"])));
            w.stop();
            let handler: Arc<dyn WatchHandler> = rec.clone();
            let error = w.inner.submit(&path, &Batch::new(handler)).unwrap_err();
            assert!(error.contains("after shutdown"));
            assert_eq!(*lock(&rec.finished), calls(&["queued", "indexed", "queued", "error"]));
            assert!(lock(&w.inner.state).queued.is_empty());
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod stub {
    use std::io;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use super::WatchHandler;

    fn unsupported() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, "inotify is only available on Linux")
    }

    /// Stand-in for platforms without inotify: it can never be created.
    pub struct Watcher {
        _private: (),
    }

    impl Watcher {
        pub fn new(
            _root: PathBuf,
            _handler: Arc<dyn WatchHandler>,
            _workers: usize,
            _debounce: Duration,
        ) -> io::Result<Self> {
            Err(unsupported())
        }

        pub fn start(&self) -> io::Result<()> {
            Err(unsupported())
        }

        pub fn stop(&self) {}

        pub fn dirs(&self) -> usize {
            0
        }

        pub fn take_overflow(&self) -> bool {
            false
        }
    }

    #[cfg(test)]
    mod tests {
        use std::path::Path;

        use super::*;
        use crate::failures::FileResult;

        struct Noop;

        impl WatchHandler for Noop {
            fn index_file(&self, _abs: &Path, _rel: &str, _metadata: &std::fs::Metadata) -> FileResult {
                FileResult::plain("indexed")
            }
            fn mark_deleted(&self, _rel: &str, _is_dir: bool) -> usize {
                0
            }
            fn rename(&self, _old_rel: &str, _new_rel: &str, _is_dir: bool) -> usize {
                0
            }
            fn on_queue(&self, _abs: &Path) -> Box<dyn FnOnce(&FileResult) + Send> {
                Box::new(|_| {})
            }
            fn log(&self, _message: &str) {}
        }

        #[test]
        fn watcher_is_unavailable_off_linux() {
            let error = Watcher::new(PathBuf::from("."), Arc::new(Noop), 1, Duration::ZERO)
                .err()
                .unwrap();
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
            assert_eq!(error.to_string(), "inotify is only available on Linux");
            let noop: &dyn WatchHandler = &Noop;
            assert_eq!(noop.mark_deleted("a", false) + noop.rename("a", "b", false), 0);
        }
    }
}
