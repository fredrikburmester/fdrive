//! Orchestration: walk a root, hash and extract changed files, chunk and embed text,
//! build thumbnails and image embeddings, and reconcile what the watcher could not see.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, RwLock};
use std::thread::LocalKey;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use chrono::{DateTime, Utc};

use crate::activity::{Op, RootActivity};
use crate::backoff::{Backoff, is_outage};
use crate::chunking::{chunk, is_document, is_image, is_pdf, is_textual, max_chunks_for};
use crate::config::{Config, SKIP_DIRS, SKIP_NAMES};
use crate::db::{self, Db, FileRow, ManifestRow, NewChange, NewFile, Stamp, StampUpdate};
use crate::events::{EventKind, build};
use crate::extract::{Extractor, embed_passages};
use crate::failures::{self, FileResult, Report, attempt, describe, report};
use crate::features::{FeatureConfiguration, FeatureValues};
use crate::image_embed::{self, Health};
use crate::journal::{self, Source};
use crate::log::log;
use crate::paths::{basename, ext_of};
use crate::promise::{Outcome, Promise};
use crate::rules::{Globs, should_index_name, should_walk_dir};
use crate::settings::{self, Settings};
use crate::thumbs::{SIZES, kind_for_ext, skip_reason, storage_path};
use crate::thumbs_io;
pub use crate::walk::{walk, walk_tree};

/// Classified files a scan holds before traversal waits for workers.
pub const SCAN_BACKLOG_LIMIT: usize = 20_000;

/// What the indexer needs to know about a file on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ns: i64,
}

impl FileStat {
    pub fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            mtime_ns: metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
        }
    }
}

/// How long after a file last changed a read of it may stamp its row (`db::Stamp`). A write
/// within the same tick of the filesystem's clock as the change before it leaves the change
/// time as it was, so a read that began within that tick may have missed one; a read that
/// began later cannot, since any write after it moves the change time on. One second covers
/// filesystems that keep whole seconds, and stays under the watcher's two-second debounce,
/// so a change the watcher reports is stamped when it is indexed.
pub const STAMP_SETTLE: Duration = Duration::from_secs(1);

impl Stamp {
    pub fn of(metadata: &std::fs::Metadata) -> Self {
        Self {
            inode: metadata.ino() as i64,
            ctime_ns: metadata.ctime() * 1_000_000_000 + metadata.ctime_nsec(),
        }
    }
}

/// Whether a file whose change time is `ctime_ns` had settled `settle` before `at`.
pub fn settled(ctime_ns: i64, at: SystemTime, settle: Duration) -> bool {
    let at_ns = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as i64;
    ctime_ns <= at_ns - settle.as_nanos() as i64
}

/// The stamp a read of a file earns: the file had settled when the read began (`before`
/// was taken after `started`), it is still that inode with that change time afterwards, and
/// it is the version the row records (`stat`). `None` otherwise.
pub fn earned_stamp(
    stat: FileStat,
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    started: SystemTime,
    settle: Duration,
) -> Option<Stamp> {
    let stamp = Stamp::of(before);
    let unchanged = FileStat::of(before) == stat && FileStat::of(after) == stat && Stamp::of(after) == stamp;
    (unchanged && settled(stamp.ctime_ns, started, settle)).then_some(stamp)
}

/// Hash an open file from where it is, and the stamp the read earns (`earned_stamp`).
pub fn read_digest(file: &mut std::fs::File, stat: FileStat, settle: Duration) -> Result<(String, Option<Stamp>)> {
    let started = SystemTime::now();
    let before = file.metadata()?;
    let sha = crate::fsx::sha256_of_file(file)?;
    let after = file.metadata()?;
    let stamp = earned_stamp(stat, &before, &after, started, settle);
    Ok((sha, stamp))
}

/// What fdrive's API knew about an upload when it published it: the bytes' digest and the
/// file they became. The file need not be read again to hash it while it is still that file.
/// A client chooses an upload's modification time, so a hint also names the inode and its
/// change time, which no client can set: another file with the same size and time never
/// passes for it, and its digest never keys thumbnails or embeddings made from other bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentHint {
    pub sha256: String,
    pub size: u64,
    pub mtime_ns: i64,
    pub inode: u64,
    pub ctime_ns: i64,
}

impl ContentHint {
    /// A hint with a well-formed digest (64 lowercase hex digits), or none: thumbnails are
    /// stored under the digest, so anything else must never be used as one. `inode` is the
    /// unsigned inode number's 64 bits, as stored.
    pub fn new(sha256: &str, size: i64, mtime_ns: i64, inode: i64, ctime_ns: i64) -> Option<Self> {
        let well_formed =
            sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        (well_formed && size >= 0).then(|| Self {
            sha256: sha256.to_owned(),
            size: size as u64,
            mtime_ns,
            inode: inode as u64,
            ctime_ns,
        })
    }

    /// The digest, when the opened file is still the one the hint describes.
    fn digest_for(&self, file: &std::fs::File) -> Option<String> {
        let metadata = file.metadata().ok()?;
        let same = FileStat::of(&metadata)
            == FileStat {
                size: self.size,
                mtime_ns: self.mtime_ns,
            }
            && metadata.ino() == self.inode
            && metadata.ctime() * 1_000_000_000 + metadata.ctime_nsec() == self.ctime_ns;
        same.then(|| self.sha256.clone())
    }
}

/// Counts foreground work (watcher changes and the change journal) while it is pending, so
/// scan workers wait for it; dropping the guard ends it.
pub struct Foreground(Arc<AtomicUsize>);

impl Drop for Foreground {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The longest a scan worker waits for foreground work before taking one more file anyway.
pub const FOREGROUND_WAIT_LIMIT: Duration = Duration::from_secs(60);

struct FeatureState {
    configuration: FeatureConfiguration,
    backfill_media: bool,
    last_refresh: Option<Instant>,
}

/// Everything one root needs to walk, index and watch itself.
pub struct RootContext {
    pub name: String,
    pub root_id: i64,
    pub abs_path: PathBuf,
    pub cfg: Arc<Config>,
    pub db: Db,
    settings: RwLock<Settings>,
    extractor: RwLock<Arc<Extractor>>,
    features: Mutex<FeatureState>,
    /// Re-read `features.configuration` from the database at most this often.
    pub refresh_features: Option<Duration>,
    pub path_locks: crate::locks::PathLocks,
    pub embed_backoff: Backoff,
    pub image_embed_backoff: Backoff,
    pub image_health_ttl: Duration,
    image_health: Mutex<Option<(Instant, Health)>>,
    watch_stage: Mutex<Option<Arc<ImageStage>>>,
    text_stage: Mutex<Option<Arc<Stage>>>,
    foreground: Arc<AtomicUsize>,
    pub activity: RootActivity,
    /// The last verdict on the root's `.fdrive-files` marker and when it was reached.
    files_folder: Mutex<Option<(Instant, Result<(), &'static str>)>>,
    /// How long that verdict is reused before the marker is read again.
    pub files_folder_recheck: Duration,
    /// How long after a file last changed a read of it may stamp its row: `STAMP_SETTLE`.
    pub stamp_settle: Duration,
    /// Set when the root needs a scan before its next one is due: the journal's reader
    /// found rows it never read were pruned.
    scan_requested: AtomicBool,
    /// The name index every name row this root writes is reported to; unset where nothing
    /// searches names, as in most tests.
    pub names: OnceLock<Arc<crate::names::NameIndex>>,
}

/// How long a verdict on the files folder's marker is reused by default.
pub const FILES_FOLDER_RECHECK: Duration = Duration::from_secs(2);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn build_extractor(name: &str, cfg: &Config, settings: &Settings) -> Extractor {
    Extractor {
        root: name.to_owned(),
        text_max_bytes: cfg.text_max_bytes,
        image_max_bytes: cfg.image_max_bytes,
        max_pdf_pages: cfg.max_pdf_pages,
        plain_text_cap: cfg.plain_text_cap,
        tesseract_langs: settings.tesseract_langs.clone(),
        ocr_image_globs: Globs::new(&settings.ocr_image_globs),
        tika_url: cfg.tika_url.clone(),
    }
}

impl RootContext {
    pub fn new(name: &str, root_id: i64, abs_path: PathBuf, cfg: Arc<Config>, features: FeatureConfiguration) -> Self {
        let settings = cfg.default_settings();
        Self {
            name: name.to_owned(),
            root_id,
            abs_path,
            db: Db::new(&cfg.database_url),
            extractor: RwLock::new(Arc::new(build_extractor(name, &cfg, &settings))),
            settings: RwLock::new(settings),
            features: Mutex::new(FeatureState {
                configuration: features,
                backfill_media: false,
                last_refresh: None,
            }),
            refresh_features: None,
            path_locks: crate::locks::PathLocks::default(),
            embed_backoff: Backoff::default(),
            image_embed_backoff: Backoff::default(),
            image_health_ttl: Duration::from_secs(30),
            image_health: Mutex::new(None),
            watch_stage: Mutex::new(None),
            text_stage: Mutex::new(None),
            foreground: Arc::new(AtomicUsize::new(0)),
            activity: RootActivity::default(),
            files_folder: Mutex::new(None),
            files_folder_recheck: FILES_FOLDER_RECHECK,
            stamp_settle: STAMP_SETTLE,
            scan_requested: AtomicBool::new(false),
            names: OnceLock::new(),
            cfg,
        }
    }

