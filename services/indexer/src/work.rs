//! The indexer as a reader of the change journal (`idx.changes`): changes fdrive's API and OCR
//! made on disk, applied as soon as a writer sends `NOTIFY idx_changes`: before the watcher's
//! debounce, and whether or not the watcher can see the change at all. The indexer keeps its
//! position per root in `idx.change_cursors` and saves it after each applied batch. Rows are
//! hints. What is on disk when one is applied decides what happens, as for the watcher, so a
//! batch applied twice after a restart does no harm, and the periodic scan still covers
//! anything lost. See docs/plans/CHANGE-JOURNAL.md.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use anyhow::Result;
use postgres::fallible_iterator::FallibleIterator;
use rustix::fs::{AtFlags, FileType, statat};
use rustix::io::Errno;

use crate::config::{SKIP_DIRS, SKIP_NAMES};
use crate::db::{self, ChangeRow};
use crate::failures::describe;
use crate::indexer::{
    ContentHint, FileStat, RootContext, folder_chain, record_folders, unchanged_in_db, walk_tree, watch_index_with,
    watch_mark_deleted, watch_rename,
};
use crate::journal::Source;
use crate::log::log;
use crate::rules::{should_index_name, should_walk_dir};
use crate::runner::Handler;
use crate::watcher::WatchHandler;

/// The channel writers notify after appending; the payload is the root's name.
pub const CHANNEL: &str = db::CHANGES_CHANNEL;
/// The indexer's name in `idx.change_cursors`.
pub const CONSUMER: &str = "indexer";
/// Rows read per round trip.
pub const BATCH: i64 = 500;
/// How long to wait for a notification before looking at the journal anyway.
pub const POLL: Duration = Duration::from_secs(30);

/// One journaled change, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// Look at `path` again: a file, a folder, or nothing any more.
    Path { path: String, hint: Option<ContentHint> },
    /// `from` was moved to `to`.
    Moved { from: String, to: String },
}

/// A root-relative path without leading or trailing slashes and without an empty, `.` or
/// `..` part. The API writes these, but nothing read from a table is trusted.
pub fn clean_path(path: &str) -> Option<String> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    crate::fsx::path_parts(&format!("/{trimmed}")).ok()?;
    Some(trimmed.to_owned())
}

/// The change a row describes, or `None` for a malformed one. A hint needs all five of
/// its columns and a well-formed digest, or the file is hashed as usual.
pub fn parse(row: &ChangeRow) -> Option<Change> {
    let path = clean_path(&row.path)?;
    match &row.target_path {
        Some(target) => Some(Change::Moved {
            from: path,
            to: clean_path(target)?,
        }),
        None => {
            let hint = match (&row.sha256, row.size, row.mtime_ns, row.inode, row.ctime_ns) {
                (Some(sha), Some(size), Some(mtime_ns), Some(inode), Some(ctime_ns)) => {
                    ContentHint::new(sha, size, mtime_ns, inode, ctime_ns)
                }
                _ => None,
            };
            Some(Change::Path { path, hint })
        }
    }
}

/// What a root-relative path names on disk, judged the way a scan's walk would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    File(FileStat),
    Dir,
    /// Missing, or nothing a walk indexes: a link, or a skipped folder or name on the way.
    Gone,
    /// Unreadable for another reason, so left for the next scan.
    Unknown,
}

fn walked_dir(name: &str) -> bool {
    should_index_name(name, SKIP_NAMES) && should_walk_dir(name, SKIP_DIRS)
}

fn gone_or_unknown(error: &std::io::Error) -> Entry {
    match Errno::from_io_error(error) {
        Some(Errno::NOENT | Errno::NOTDIR | Errno::LOOP) => Entry::Gone,
        _ => Entry::Unknown,
    }
}

/// `FileStat::of` for a raw stat, whose field types differ between platforms.
#[allow(clippy::unnecessary_cast)]
fn file_stat(stat: &rustix::fs::Stat) -> FileStat {
    FileStat {
        size: stat.st_size as u64,
        mtime_ns: stat.st_mtime as i64 * 1_000_000_000 + stat.st_mtime_nsec as i64,
    }
}