    /// Whether the root holds this installation's `.fdrive-files` marker, checked again once
    /// the last verdict is `files_folder_recheck` old. Nothing that deletes or moves rows runs
    /// while it does not: scans, the watcher and queued changes wait. A change of verdict is
    /// logged once; a database error keeps the last verdict.
    pub fn files_folder_verified(&self) -> bool {
        let mut last = lock(&self.files_folder);
        if let Some((at, verdict)) = *last
            && at.elapsed() < self.files_folder_recheck
        {
            return verdict.is_ok();
        }
        let verdict = match self.db.with(db::installation_id) {
            Ok(id) => crate::files_marker::check(&self.abs_path, id.as_deref()),
            Err(e) => match *last {
                Some((_, previous)) => previous,
                None => {
                    log(&format!("[{}] files folder unchecked: {}", self.name, describe(&e)));
                    Err(crate::files_marker::NO_INSTALLATION)
                }
            },
        };
        if last.map(|(_, previous)| previous) != Some(verdict) {
            match verdict {
                Ok(()) => log(&format!("[{}] files folder verified", self.name)),
                Err(reason) => log(&format!(
                    "[{}] FILES FOLDER REFUSED: {reason}. Nothing is scanned, watched or deleted from the index until it is fixed.",
                    self.name
                )),
            }
        }
        *last = Some((Instant::now(), verdict));
        verdict.is_ok()
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    pub fn extractor(&self) -> Arc<Extractor> {
        Arc::clone(&self.extractor.read().unwrap_or_else(PoisonError::into_inner))
    }

    /// Apply new settings; returns the names of the fields that changed.
    pub fn set_settings(&self, new: Settings) -> Vec<&'static str> {
        let changed = settings::diff_changed(&self.settings(), &new);
        if !changed.is_empty() {
            *self.extractor.write().unwrap_or_else(PoisonError::into_inner) =
                Arc::new(build_extractor(&self.name, &self.cfg, &new));
        }
        *self.settings.write().unwrap_or_else(PoisonError::into_inner) = new;
        changed
    }

    pub fn features(&self) -> FeatureConfiguration {
        lock(&self.features).configuration
    }

    pub fn values(&self) -> FeatureValues {
        self.features().values
    }

    /// Store a new feature selection; returns whether any value changed. Turning thumbnails
    /// or image search on starts a media backfill of unchanged files.
    pub fn set_features(&self, value: FeatureConfiguration) -> bool {
        let mut state = lock(&self.features);
        let old = state.configuration.values;
        state.configuration = value;
        if !value.values.indexer_enabled() {
            self.activity.stop_queued();
        }
        let enabled_media = value.values.internal_thumbnails() && !old.internal_thumbnails();
        let enabled_image = value.values.image_search && !old.image_search;
        state.backfill_media = state.backfill_media || enabled_media || enabled_image;
        old != value.values
    }

    pub fn needs_media_backfill(&self) -> bool {
        lock(&self.features).backfill_media
    }

    pub fn finish_media_backfill(&self) {
        lock(&self.features).backfill_media = false;
    }

    pub fn maybe_refresh_features(&self) {
        let Some(every) = self.refresh_features else { return };
        {
            let mut state = lock(&self.features);
            if state.last_refresh.is_some_and(|at| at.elapsed() < every) {
                return;
            }
            state.last_refresh = Some(Instant::now());
        }
        if let Ok(raw) = self.db.with(db::read_settings) {
            self.set_features(crate::features::resolve(&raw));
        }
    }

    /// The image unit's health, probed at most every `image_health_ttl`. Once it answered
    /// healthy, an unanswered probe keeps that answer: a busy unit can miss the probe's
    /// timeout, and a real outage fails the embedding request itself. An explicit problem
    /// is believed.
    pub fn image_embed_status(&self) -> Option<Health> {
        let cached = lock(&self.image_health).clone();
        if let Some((at, health)) = &cached
            && at.elapsed() < self.image_health_ttl
        {
            return Some(health.clone());
        }
        let health = image_embed::health(&self.cfg.image_embed_url, Duration::from_secs(5))
            .or_else(|| cached.map(|(_, health)| health));
        *lock(&self.image_health) = health
            .clone()
            .filter(|h| image_embed::dimension_guard(Some(h)).is_none())
            .map(|h| (Instant::now(), h));
        health
    }

    /// The thread embedding images for watcher changes, started on first use.
    pub fn watch_image_stage(self: &Arc<Self>) -> Arc<ImageStage> {
        let mut stage = lock(&self.watch_stage);
        Arc::clone(
            stage.get_or_insert_with(|| {
                ImageStage::start(Arc::clone(self), &format!("image-embed-watch-{}", self.name))
            }),
        )
    }

    /// The thread embedding text for watcher and queued changes, started on first use.
    pub fn watch_text_stage(self: &Arc<Self>) -> Arc<Stage> {
        let mut stage = lock(&self.text_stage);
        Arc::clone(stage.get_or_insert_with(|| Stage::text(Arc::clone(self), &format!("text-embed-{}", self.name))))
    }

    /// Mark foreground work as pending until the returned guard drops.
    pub fn foreground(&self) -> Foreground {
        self.foreground.fetch_add(1, Ordering::SeqCst);
        Foreground(Arc::clone(&self.foreground))
    }

    pub fn foreground_pending(&self) -> usize {
        self.foreground.load(Ordering::SeqCst)
    }