/// Look at `path` below `root` without following a symlink on the way.
pub fn entry(root: &Path, path: &str) -> Entry {
    let Ok(parts) = crate::fsx::path_parts(&format!("/{path}")) else {
        return Entry::Gone;
    };
    let Some((leaf, dirs)) = parts.split_last() else {
        return Entry::Unknown;
    };
    if !dirs.iter().all(|d| walked_dir(d)) || !should_index_name(leaf, SKIP_NAMES) {
        return Entry::Gone;
    }
    let dir = match crate::fsx::open_dir(root, dirs) {
        Ok(dir) => dir,
        Err(e) => return gone_or_unknown(&e),
    };
    match statat(&dir, leaf.as_str(), AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => match FileType::from_raw_mode(stat.st_mode) {
            FileType::RegularFile => Entry::File(file_stat(&stat)),
            FileType::Directory if should_walk_dir(leaf, SKIP_DIRS) => Entry::Dir,
            _ => Entry::Gone,
        },
        Err(e) => gone_or_unknown(&e.into()),
    }
}

type Job = Box<dyn FnOnce() + Send>;

/// Workers for journaled files. Moves and deletes wait for them, so rows change in journal
/// order.
struct Pool {
    sender: crossbeam_channel::Sender<Job>,
    pending: Arc<(Mutex<usize>, Condvar)>,
    threads: usize,
}

impl Pool {
    fn new(name: &str, workers: usize) -> Self {
        let (sender, receiver) = crossbeam_channel::bounded::<Job>(1024);
        let pending = Arc::new((Mutex::new(0_usize), Condvar::new()));
        let threads = (0..workers.max(1))
            .filter_map(|i| {
                let (receiver, pending) = (receiver.clone(), Arc::clone(&pending));
                std::thread::Builder::new()
                    .name(format!("{name}-{i}"))
                    .spawn(move || {
                        for job in receiver {
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                            Self::done(&pending);
                        }
                    })
                    .ok()
            })
            .count();
        Self {
            sender,
            pending,
            threads,
        }
    }

    fn done(pending: &(Mutex<usize>, Condvar)) {
        let mut count = pending.0.lock().unwrap_or_else(PoisonError::into_inner);
        *count -= 1;
        if *count == 0 {
            pending.1.notify_all();
        }
    }

    fn submit(&self, job: Job) {
        *self.pending.0.lock().unwrap_or_else(PoisonError::into_inner) += 1;
        if self.threads == 0 {
            job();
            Self::done(&self.pending);
        } else if let Err(unsent) = self.sender.send(job) {
            (unsent.into_inner())();
            Self::done(&self.pending);
        }
    }

    fn wait_idle(&self) {
        let mut count = self.pending.0.lock().unwrap_or_else(PoisonError::into_inner);
        while *count > 0 {
            count = self.pending.1.wait(count).unwrap_or_else(PoisonError::into_inner);
        }
    }
}

/// Whether the indexer applies a row: not one it wrote itself. Watcher and scan rows describe
/// changes it applied before it wrote them; applying them again would find nothing to do but
/// cost a stat per file and a walk per folder. A source it does not know is applied, which is
/// harmless: what is on disk decides.
pub fn applies(row: &ChangeRow) -> bool {
    !Source::parse(&row.source).is_some_and(Source::is_indexers)
}

/// Applies one root's journaled changes from its saved position.
pub struct Applier {
    ctx: Arc<RootContext>,
    pool: Pool,
}

impl Applier {
    pub fn new(ctx: Arc<RootContext>) -> Self {
        let pool = Pool::new(&format!("work-{}", ctx.name), ctx.settings().workers);
        Self { ctx, pool }
    }

    /// The saved position for this root. On first start it is the journal's end: the startup
    /// scan covers whatever came before.
    pub fn position(&self) -> Result<i64> {
        let ctx = &self.ctx;
        if let Some(position) = ctx.db.with(|c| db::change_cursor(c, CONSUMER, ctx.root_id))? {
            return Ok(position);
        }
        let (_, newest) = ctx.db.with(db::journal_bounds)?;
        self.save(newest)?;
        log(&format!(
            "[{}] journal: starting at position {newest}; the startup scan covers earlier changes",
            ctx.name
        ));
        Ok(newest)
    }

    fn save(&self, position: i64) -> Result<()> {
        let ctx = &self.ctx;
        ctx.db
            .with(|c| db::save_change_cursor(c, CONSUMER, ctx.root_id, position))
    }

    /// Apply the root's rows after its position, oldest first, saving the position after each
    /// batch is done, unless the files folder is not verified. Rows the indexer wrote itself
    /// are passed over. When rows after the position were pruned, a scan is requested and the
    /// position moves to the end. Returns how many of the root's rows were handled.
    pub fn drain(&self) -> Result<usize> {
        let mut handled = 0;
        loop {
            let position = self.position()?;
            let (oldest, newest) = self.ctx.db.with(db::journal_bounds)?;
            if newest <= position {
                return Ok(handled);
            }
            // Rows wait while the folder is not this installation's: applying them there would
            // read the files they name as deleted.
            if !self.ctx.files_folder_verified() {
                return Ok(handled);
            }
            if oldest.is_some_and(|oldest| position < oldest - 1) {
                log(&format!(
                    "[{}] journal: changes after position {position} were pruned before they were read; \
                     scanning instead",
                    self.ctx.name
                ));
                self.ctx.request_scan();
                self.save(newest)?;
                continue;
            }
            let rows = self
                .ctx
                .db
                .with(|c| db::changes_after(c, self.ctx.root_id, position, BATCH))?;
            // Positions up to `newest` are committed in order, so nothing of this root can
            // still arrive below it: the rest belong to other roots.
            let Some(last) = rows.last().map(|row| row.id) else {
                self.save(newest)?;
                return Ok(handled);
            };
            self.ctx.maybe_refresh_features();
            // While indexing is off the rows are passed over: turning it on starts a scan.
            if self.ctx.values().indexer_enabled() {
                for row in rows.iter().filter(|row| applies(row)) {
                    self.apply_row(row);
                }
                self.pool.wait_idle();
            }
            self.save(last)?;
            handled += rows.len();
        }
    }

    fn apply_row(&self, row: &ChangeRow) {
        let Some(change) = parse(row) else {
            log(&format!("[{}] work: ignoring malformed row {}", self.ctx.name, row.id));
            return;
        };
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.apply(&change))).is_err() {
            log(&format!("[{}] work: applying {change:?} crashed", self.ctx.name));
        }
    }

    /// Apply one change. Files go to the workers; everything else waits for them first.
    pub fn apply(&self, change: &Change) {
        match change {
            Change::Path { path, hint } => self.look_again(path, hint.clone()),
            Change::Moved { from, to } => self.moved(from, to),
        }
    }

    fn look_again(&self, path: &str, hint: Option<ContentHint>) {
        match entry(&self.ctx.abs_path, path) {
            Entry::File(_) => {
                // A new file can come with new folders above it, and changes its folder.
                let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
                record_folders(&self.ctx, &folder_chain(&self.ctx.abs_path, parent), None);
                self.index(path.to_owned(), hint);
            }
            Entry::Dir => self.reconcile(path),
            Entry::Gone => {
                self.pool.wait_idle();
                // A file or a folder: rows at the path and below it.
                watch_mark_deleted(&self.ctx, path, true);
            }
            Entry::Unknown => log(&format!(
                "[{}] work: cannot read {path}; leaving it to the next scan",
                self.ctx.name
            )),
        }
    }

    fn moved(&self, from: &str, to: &str) {
        self.pool.wait_idle();
        match entry(&self.ctx.abs_path, to) {
            found @ (Entry::File(_) | Entry::Dir) => {
                // Rows follow the move without re-extracting anything; then the destination
                // is compared with the disk, which also covers a restore from somewhere the
                // index never looked and anything an overwrite left behind.
                watch_rename(&self.ctx, from, to, found == Entry::Dir);
                self.look_again(to, None);
            }
            // Moved where nothing is indexed (or on again): only the source matters.
            Entry::Gone => self.look_again(from, None),
            Entry::Unknown => log(&format!(
                "[{}] work: cannot read {to}; leaving the move from {from} to the next scan",
                self.ctx.name
            )),
        }
    }

    /// Index one file on a worker, as foreground work.
    fn index(&self, path: String, hint: Option<ContentHint>) {
        let ctx = Arc::clone(&self.ctx);
        let foreground = ctx.foreground();
        self.pool.submit(Box::new(move || {
            let _foreground = foreground;
            // What is on disk when a worker gets to it decides, as for the watcher.
            let Entry::File(stat) = entry(&ctx.abs_path, &path) else {
                return;
            };
            let abs = ctx.abs_path.join(&path);
            let finish = Handler(Arc::clone(&ctx)).on_queue(&abs);
            let result = watch_index_with(&ctx, &abs, &path, stat, hint.as_ref());
            finish(&result);
        }));
    }

    /// Compare one folder with its rows, like a scan of just that folder: index what is new
    /// or changed, record the folder, those above it and those in it, and drop the rows of
    /// what is gone once the whole folder was read.
    fn reconcile(&self, path: &str) {
        let ctx = &self.ctx;
        let found = ctx
            .db
            .with(|c| Ok((db::now(c)?, db::subtree_manifest(c, ctx.root_id, path)?)));
        let (started_at, manifest) = match found {
            Ok(found) => found,
            Err(e) => {
                log(&format!(
                    "[{}] work: cannot read rows under {path}: {}",
                    ctx.name,
                    describe(&e)
                ));
                return;
            }
        };
        let mut unseen: HashSet<String> = manifest.keys().cloned().collect();
        let mut complete = true;
        let mut folders = folder_chain(&ctx.abs_path, path);
        walk_tree(
            &ctx.abs_path.join(path),
            || complete = false,
            |mut folder| {
                folder.path = format!("{path}/{}", folder.path);
                folders.push(folder);
            },
            |_, rel, stat| {
                let rel = format!("{path}/{rel}");
                unseen.remove(&rel);
                if !unchanged_in_db(manifest.get(&rel), stat) {
                    self.index(rel, None);
                }
                true
            },
        );
        record_folders(ctx, &folders, complete.then_some((path, started_at)));
        if complete && !unseen.is_empty() {
            let unseen: Vec<String> = unseen.into_iter().collect();
            match ctx
                .db
                .with(|c| db::sweep_vanished_paths(c, ctx.root_id, &unseen, started_at))
            {
                Ok(swept) => {
                    for gone in &swept {
                        ctx.names_touched(gone, false);
                    }
                }
                Err(e) => log(&format!(
                    "[{}] work: sweep under {path} failed: {}",
                    ctx.name,
                    describe(&e)
                )),
            }
        }
    }
}