    /// Hold a scan worker back while foreground work is pending, up to `limit`, so a
    /// change someone just made is not queued behind a library-wide scan.
    pub fn yield_to_foreground(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        while self.foreground_pending() > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn report(&self, path: &str, feature: &str, result: Report<'_>) {
        report(&self.db, self.root_id, path, feature, result);
    }

    /// Ask the root's loop for a scan at its next step.
    pub fn request_scan(&self) {
        self.scan_requested.store(true, Ordering::SeqCst);
    }

    /// Whether a scan was requested since the last call.
    pub fn take_scan_request(&self) -> bool {
        self.scan_requested.swap(false, Ordering::SeqCst)
    }

    /// Tell the name index this root's rows at `path` changed (with `subtree`, also those below it).
    pub fn names_touched(&self, path: &str, subtree: bool) {
        if let Some(names) = self.names.get() {
            names.touch(self.root_id, path, subtree);
        }
    }

    /// Tell the name index to read every row of this root again.
    pub fn names_rebuild(&self) {
        if let Some(names) = self.names.get() {
            names.rebuild(self.root_id);
        }
    }
}

/// The DB row matches what is on disk and needs no work.
pub fn unchanged_in_db(row: Option<&ManifestRow>, stat: FileStat) -> bool {
    row.is_some_and(|r| {
        r.size == stat.size as i64 && r.mtime_ns == stat.mtime_ns && r.status != "pending" && !r.deleted
    })
}

/// Whether a feature transition makes an unchanged row actionable. Each status must stop
/// matching once its retry ran, or every scan repeats it: `no_text` is never retried.
pub fn should_retry_unchanged(status: &str, features: &FeatureValues) -> bool {
    if status == "excluded:image_dir" {
        return features.text_search && features.search_ocr;
    }
    if status == "disabled:text" || status.starts_with("excluded") {
        return features.text_search;
    }
    if status == "disabled:search_ocr" {
        return features.text_search && features.search_ocr;
    }
    status == "partial" && features.semantic_search
}

pub fn exclusion_still_applies(ctx: &RootContext, rel_path: &str, size: u64) -> bool {
    let settings = ctx.settings();
    if Globs::new(&settings.text_exclude_globs).matches(&ctx.name, rel_path) {
        return true;
    }
    let ext = ext_of(basename(rel_path));
    if is_image(&ext) {
        return !Globs::new(&settings.ocr_image_globs).matches(&ctx.name, rel_path) || size > ctx.cfg.image_max_bytes;
    }
    (is_pdf(&ext) || is_document(&ext)) && size > ctx.cfg.text_max_bytes
}

/// The features a file's processing reports on, in a fixed order.
pub fn work_features(features: &FeatureValues, ext: Option<&str>, embed_only: bool, media_only: bool) -> Vec<String> {
    let mut result = Vec::new();
    if features.text_search && !embed_only && !media_only {
        result.push("textSearch".to_owned());
    }
    if features.semantic_search && !media_only && ext.is_none_or(is_textual) {
        result.push("semanticSearch".to_owned());
    }
    if features.thumbnails && (!embed_only || media_only) && ext.is_none_or(|e| kind_for_ext(e).is_some()) {
        result.push("thumbnails".to_owned());
    }
    if features.image_search && (!embed_only || media_only) && ext.is_none_or(image_embed::is_candidate) {
        result.push("imageSearch".to_owned());
    }
    result
}

pub fn emit_event(ctx: &RootContext, kind: EventKind, rel_path: &str, target: Option<&str>) {
    let event = build(kind, &ctx.name, rel_path, target);
    if let Err(error) = ctx.db.with(|c| db::record_event(c, ctx.root_id, &event)) {
        log(&format!(
            "event: failed to record {} for {rel_path}: {}",
            kind.as_str(),
            describe(&error)
        ));
    }
}

/// Index one file. False when this exact version is already indexed: a scan and the
/// watcher raced, and the second one sees the first one's row.
pub fn process_file(ctx: &Arc<RootContext>, abs_path: &Path, rel_path: &str, stat: FileStat) -> Result<bool> {
    process_file_with(ctx, abs_path, rel_path, stat, None)
}

/// `process_file` for a file the API described: `hint` spares hashing it again. The file
/// is reopened from the root rather than through `_abs_path`.
pub fn process_file_with(
    ctx: &Arc<RootContext>,
    _abs_path: &Path,
    rel_path: &str,
    stat: FileStat,
    hint: Option<&ContentHint>,
) -> Result<bool> {
    let _guard = ctx.path_locks.get(rel_path);
    ctx.maybe_refresh_features();
    if !ctx.values().indexer_enabled() {
        return Ok(false);
    }
    let row = ctx.db.with(|c| db::file_row(c, ctx.root_id, rel_path))?;
    let manifest = row.as_ref().map(|r| ManifestRow {
        size: r.size,
        mtime_ns: r.mtime_ns,
        status: r.status.clone(),
        deleted: r.deleted,
        sha256: r.sha256.clone(),
        image_embedded: false,
        thumbnail_failed: false,
    });
    let status = match &row {
        Some(r) if r.error.as_deref() == Some("excluded:image_dir") => "excluded:image_dir".to_owned(),
        Some(r) => r.status.clone(),
        None => String::new(),
    };
    let unchanged = unchanged_in_db(manifest.as_ref(), stat);
    if let Some(row) = row.as_ref().filter(|_| unchanged) {
        let excluded = status.starts_with("excluded") && exclusion_still_applies(ctx, rel_path, stat.size);
        if excluded || !should_retry_unchanged(&status, &ctx.values()) {
            return restamp(ctx, rel_path, stat, row);
        }
    }
    let was_new = row.is_none();
    let same_version = row
        .as_ref()
        .is_some_and(|r| r.size == stat.size as i64 && r.mtime_ns == stat.mtime_ns && !r.deleted);
    // A feature transition may re-extract an unchanged file; its digest is still valid.
    let known = if unchanged {
        row.and_then(|r| r.sha256).map(|sha| (sha, StampUpdate::Keep))
    } else {
        None
    };
    // Listeners hear about the file once it has a row and a preview, not after its text:
    // they check access and refresh listings for every event, and need nothing more.
    // Re-deriving the same version changes nothing they show, and is no change to journal.
    let visible = || {
        if !same_version {
            emit_event(
                ctx,
                if was_new {
                    EventKind::Created
                } else {
                    EventKind::Changed
                },
                rel_path,
                None,
            );
            journal::record(ctx, vec![NewChange::path(rel_path)]);
        }
    };
    process_stages(ctx, rel_path, stat, known, hint, None, visible)?;
    Ok(true)
}

/// An unchanged row whose stamp does not describe its file (any more, or ever): read the
/// file again once it has settled. The same digest earns the row the read's stamp; another
/// one means the bytes changed under the same size and modification time, and the file is
/// indexed again. True when it was.
fn restamp(ctx: &Arc<RootContext>, rel_path: &str, stat: FileStat, row: &FileRow) -> Result<bool> {
    let Some(known) = row.sha256.as_deref() else {
        return Ok(false);
    };
    // Best effort: a file that cannot be read now keeps its row as it is, as before.
    let Ok(Some((sha, stamp))) = reread(ctx, rel_path, stat, row) else {
        return Ok(false);
    };
    if sha == known {
        if let Some(stamp) = stamp {
            ctx.db
                .with(|c| db::set_stamp(c, ctx.root_id, rel_path, &sha, stat.size as i64, stat.mtime_ns, stamp))?;
        }
        return Ok(false);
    }
    let changed = || {
        emit_event(ctx, EventKind::Changed, rel_path, None);
        journal::record(ctx, vec![NewChange::path(rel_path)]);
    };
    process_stages(
        ctx,
        rel_path,
        stat,
        Some((sha, StampUpdate::Set(stamp))),
        None,
        None,
        changed,
    )?;
    Ok(true)
}

/// An unchanged file's digest and the stamp the read earns, unless its row's stamp already
/// proves it or it has not settled yet (the next look tries again): `None` then.
fn reread(ctx: &RootContext, rel_path: &str, stat: FileStat, row: &FileRow) -> Result<Option<(String, Option<Stamp>)>> {
    let mut source = open_source(ctx, rel_path)?;
    let now = Stamp::of(&source.file.metadata()?);
    if row.stamp == Some(now) || !settled(now.ctime_ns, SystemTime::now(), ctx.stamp_settle) {
        return Ok(None);
    }
    read_digest(&mut source.file, stat, ctx.stamp_settle).map(Some)
}

fn note_embed_outage(ctx: &RootContext, error: &anyhow::Error) {
    if ctx.embed_backoff.note_failure() {
        log(&format!(
            "[{}] embed backend unreachable ({}); pausing embeddings. Affected files stay text-searchable and their \
             vectors are backfilled on a later scan.",
            ctx.name,
            describe(error)
        ));
    }
}

fn note_embed_recovery(ctx: &RootContext) {
    if ctx.embed_backoff.note_success() {
        log(&format!(
            "[{}] embed backend reachable again; resuming embeddings",
            ctx.name
        ));
    }
}

/// Open `rel_path` below the root descriptor by descriptor, never following a symlink, so
/// a directory swapped for a link after the walk cannot redirect the read elsewhere. Keep the
/// result alive while anything uses its `path()`: that path names the open descriptor.
pub fn open_source(ctx: &RootContext, rel_path: &str) -> Result<crate::fsx::OpenedFile> {
    let parts =
        crate::fsx::path_parts(&format!("/{}", rel_path.trim_start_matches('/'))).map_err(anyhow::Error::msg)?;
    Ok(crate::fsx::open_file(&ctx.abs_path, &parts)?)
}

/// Hash, store, preview, extract, chunk and embed one file. The file is reopened from the
/// root rather than through `_abs_path`. `only_feature = Some("textSearch")` re-reads text
/// without media or embeddings.
pub fn process_inner(
    ctx: &Arc<RootContext>,
    _abs_path: &Path,
    rel_path: &str,
    stat: FileStat,
    known_sha: Option<String>,
    only_feature: Option<&str>,
) -> Result<()> {
    let known = known_sha.map(|sha| (sha, StampUpdate::Keep));
    process_stages(ctx, rel_path, stat, known, None, only_feature, || {})
}

/// One file in the order a person notices it: its row (a name search finds it), its
/// thumbnails, then `visible`, then its text and last its embeddings. With a text stage on
/// this thread (watcher and queued changes), the embeddings go to that stage: the chunks are
/// searchable by text at once and the worker moves on instead of waiting for the model.
/// The file is reopened from the root by descriptor; `known` is a digest already in hand
/// and what it does to the row's stamp, and `hint` stands in for hashing it while the
/// opened file still matches it. Only the indexer's own read earns a stamp.
pub fn process_stages(
    ctx: &Arc<RootContext>,
    rel_path: &str,
    stat: FileStat,
    known: Option<(String, StampUpdate)>,
    hint: Option<&ContentHint>,
    only_feature: Option<&str>,
    visible: impl FnOnce(),
) -> Result<()> {
    let name = basename(rel_path);
    let ext = ext_of(name);
    let mime = guess_mime(name);
    let mut source = open_source(ctx, rel_path)?;
    let (sha, stamp) = match known.or_else(|| {
        hint.and_then(|h| h.digest_for(&source.file))
            .map(|sha| (sha, StampUpdate::Set(None)))
    }) {
        Some(known) => known,
        None => {
            let (sha, stamp) = read_digest(&mut source.file, stat, ctx.stamp_settle)?;
            (sha, StampUpdate::Set(stamp))
        }
    };
    let source_path = source.path();
    let abs_path = source_path.as_path();
    let file_id = ctx.db.with(|c| {
        db::upsert_file_stamped(
            c,
            &NewFile {
                root_id: ctx.root_id,
                path: rel_path,
                name,
                ext: &ext,
                size: stat.size as i64,
                mtime_ns: stat.mtime_ns,
                sha256: &sha,
                mime: mime.as_deref(),
            },
            stamp,
        )
    })?;
    ctx.names_touched(rel_path, false);

    let mut features = ctx.values();
    if only_feature == Some("textSearch") {
        features.semantic_search = false;
        features.thumbnails = false;
        features.image_search = false;
    }
    if features.internal_thumbnails() {
        process_thumbnails(ctx, abs_path, rel_path, &ext, &sha, stat.size, false);
    }
    if features.image_search
        && image_embed::is_candidate(&ext)
        && skip_reason(stat.size, ctx.cfg.thumb_max_bytes).is_none()
    {
        process_image_embedding(ctx, rel_path, &sha);
    }
    visible();

    let settings = ctx.settings();
    let mut awaits_ocr = false;
    let (text, mut status) = if !features.text_search {
        (None, "disabled:text".to_owned())
    } else if is_image(&ext) && !features.search_ocr {
        (None, "disabled:search_ocr".to_owned())
    } else if !is_textual(&ext) {
        (None, "none".to_owned())
    } else if Globs::new(&settings.text_exclude_globs).matches(&ctx.name, rel_path) {
        (None, "excluded:prefix".to_owned())
    } else {
        let (text, status) = ctx
            .extractor()
            .extract(abs_path, rel_path, &ext, stat.size, features.search_ocr);
        if status == "no_text" && is_pdf(&ext) && !features.search_ocr {
            // A PDF without a text layer is only text-less once OCR has read it.
            awaits_ocr = true;
            (text, "disabled:search_ocr".to_owned())
        } else {
            (text, status)
        }
    };

    let mut chars = 0;
    let mut error: Option<String> = None;
    let mut semantic_error: Option<String> = None;
    let mut semantic_waiting = false;
    let mut staged: Option<Arc<Stage>> = None;
    if let (Some(text), "indexed") = (&text, status.as_str()) {
        chars = text.chars().count() as i64;
        let pieces = chunk(
            text,
            ctx.cfg.chunk_chars,
            ctx.cfg.chunk_overlap,
            max_chunks_for(&ext, ctx.cfg.max_chunks_per_file),
        );
        let empty = || vec![None; pieces.len()];
        let vectors = if features.semantic_search && ctx.embed_backoff.paused() {
            // The backend is known to be down; do not probe it per file.
            error = Some("embed:unavailable".to_owned());
            status = "partial".to_owned();
            semantic_waiting = true;
            empty()
        } else if let Some(stage) = current_text_stage().filter(|_| features.semantic_search) {
            // Searchable by text now; the stage fills the vectors and marks the row indexed.
            staged = Some(stage);
            status = "partial".to_owned();
            empty()
        } else if features.semantic_search {
            match embed_passages(&pieces, &ctx.cfg.embed_url, ctx.cfg.embed_batch) {
                Ok(vectors) => {
                    note_embed_recovery(ctx);
                    vectors.into_iter().map(Some).collect()
                }
                Err(e) => {
                    if is_outage(&e) {
                        note_embed_outage(ctx, &e);
                        semantic_waiting = true;
                    } else {
                        log(&format!("embed failed for {rel_path}: {}", describe(&e)));
                    }
                    semantic_error = Some(describe(&e));
                    error = Some(format!("embed:{}", error_kind(&e)));
                    status = "partial".to_owned();
                    empty()
                }
            }
        } else {
            // Keep the chunks but leave vectors empty so enabling semantic search backfills them.
            status = "partial".to_owned();
            empty()
        };
        ctx.db.with(|c| db::insert_chunks(c, file_id, &pieces, &vectors))?;
    } else if let Some(reason) = status.strip_prefix("error:") {
        error = Some(reason.to_owned());
        status = "error".to_owned();
    } else if status.starts_with("excluded:") {
        error = Some(status.clone());
        status = "excluded".to_owned();
    }
    ctx.db
        .with(|c| db::update_file_status(c, file_id, &status, chars, error.as_deref()))?;

    if features.text_search {
        // A PDF that awaits OCR was still read, which settles an earlier text failure.
        let skipped = status == "excluded" || status == "none" || status.starts_with("disabled:");
        let text_error = if status == "error" { error.as_deref() } else { None };
        ctx.report(
            rel_path,
            "textSearch",
            Report {
                error: text_error,
                skipped,
                resolves: awaits_ocr,
            },
        );
    }
    match staged {
        Some(stage) => submit_text(ctx, &stage, rel_path, &sha),
        None if features.semantic_search => {
            let failure = if status == "partial" && error.as_deref() != Some("embed:unavailable") {
                semantic_error.as_deref()
            } else {
                None
            };
            ctx.report(
                rel_path,
                "semanticSearch",
                Report {
                    error: failure,
                    skipped: semantic_waiting || text.is_none(),
                    resolves: false,
                },
            );
        }
        None => {}
    }
    Ok(())
}

/// Hand a file's stored chunks to the text stage, or embed them here when its queue is
/// full: waiting for room while holding the file's lock could wait on the stage itself.
fn submit_text(ctx: &RootContext, stage: &Stage, rel_path: &str, sha: &str) {
    let operation = failures::current_operation_id("semanticSearch").unwrap_or_default();
    match stage.try_submit(rel_path, sha, &operation) {
        Some(promise) => failures::defer("semanticSearch", promise),
        None => {
            if let Err(e) = embed_chunks(ctx, rel_path, Some(sha)) {
                log(&format!("embed failed for {rel_path}: {}", describe(&e)));
            }
        }
    }
}

/// A short name for an error, like the exception type the Python indexer recorded.
pub fn error_kind(error: &anyhow::Error) -> String {
    if let Some(e) = error.downcast_ref::<reqwest::Error>() {
        return if e.is_connect() {
            "ConnectError".to_owned()
        } else if e.is_timeout() {
            "ReadTimeout".to_owned()
        } else if e.is_status() {
            "HTTPStatusError".to_owned()
        } else {
            "HTTPError".to_owned()
        };
    }
    let text = error.to_string();
    match text.split_once(':') {
        Some((kind, _)) if !kind.is_empty() && !kind.contains(' ') => kind.to_owned(),
        _ => "Error".to_owned(),
    }
}

pub fn guess_mime(name: &str) -> Option<String> {
    match ext_of(name).as_str() {
        ".pages" => Some("application/vnd.apple.pages".to_owned()),
        ".numbers" => Some("application/vnd.apple.numbers".to_owned()),
        ".key" => Some("application/vnd.apple.keynote".to_owned()),
        _ => mime_guess::from_path(name).first_raw().map(str::to_owned),
    }
}

/// Build both thumbnail sizes. Returns `(ok, skipped)`.
pub fn process_thumbnails(
    ctx: &RootContext,
    abs_path: &Path,
    rel_path: &str,
    ext: &str,
    sha: &str,
    size: u64,
    force: bool,
) -> Outcome {
    let reason = skip_reason(size, ctx.cfg.thumb_max_bytes);
    if kind_for_ext(ext).is_none() || reason.is_some() {
        if let Some(reason) = reason {
            log(&format!("thumb: skip {rel_path}: {reason}"));
        }
        ctx.report(rel_path, "thumbnails", failures::skipped());
        return (true, true);
    }
    let generation = thumbs_io::generate(
        abs_path,
        ext,
        sha,
        size,
        &ctx.cfg.thumbs_dir,
        ctx.cfg.thumb_max_bytes,
        force,
        &log,
    );
    if generation.skipped.is_some() {
        ctx.report(rel_path, "thumbnails", failures::resolving_skip());
        return (true, true);
    }
    let mut error = generation.error;
    for thumb in &generation.thumbs {
        let saved = ctx
            .db
            .with(|c| db::upsert_thumbnail(c, sha, thumb.size, &thumb.rel_path, thumb.width, thumb.height));
        if let Err(e) = saved {
            log(&format!("thumb: unexpected failure for {rel_path}: {}", describe(&e)));
            error.get_or_insert_with(|| describe(&e));
        }
    }
    let sizes: HashSet<u32> = generation.thumbs.iter().map(|t| t.size).collect();
    if sizes != SIZES.into_iter().collect() && error.is_none() {
        error = Some(format!(
            "Incomplete thumbnail: {}/{} sizes available",
            generation.thumbs.len(),
            SIZES.len()
        ));
    }
    ctx.report(
        rel_path,
        "thumbnails",
        Report {
            error: error.as_deref(),
            ..Report::default()
        },
    );
    (error.is_none(), false)
}

type StageSlot = RefCell<Option<Arc<Stage>>>;

thread_local! {
    static STAGE: StageSlot = const { RefCell::new(None) };
    static TEXT_STAGE: StageSlot = const { RefCell::new(None) };
}

fn scoped<R>(slot: &'static LocalKey<StageSlot>, stage: Option<Arc<Stage>>, work: impl FnOnce() -> R) -> R {
    let previous = slot.with(|s| s.replace(stage));
    struct Restore(&'static LocalKey<StageSlot>, Option<Option<Arc<Stage>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.1.take().flatten();
            self.0.with(|s| *s.borrow_mut() = previous);
        }
    }
    let _restore = Restore(slot, Some(previous));
    work()
}

/// Run `work` with image embeddings handed to `stage` instead of running inline.
pub fn with_stage<R>(stage: Option<Arc<ImageStage>>, work: impl FnOnce() -> R) -> R {
    scoped(&STAGE, stage, work)
}

/// Run `work` with text embeddings handed to `stage` instead of running inline.
pub fn with_text_stage<R>(stage: Option<Arc<Stage>>, work: impl FnOnce() -> R) -> R {
    scoped(&TEXT_STAGE, stage, work)
}

/// The text stage, when one is set and an attempt can carry its deferred outcome.
fn current_text_stage() -> Option<Arc<Stage>> {
    TEXT_STAGE
        .with(|s| s.borrow().clone())
        .filter(|_| failures::in_attempt())
}

/// Embed a file's thumbnail, on the current stage when there is one. True when it is done
/// or waiting on an absent unit.
pub fn process_image_embedding(ctx: &Arc<RootContext>, rel_path: &str, sha: &str) -> bool {
    let stage = STAGE.with(|s| s.borrow().clone());
    if let Some(stage) = stage
        && failures::in_attempt()
    {
        let operation = failures::current_operation_id("imageSearch").unwrap_or_default();
        failures::defer("imageSearch", stage.submit(rel_path, sha, &operation));
        return true;
    }
    let mut errors = Vec::new();
    match embed_thumbnail(ctx, sha, &mut errors) {
        Ok(ok) => {
            let waiting = !ok && (ctx.image_embed_backoff.paused() || ctx.cfg.image_embed_url.is_empty());
            if !ok && errors.is_empty() && !waiting {
                errors.push("Thumbnail unavailable: generate a preview before retrying image search".to_owned());
            }
            ctx.report(
                rel_path,
                "imageSearch",
                Report {
                    error: errors.first().map(String::as_str),
                    skipped: waiting,
                    resolves: false,
                },
            );
            ok || waiting
        }
        Err(e) => {
            let reason = describe(&e);
            log(&format!("image embed: unexpected failure for {rel_path}: {reason}"));
            ctx.report(rel_path, "imageSearch", failures::failed(&reason));
            false
        }
    }
}

/// Embed the 256 px thumbnail under `sha` unless the configured model already has a row.
/// False (without error) when unconfigured, paused, unhealthy, or there is no thumbnail.
pub fn embed_thumbnail(ctx: &RootContext, sha: &str, errors: &mut Vec<String>) -> Result<bool> {
    let url = &ctx.cfg.image_embed_url;
    if url.is_empty() || ctx.image_embed_backoff.paused() {
        return Ok(false);
    }
    let health = ctx.image_embed_status();
    if let Some(guard) = image_embed::dimension_guard(health.as_ref()) {
        if ctx.image_embed_backoff.note_failure() {
            log(&format!("image embed: {guard}; pausing image embeddings"));
        }
        return Ok(false);
    }
    let configured = health.and_then(|h| h.model).unwrap_or_default();
    let existing = ctx.db.with(|c| db::image_embedding_model(c, sha))?;
    if !image_embed::needs_embedding(existing.as_deref(), &configured) {
        return Ok(true);
    }
    let thumb = ctx.cfg.thumbs_dir.join(storage_path(sha, 256));
    let data = match std::fs::read(&thumb) {
        Ok(data) => data,
        // Thumbnailing already logged why nothing was written.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            log(&format!("image embed: cannot read thumbnail {}: {e}", thumb.display()));
            errors.push(format!("OSError: {e}"));
            return Ok(false);
        }
    };
    let (vectors, model) = match image_embed::embed_images(&[data], url, ctx.cfg.image_embed_batch_size) {
        Ok(result) => result,
        Err(e) if is_outage(&e) => {
            if ctx.image_embed_backoff.note_failure() {
                log(&format!(
                    "image embed: backend unreachable ({}); pausing image embeddings",
                    error_kind(&e)
                ));
            }
            return Ok(false);
        }
        Err(e) => return Err(e),
    };
    if ctx.image_embed_backoff.note_success() {
        log("image embed: backend reachable again; resuming image embeddings");
    }
    match vectors.first() {
        Some(vector) => {
            ctx.db.with(|c| db::upsert_image_embedding(c, sha, &model, vector))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

type StageItem = (String, String, String, Promise);

/// One file's step on a stage: `(ctx, path, content key, operation id)` to its outcome.
type StageWork = fn(&Arc<RootContext>, &str, &str, &str) -> Outcome;

/// Runs one model-bound step for files on a thread of its own, so workers never wait for
/// the model. Each scan owns an image stage; watcher and queued changes share one image
/// stage and one text stage per root for the life of the process.
pub struct Stage {
    sender: Mutex<Option<crossbeam_channel::Sender<StageItem>>>,
    abandoned: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// The stage that embeds thumbnails.
pub type ImageStage = Stage;

impl Stage {
    /// Embeds thumbnails.
    pub fn start(ctx: Arc<RootContext>, name: &str) -> Arc<Self> {
        Self::spawn(ctx, name, "image embed", embed_image_staged)
    }

    /// Embeds the chunks a worker stored without vectors, then marks the row indexed.
    pub fn text(ctx: Arc<RootContext>, name: &str) -> Arc<Self> {
        Self::spawn(ctx, name, "text embed", embed_text_staged)
    }

    fn spawn(ctx: Arc<RootContext>, name: &str, label: &'static str, work: StageWork) -> Arc<Self> {
        let (sender, receiver) = crossbeam_channel::bounded::<StageItem>(SCAN_BACKLOG_LIMIT);
        let abandoned = Arc::new(AtomicBool::new(false));
        let thread_abandoned = Arc::clone(&abandoned);
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                for (rel_path, sha, operation, promise) in receiver {
                    let mut outcome = (true, true);
                    if !thread_abandoned.load(Ordering::SeqCst) {
                        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            work(&ctx, &rel_path, &sha, &operation)
                        }));
                        outcome = run.unwrap_or_else(|_| {
                            log(&format!("{label}: unexpected failure for {rel_path}"));
                            (false, false)
                        });
                    }
                    promise.resolve(outcome);
                }
            })
            .ok();
        Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            abandoned,
            thread: Mutex::new(thread),
        })
    }

    fn item(rel_path: &str, sha: &str, operation: &str, promise: &Promise) -> StageItem {
        (
            rel_path.to_owned(),
            sha.to_owned(),
            operation.to_owned(),
            promise.clone(),
        )
    }

    pub fn submit(&self, rel_path: &str, sha: &str, operation: &str) -> Promise {
        let promise = Promise::new();
        let sent = lock(&self.sender)
            .as_ref()
            .map(|s| s.send(Self::item(rel_path, sha, operation, &promise)).is_ok());
        if sent != Some(true) {
            promise.resolve((true, true));
        }
        promise
    }

    /// `submit` without waiting: `None` when the stage is full or closed.
    pub fn try_submit(&self, rel_path: &str, sha: &str, operation: &str) -> Option<Promise> {
        let promise = Promise::new();
        let sent = lock(&self.sender)
            .as_ref()
            .is_some_and(|s| s.try_send(Self::item(rel_path, sha, operation, &promise)).is_ok());
        sent.then_some(promise)
    }

    /// Drain and stop. After a failed scan, `abandon` drops queued work; the next scan
    /// finds those files missing their embedding.
    pub fn close(&self, abandon: bool) {
        self.abandoned.store(abandon, Ordering::SeqCst);
        lock(&self.sender).take();
        if let Some(thread) = lock(&self.thread).take() {
            let _ = thread.join();
        }
    }
}

fn embed_image_staged(ctx: &Arc<RootContext>, rel_path: &str, sha: &str, operation: &str) -> Outcome {
    if !ctx.values().image_search {
        return (true, true);
    }
    let ids = [("imageSearch".to_owned(), operation.to_owned())].into_iter().collect();
    let (_, observed) = attempt(ids, || with_stage(None, || process_image_embedding(ctx, rel_path, sha)));
    observed.outcomes.get("imageSearch").copied().unwrap_or((true, true))
}

/// Embed a file's stored chunks under its lock, unless a newer version replaced them: that
/// version's own stage item embeds it, so this one is a skip rather than a failure.
fn embed_text_staged(ctx: &Arc<RootContext>, rel_path: &str, sha: &str, operation: &str) -> Outcome {
    if !ctx.values().semantic_search {
        return (true, true);
    }
    let ids = [("semanticSearch".to_owned(), operation.to_owned())]
        .into_iter()
        .collect();
    let (result, observed) = attempt(ids, || {
        let _guard = ctx.path_locks.get(rel_path);
        embed_chunks(ctx, rel_path, Some(sha))
    });
    let reported = observed.outcomes.get("semanticSearch").copied();
    match result {
        Ok(Embedded::Done) => reported.unwrap_or((true, false)),
        Ok(_) => (true, true),
        Err(e) => {
            log(&format!("embed failed for {rel_path}: {}", describe(&e)));
            reported.unwrap_or((false, false))
        }
    }
}