/// One root's journal: apply what is there, then wait for a writer's next notification.
pub struct WorkLoop {
    applier: Applier,
    listener: Option<postgres::Client>,
    listening_failed: bool,
}

impl WorkLoop {
    pub fn new(ctx: Arc<RootContext>) -> Self {
        Self {
            applier: Applier::new(ctx),
            listener: None,
            listening_failed: false,
        }
    }

    pub fn is_listening(&self) -> bool {
        self.listener.is_some()
    }

    fn listen(&mut self) {
        let ctx = &self.applier.ctx;
        let listener = db::connect(&ctx.cfg.database_url, 1, std::thread::sleep)
            .and_then(|mut client| Ok(client.batch_execute(&format!("LISTEN {CHANNEL}")).map(|()| client)?));
        match listener {
            Ok(client) => {
                self.listener = Some(client);
                self.listening_failed = false;
            }
            Err(e) if !self.listening_failed => {
                self.listening_failed = true;
                log(&format!(
                    "[{}] work: cannot listen for journaled changes ({}); looking every {}s instead",
                    ctx.name,
                    describe(&e),
                    POLL.as_secs()
                ));
            }
            Err(_) => {}
        }
    }

    /// Apply the journal, then wait up to `timeout` for a notification. Listening starts
    /// before the journal is read, so a row added meanwhile still ends the wait.
    pub fn step(&mut self, timeout: Duration) -> usize {
        if self.listener.is_none() {
            self.listen();
        }
        let handled = self.applier.drain().unwrap_or_else(|e| {
            log(&format!(
                "[{}] work: journal unavailable: {}",
                self.applier.ctx.name,
                describe(&e)
            ));
            0
        });
        let waited = match self.listener.as_mut() {
            Some(client) => Self::wait(client, timeout),
            None => {
                std::thread::sleep(timeout);
                Ok(())
            }
        };
        if let Err(e) = waited {
            log(&format!(
                "[{}] work: lost the notification connection: {e}",
                self.applier.ctx.name
            ));
            self.listener = None;
        }
        handled
    }

    /// Wait for a notification; one look at the journal answers every one already delivered.
    fn wait(client: &mut postgres::Client, timeout: Duration) -> Result<(), postgres::Error> {
        let mut notifications = client.notifications();
        notifications.timeout_iter(timeout).next()?;
        let mut delivered = notifications.iter();
        while delivered.next()?.is_some() {}
        Ok(())
    }
}

/// One root's journal loop; never returns.
pub fn run_work(ctx: Arc<RootContext>) {
    let mut work = WorkLoop::new(ctx);
    loop {
        work.step(POLL);
    }
}