/// Fill in derivatives a newly enabled feature needs, without touching indexed text.
/// False keeps the root's backfill pending.
pub fn backfill_media(ctx: &Arc<RootContext>, _abs_path: &Path, rel_path: &str, stat: FileStat) -> Result<bool> {
    let features = ctx.values();
    if !features.internal_thumbnails() {
        return Ok(true);
    }
    let ext = ext_of(basename(rel_path));
    let Some(sha) = ctx.db.with(|c| db::file_content_key(c, ctx.root_id, rel_path))? else {
        return Ok(false);
    };
    // Keep the descriptor open while tools reopen it through its path.
    let opened = open_source(ctx, rel_path)?;
    let source = opened.path();
    let (mut ok, skipped) = process_thumbnails(ctx, &source, rel_path, &ext, &sha, stat.size, false);
    if features.image_search && image_embed::is_candidate(&ext) && !skipped {
        ok = process_image_embedding(ctx, rel_path, &sha) && ok;
    }
    Ok(ok)
}

/// Whether a live file needs enabled media output rebuilt. Thumbnail files and embedding
/// rows are the durable state; a failed thumbnail's unresolved failure stands in for its
/// missing file, so rescans do not retry it until the file changes.
pub fn media_derivatives_missing(
    ctx: &RootContext,
    rel_path: &str,
    size: u64,
    row: &ManifestRow,
    include_existing: bool,
) -> bool {
    let features = ctx.values();
    let Some(key) = row.sha256.as_deref() else { return false };
    if !features.internal_thumbnails() {
        return false;
    }
    let ext = ext_of(basename(rel_path));
    if kind_for_ext(&ext).is_none() {
        return false;
    }
    let can_generate = size <= ctx.cfg.thumb_max_bytes;
    let paths: Vec<PathBuf> = SIZES
        .iter()
        .map(|s| ctx.cfg.thumbs_dir.join(storage_path(key, *s)))
        .collect();
    if can_generate && (include_existing || (!row.thumbnail_failed && paths.iter().any(|p| !p.exists()))) {
        return true;
    }
    features.image_search && image_embed::is_candidate(&ext) && !row.image_embedded && paths[0].exists()
}

/// What embedding a file's stored chunks came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Embedded {
    Done,
    /// Semantic search is off.
    Off,
    /// The backend is down: the row stays `partial` for a later scan.
    Waiting,
    /// The row no longer holds the expected content.
    Superseded,
}

/// Fill embeddings for a file whose text is already chunked (`partial`). False when the
/// backend is down: not an error, the row stays `partial` for a later scan.
pub fn embed_missing(ctx: &RootContext, rel_path: &str, expected_sha: Option<&str>) -> Result<bool> {
    let _guard = ctx.path_locks.get(rel_path);
    match embed_chunks(ctx, rel_path, expected_sha)? {
        Embedded::Done | Embedded::Off => Ok(true),
        Embedded::Waiting => Ok(false),
        Embedded::Superseded => anyhow::bail!(
            "ValueError: Source changed or is no longer indexed. Reindex its text before retrying semantic search."
        ),
    }
}

/// `embed_missing` for a caller that holds the file's path lock.
pub fn embed_chunks(ctx: &RootContext, rel_path: &str, expected_sha: Option<&str>) -> Result<Embedded> {
    ctx.maybe_refresh_features();
    if !ctx.values().semantic_search {
        return Ok(Embedded::Off);
    }
    if ctx.embed_backoff.paused() {
        return Ok(Embedded::Waiting);
    }
    if let Some(expected) = expected_sha
        && ctx
            .db
            .with(|c| db::file_content_key(c, ctx.root_id, rel_path))?
            .as_deref()
            != Some(expected)
    {
        return Ok(Embedded::Superseded);
    }
    let rows = ctx
        .db
        .with(|c| db::chunks_missing_embeddings(c, ctx.root_id, rel_path))?;
    if !rows.is_empty() {
        let texts: Vec<String> = rows.iter().map(|(_, t)| t.clone()).collect();
        let vectors = match embed_passages(&texts, &ctx.cfg.embed_url, ctx.cfg.embed_batch) {
            Ok(vectors) => vectors,
            Err(e) if is_outage(&e) => {
                note_embed_outage(ctx, &e);
                return Ok(Embedded::Waiting);
            }
            Err(e) => {
                ctx.report(rel_path, "semanticSearch", failures::failed(&describe(&e)));
                return Err(e);
            }
        };
        note_embed_recovery(ctx);
        let pairs: Vec<(i64, Vec<f32>)> = rows.iter().map(|(id, _)| *id).zip(vectors).collect();
        ctx.db.with(|c| db::set_chunk_embeddings(c, &pairs))?;
    }
    ctx.db.with(|c| db::mark_file_indexed(c, ctx.root_id, rel_path))?;
    ctx.report(rel_path, "semanticSearch", failures::ok());
    Ok(Embedded::Done)
}

/// `process_file`, recording any failure on the row: "indexed", "unchanged" or "error".
pub fn safe_process(ctx: &Arc<RootContext>, abs_path: &Path, rel_path: &str, stat: FileStat) -> &'static str {
    safe_process_with(ctx, abs_path, rel_path, stat, None)
}

/// `safe_process` with the API's description of the file.
pub fn safe_process_with(
    ctx: &Arc<RootContext>,
    abs_path: &Path,
    rel_path: &str,
    stat: FileStat,
    hint: Option<&ContentHint>,
) -> &'static str {
    match process_file_with(ctx, abs_path, rel_path, stat, hint) {
        Ok(true) => "indexed",
        Ok(false) => "unchanged",
        Err(e) => {
            let reason = describe(&e);
            log(&format!("ERROR {rel_path}: {reason}"));
            let ext = ext_of(rel_path);
            for feature in work_features(&ctx.values(), Some(&ext), false, false) {
                ctx.report(rel_path, &feature, failures::failed(&reason));
            }
            let message = format!("{}: {}", error_kind(&e), reason.chars().take(300).collect::<String>());
            let _ = ctx.db.with(|c| db::mark_file_error(c, ctx.root_id, rel_path, &message));
            "error"
        }
    }
}

/// Counts a scan reports, also kept in `idx.scans`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanResult {
    pub seen: i64,
    pub changed: i64,
    pub deleted: i64,
    pub errors: i64,
}

pub fn scan_once(ctx: &Arc<RootContext>) -> ScanResult {
    ctx.maybe_refresh_features();
    let configuration = ctx.features();
    let features = work_features(&configuration.values, None, false, false);
    let operations = ctx.activity.start_scan(&features, configuration.revision);
    let result = scan_inner(ctx, &operations);
    // Root and discovery errors have no file outcome to carry the failure.
    let outcome = if result.errors > 0 && !operations.values().any(|op| op.errors() > 0) {
        "failed"
    } else {
        "completed"
    };
    let enabled = ctx.values();
    for (feature, op) in &operations {
        op.finish(if enabled.get(feature) { outcome } else { "stopped" });
    }
    result
}

struct ScanJob {
    abs: PathBuf,
    rel: String,
    stat: FileStat,
    tracked: Vec<Op>,
    embed_only: bool,
    media_only: bool,
}

struct ScanCounters {
    changed: AtomicI64,
    errors: AtomicI64,
    media_backfill_errors: AtomicI64,
}

fn scan_inner(ctx: &Arc<RootContext>, operations: &HashMap<String, Op>) -> ScanResult {
    ctx.maybe_refresh_features();
    if !ctx.values().indexer_enabled() {
        return ScanResult::default();
    }
    // A wrong or empty mount must never be read as every file deleted.
    if !ctx.files_folder_verified() {
        return ScanResult {
            errors: 1,
            ..ScanResult::default()
        };
    }
    if let Err(e) = std::fs::read_dir(&ctx.abs_path) {
        log(&format!("[{}] scan skipped: root unavailable: {e}", ctx.name));
        return ScanResult {
            errors: 1,
            ..ScanResult::default()
        };
    }
    let started = match ctx.db.with(|c| {
        let baseline = db::scan_baseline(c, ctx.root_id)?;
        let started = db::start_scan(c, ctx.root_id)?;
        Ok((baseline, started, db::scan_manifest(c, ctx.root_id)?))
    }) {
        Ok(started) => started,
        Err(e) => {
            log(&format!("[{}] scan crashed: {}", ctx.name, describe(&e)));
            return ScanResult {
                errors: 1,
                ..ScanResult::default()
            };
        }
    };
    let ((finished_before, had_folders), (scan_id, started_at), manifest) = started;
    // Differences are journaled only against a baseline: without rows to compare with, every
    // file would look new, and none of them changed. The first scan of an empty index, the
    // one after the whole index was cleared and the one after an interrupted first scan
    // journal nothing.
    let journal_files = (finished_before && !manifest.is_empty()).then_some(Source::Scan);
    let journal_folders = journal_files.filter(|_| had_folders);
    let t0 = Instant::now();
    let mut unseen: HashSet<String> = manifest
        .iter()
        .filter(|(_, row)| !row.deleted)
        .map(|(path, _)| path.clone())
        .collect();
    let counters = Arc::new(ScanCounters {
        changed: AtomicI64::new(0),
        errors: AtomicI64::new(0),
        media_backfill_errors: AtomicI64::new(0),
    });
    let image_op = operations.get("imageSearch").cloned();
    let stage = (image_op.is_some() && !ctx.cfg.image_embed_url.is_empty())
        .then(|| ImageStage::start(Arc::clone(ctx), &format!("image-embed-{}", ctx.name)));

    let workers = ctx.settings().workers.max(1);
    let (sender, receiver) = crossbeam_channel::bounded::<ScanJob>(SCAN_BACKLOG_LIMIT);
    let pool: Vec<_> = (0..workers)
        .filter_map(|i| {
            let (receiver, ctx, counters, stage, image_op) = (
                receiver.clone(),
                Arc::clone(ctx),
                Arc::clone(&counters),
                stage.clone(),
                image_op.clone(),
            );
            std::thread::Builder::new()
                .name(format!("scan-{}-{i}", ctx.name))
                .spawn(move || {
                    journal::with_source(journal_files, || {
                        for job in receiver {
                            ctx.yield_to_foreground(FOREGROUND_WAIT_LIMIT);
                            tracked_job(&ctx, job, &counters, stage.as_ref(), image_op.as_ref());
                        }
                    });
                })
                .ok()
        })
        .collect();

    let mut seen = 0;
    let mut traversal_complete = true;
    let mut traversal_errors = false;
    let mut folders = Vec::new();
    walk_tree(
        &ctx.abs_path,
        || traversal_errors = true,
        |folder| folders.push(folder),
        |abs, rel, stat| {
            seen += 1;
            unseen.remove(&rel);
            let prev = manifest.get(&rel);
            // A pending row still needs its text, so media-only work must not stand in for it.
            let unchanged = unchanged_in_db(prev, stat);
            ctx.maybe_refresh_features();
            let features = ctx.values();
            if !features.indexer_enabled() {
                traversal_complete = false;
                return false;
            }
            let media_needed = unchanged
                && prev.is_some_and(|row| {
                    media_derivatives_missing(ctx, &rel, stat.size, row, ctx.needs_media_backfill())
                });
            let mut retry_unchanged = prev.is_some_and(|row| should_retry_unchanged(&row.status, &features));
            if prev.is_some_and(|row| row.status.starts_with("excluded"))
                && exclusion_still_applies(ctx, &rel, stat.size)
            {
                retry_unchanged = false;
            }
            let (embed_only, media_only) =
                if unchanged && prev.is_some_and(|r| r.status == "partial") && features.semantic_search {
                    (true, media_needed)
                } else if unchanged && retry_unchanged {
                    (false, false)
                } else if media_needed {
                    (false, true)
                } else if unchanged {
                    return true;
                } else {
                    (false, false)
                };
            let ext = ext_of(&rel);
            let mut names = work_features(&features, Some(&ext), embed_only, media_only);
            if embed_only && media_only && features.semantic_search {
                names.push("semanticSearch".to_owned());
            }
            let tracked: Vec<Op> = names.iter().filter_map(|f| operations.get(f).cloned()).collect();
            for op in &tracked {
                op.enqueue();
            }
            sender
                .send(ScanJob {
                    abs,
                    rel,
                    stat,
                    tracked,
                    embed_only,
                    media_only,
                })
                .is_ok()
        },
    );
    if traversal_errors {
        traversal_complete = false;
    }
    if traversal_complete {
        for op in operations.values() {
            op.discovered();
        }
    }
    drop(sender);
    for worker in pool {
        let _ = worker.join();
    }
    // The stage closes after the pool: running jobs may still hand it embeddings.
    if let Some(stage) = &stage {
        stage.close(false);
    }

    // A worker can observe disablement after traversal finished.
    let traversal_complete = traversal_complete && ctx.values().indexer_enabled();
    let unseen: Vec<String> = unseen.into_iter().collect();
    let vanished = if traversal_complete {
        ctx.db
            .with(|c| db::sweep_vanished_paths(c, ctx.root_id, &unseen, started_at))
            .unwrap_or_else(|e| {
                log(&format!("[{}] sweep failed: {}", ctx.name, describe(&e)));
                Vec::new()
            })
    } else {
        Vec::new()
    };
    let deleted = vanished.len() as i64;
    for path in &vanished {
        ctx.names_touched(path, false);
    }
    if let Some(source) = journal_files {
        let gone: Vec<NewChange> = vanished.iter().map(|path| NewChange::path(path)).collect();
        journal::record_as(ctx, source, &gone);
    }
    let sweep = traversal_complete.then_some(("", started_at));
    match ctx
        .db
        .with(|c| db::sync_folders_changes(c, ctx.root_id, &folders, sweep))
    {
        Ok(changes) => {
            touch_folders(ctx, &changes);
            if let Some(source) = journal_folders {
                journal::record_as(ctx, source, &folder_changes(&changes));
            }
        }
        Err(e) => log(&format!("[{}] folder sync failed: {}", ctx.name, describe(&e))),
    }
    if traversal_complete && ctx.needs_media_backfill() && counters.media_backfill_errors.load(Ordering::SeqCst) == 0 {
        ctx.finish_media_backfill();
    }
    // An unreadable entry only stops the sweep; it is not a file failure.
    let errors = counters.errors.load(Ordering::SeqCst);
    let changed = counters.changed.load(Ordering::SeqCst);
    let finished = ctx.db.with(|c| {
        db::finish_scan(c, scan_id, seen, changed, deleted, errors)?;
        db::prune_events(c, ctx.cfg.events_retention_days)?;
        Ok(())
    });
    if let Err(e) = finished.and_then(|()| failures::prune(&ctx.db)) {
        log(&format!("[{}] scan bookkeeping failed: {}", ctx.name, describe(&e)));
    }
    log(&format!(
        "[{}] scan done: {seen} files, {changed} (re)indexed, {deleted} deleted, {errors} errors, {:.0}s",
        ctx.name,
        t0.elapsed().as_secs_f64()
    ));
    // A completed walk is a good moment to read the names again whole: it catches modification
    // times of unchanged folders and anything the index missed.
    if traversal_complete {
        ctx.names_rebuild();
    }
    ScanResult {
        seen,
        changed,
        deleted,
        errors,
    }
}

/// One scan job: decides between full processing, an embedding retry and a media backfill.
fn scan_job(ctx: &Arc<RootContext>, job: &ScanJob, counters: &ScanCounters) -> bool {
    ctx.maybe_refresh_features();
    if !ctx.values().indexer_enabled() {
        return true;
    }
    let mut media_ok = true;
    if job.media_only {
        media_ok = backfill_media(ctx, &job.abs, &job.rel, job.stat).unwrap_or_else(|e| {
            log(&format!(
                "[{}] media backfill failed for {}: {}",
                ctx.name,
                job.rel,
                describe(&e)
            ));
            false
        });
        if !media_ok {
            counters.media_backfill_errors.fetch_add(1, Ordering::SeqCst);
        }
        if !job.embed_only {
            return media_ok;
        }
    }
    let ok = if job.embed_only {
        if !ctx.values().semantic_search {
            return media_ok;
        }
        match embed_missing(ctx, &job.rel, None) {
            Ok(false) => return media_ok,
            Ok(true) => true,
            Err(e) => {
                log(&format!(
                    "[{}] embed retry failed for {}: {}",
                    ctx.name,
                    job.rel,
                    describe(&e)
                ));
                false
            }
        }
    } else {
        match safe_process(ctx, &job.abs, &job.rel, job.stat) {
            "unchanged" => return media_ok,
            result => result == "indexed",
        }
    };
    if ok {
        counters.changed.fetch_add(1, Ordering::SeqCst);
    }
    ok && media_ok
}

fn tracked_job(
    ctx: &Arc<RootContext>,
    job: ScanJob,
    counters: &Arc<ScanCounters>,
    stage: Option<&Arc<ImageStage>>,
    image_op: Option<&Op>,
) {
    let ids: HashMap<String, String> = job
        .tracked
        .iter()
        .map(|op| (op.feature().to_owned(), op.id.clone()))
        .collect();
    let uses_stage = image_op.is_some_and(|image| job.tracked.iter().any(|op| Arc::ptr_eq(op, image)));
    let stage = if uses_stage { stage.cloned() } else { None };
    let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        attempt(ids, || with_stage(stage, || scan_job(ctx, &job, counters)))
    }));
    let (job_ok, observed) = run.unwrap_or_else(|_| {
        log(&format!("[{}] job crashed for {}", ctx.name, job.rel));
        (false, failures::Attempt::default())
    });
    let file_failed = !job_ok || observed.outcomes.values().any(|(ok, _)| !ok);
    if file_failed {
        counters.errors.fetch_add(1, Ordering::SeqCst);
    }
    for op in &job.tracked {
        match observed.deferred.get(op.feature()) {
            None => {
                let (ok, skipped) = observed.outcomes.get(op.feature()).copied().unwrap_or((true, true));
                op.advance(ok, skipped);
            }
            Some(promise) => {
                let (op, counters, media_only) = (Arc::clone(op), Arc::clone(counters), job.media_only);
                promise.on_done(move |(ok, skipped)| {
                    op.advance(ok, skipped);
                    if !ok {
                        // A file that already failed another stage is still one failed file.
                        counters.errors.fetch_add(i64::from(!file_failed), Ordering::SeqCst);
                        counters
                            .media_backfill_errors
                            .fetch_add(i64::from(media_only), Ordering::SeqCst);
                    }
                });
            }
        }
    }
}

/// Watcher entry point for one changed file.
pub fn watch_index(ctx: &Arc<RootContext>, abs_path: &Path, rel_path: &str, stat: FileStat) -> FileResult {
    watch_index_with(ctx, abs_path, rel_path, stat, None)
}

/// Entry point for one file someone just changed, seen by the watcher or queued by the API:
/// foreground work that scans wait for, with both embeddings handed to the root's stages.
pub fn watch_index_with(
    ctx: &Arc<RootContext>,
    abs_path: &Path,
    rel_path: &str,
    stat: FileStat,
    hint: Option<&ContentHint>,
) -> FileResult {
    ctx.maybe_refresh_features();
    let features = ctx.values();
    if !features.indexer_enabled() {
        return FileResult::plain("disabled");
    }
    let _foreground = ctx.foreground();
    // Inline embedding paced every watcher worker at the model's speed.
    let stage = (features.image_search && !ctx.cfg.image_embed_url.is_empty()).then(|| ctx.watch_image_stage());
    let text = features.semantic_search.then(|| ctx.watch_text_stage());
    let (status, observed) = attempt(HashMap::new(), || {
        with_stage(stage, || {
            with_text_stage(text, || safe_process_with(ctx, abs_path, rel_path, stat, hint))
        })
    });
    FileResult {
        status: status.to_owned(),
        outcomes: Some(observed.outcomes),
        deferred: observed.deferred,
    }
}

pub fn watch_mark_deleted(ctx: &RootContext, rel_path: &str, is_dir: bool) -> usize {
    if !ctx.values().indexer_enabled() {
        return 0;
    }
    let _guard = ctx.path_locks.get(rel_path);
    match ctx.db.with(|c| db::delete_paths(c, ctx.root_id, rel_path, is_dir)) {
        Ok(deleted) => {
            if !deleted.files.is_empty() || deleted.folders > 0 {
                ctx.names_touched(rel_path, is_dir);
            }
            if !deleted.files.is_empty() {
                emit_event(ctx, EventKind::Deleted, rel_path, None);
            }
            // An empty folder has no file rows, but its going is still a change.
            if !deleted.files.is_empty() || deleted.folders > 0 {
                journal::record(ctx, vec![NewChange::path(rel_path)]);
            }
            deleted.files.len()
        }
        Err(e) => {
            log(&format!("watch: delete {rel_path} failed: {}", describe(&e)));
            0
        }
    }
}

/// The folders from the top of the root down to `rel` (a root-relative folder, or `""`), as
/// they are on disk. Stops at the first one that is gone, not a folder, or never walked.
pub fn folder_chain(root: &Path, rel: &str) -> Vec<db::FolderRow> {
    let mut chain = Vec::new();
    let mut path = String::new();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        if !should_index_name(part, SKIP_NAMES) || !should_walk_dir(part, SKIP_DIRS) {
            break;
        }
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(part);
        match std::fs::symlink_metadata(root.join(&path)) {
            Ok(metadata) if metadata.is_dir() => chain.push(db::FolderRow {
                path: path.clone(),
                mtime_ns: FileStat::of(&metadata).mtime_ns,
            }),
            _ => break,
        }
    }
    chain
}

/// Write `found` to the root's folder rows; with `sweep`, also drop the rows below that folder
/// the walk that found them did not see. Nothing is written while indexing is off. Folders
/// added and dropped are journaled under the thread's source.
pub fn record_folders(ctx: &RootContext, found: &[db::FolderRow], sweep: Option<(&str, DateTime<Utc>)>) {
    if (found.is_empty() && sweep.is_none()) || !ctx.values().indexer_enabled() {
        return;
    }
    match ctx.db.with(|c| db::sync_folders_changes(c, ctx.root_id, found, sweep)) {
        Ok(changes) => {
            touch_folders(ctx, &changes);
            journal::record(ctx, folder_changes(&changes));
        }
        Err(e) => log(&format!("[{}] folder sync failed: {}", ctx.name, describe(&e))),
    }
}

/// Tell the name index about every folder row added or dropped.
fn touch_folders(ctx: &RootContext, changes: &db::FolderChanges) {
    for path in changes.added.iter().chain(&changes.dropped) {
        ctx.names_touched(path, false);
    }
}

/// One journal row per folder added or dropped.
fn folder_changes(changes: &db::FolderChanges) -> Vec<NewChange> {
    changes
        .added
        .iter()
        .chain(&changes.dropped)
        .map(|path| NewChange::path(path))
        .collect()
}

/// A folder appeared or changed under `rel`: record it, the folders above it and every folder
/// below it, and drop the rows of folders below it that are gone.
pub fn watch_folder(ctx: &RootContext, rel: &str) {
    if !ctx.values().indexer_enabled() {
        return;
    }
    let started_at = match ctx.db.with(db::now) {
        Ok(now) => now,
        Err(e) => {
            log(&format!("[{}] folder sync failed: {}", ctx.name, describe(&e)));
            return;
        }
    };
    let mut found = folder_chain(&ctx.abs_path, rel);
    if found.last().is_none_or(|f| f.path != rel) {
        return;
    }
    let mut complete = true;
    walk_tree(
        &ctx.abs_path.join(rel),
        || complete = false,
        |mut folder| {
            folder.path = format!("{rel}/{}", folder.path);
            found.push(folder);
        },
        |_, _, _| true,
    );
    record_folders(ctx, &found, complete.then_some((rel, started_at)));
}

/// Rename rows in place. A file whose extension changes is a delete; its new path is
/// indexed as a new file.
pub fn watch_rename(ctx: &RootContext, old: &str, new: &str, is_dir: bool) -> usize {
    if !ctx.values().indexer_enabled() {
        return 0;
    }
    if !is_dir && ext_of(basename(old)) != ext_of(basename(new)) {
        watch_mark_deleted(ctx, old, false);
        return 0;
    }
    let _guard = ctx.path_locks.get_many(&[old, new]);
    let moved = ctx.db.with(|c| {
        let moved = db::move_paths(c, ctx.root_id, old, new, is_dir)?;
        if moved.files > 0 {
            db::insert_move(c, ctx.root_id, old, new, "watcher")?;
        }
        Ok(moved)
    });
    match moved {
        Ok(moved) => {
            if moved.files + moved.folders > 0 {
                ctx.names_touched(old, is_dir);
                ctx.names_touched(new, is_dir);
            }
            if moved.files > 0 {
                emit_event(ctx, EventKind::Moved, old, Some(new));
            }
            // An empty folder moves only its folder rows, but that is still a move.
            if moved.files + moved.folders > 0 {
                journal::record(ctx, vec![NewChange::moved(old, new)]);
            }
            moved.files as usize
        }
        Err(e) => {
            log(&format!("watch: rename {old} -> {new} failed: {}", describe(&e)));
            0
        }
    }
}
