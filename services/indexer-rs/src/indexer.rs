//! Orchestration: walk a root, hash and extract changed files, chunk and embed text,
//! build thumbnails and image embeddings, and reconcile what the watcher could not see.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::activity::{Op, RootActivity};
use crate::backoff::{Backoff, is_outage};
use crate::chunking::{chunk, is_document, is_image, is_pdf, is_textual, max_chunks_for};
use crate::config::{Config, SKIP_DIRS, SKIP_NAMES};
use crate::db::{self, Db, ManifestRow, NewFile};
use crate::events::{EventKind, build};
use crate::extract::{Extractor, embed_passages};
use crate::failures::{self, FileResult, Report, attempt, describe, report};
use crate::features::{FeatureConfiguration, FeatureValues};
use crate::image_embed::{self, Health};
use crate::log::log;
use crate::paths::{basename, ext_of};
use crate::promise::{Outcome, Promise};
use crate::rules::{Globs, should_index_name, should_walk_dir};
use crate::settings::{self, Settings};
use crate::thumbs::{SIZES, kind_for_ext, skip_reason, storage_path};
use crate::thumbs_io;

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
    pub activity: RootActivity,
}

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
            activity: RootActivity::default(),
            cfg,
        }
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

    fn report(&self, path: &str, feature: &str, result: Report<'_>) {
        report(&self.db, self.root_id, path, feature, result);
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
    if unchanged {
        if status.starts_with("excluded") && exclusion_still_applies(ctx, rel_path, stat.size) {
            return Ok(false);
        }
        if !should_retry_unchanged(&status, &ctx.values()) {
            return Ok(false);
        }
    }
    let was_new = row.is_none();
    let same_version = row
        .as_ref()
        .is_some_and(|r| r.size == stat.size as i64 && r.mtime_ns == stat.mtime_ns && !r.deleted);
    // A feature transition may re-extract an unchanged file; its digest is still valid.
    let known_sha = if unchanged { row.and_then(|r| r.sha256) } else { None };
    process_inner(ctx, abs_path, rel_path, stat, known_sha, None)?;
    // Listeners check access for every event; re-deriving the same version changes nothing.
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
    }
    Ok(true)
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
/// a directory swapped for a link after the walk cannot redirect the read elsewhere.
pub fn open_source(ctx: &RootContext, rel_path: &str) -> Result<crate::fsx::OpenedFile> {
    let parts =
        crate::fsx::path_parts(&format!("/{}", rel_path.trim_start_matches('/'))).map_err(anyhow::Error::msg)?;
    Ok(crate::fsx::open_file(&ctx.abs_path, &parts)?)
}

/// Hash, extract, chunk, embed and store one file, then build its media derivatives.
/// The file is reopened from the root rather than through `_abs_path`.
/// `only_feature = Some("textSearch")` re-reads text without media or embeddings.
pub fn process_inner(
    ctx: &Arc<RootContext>,
    _abs_path: &Path,
    rel_path: &str,
    stat: FileStat,
    known_sha: Option<String>,
    only_feature: Option<&str>,
) -> Result<()> {
    let name = basename(rel_path);
    let ext = ext_of(name);
    let mime = guess_mime(name);
    let mut source = open_source(ctx, rel_path)?;
    let sha = match known_sha {
        Some(sha) => sha,
        None => crate::fsx::sha256_of_file(&mut source.file)?,
    };
    let source_path = source.path();
    let abs_path = source_path.as_path();
    let file_id = ctx.db.with(|c| {
        db::upsert_file(
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
        )
    })?;

    let mut features = ctx.values();
    if only_feature == Some("textSearch") {
        features.semantic_search = false;
        features.thumbnails = false;
        features.image_search = false;
    }
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
    if features.semantic_search {
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
    if features.internal_thumbnails() {
        process_thumbnails(ctx, abs_path, rel_path, &ext, &sha, stat.size, false);
    }
    if features.image_search
        && image_embed::is_candidate(&ext)
        && skip_reason(stat.size, ctx.cfg.thumb_max_bytes).is_none()
    {
        process_image_embedding(ctx, rel_path, &sha);
    }
    Ok(())
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

thread_local! {
    static STAGE: RefCell<Option<Arc<ImageStage>>> = const { RefCell::new(None) };
}

/// Run `work` with image embeddings handed to `stage` instead of running inline.
pub fn with_stage<R>(stage: Option<Arc<ImageStage>>, work: impl FnOnce() -> R) -> R {
    let previous = STAGE.with(|s| s.replace(stage));
    struct Restore(Option<Option<Arc<ImageStage>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let previous = self.0.take().flatten();
            STAGE.with(|s| *s.borrow_mut() = previous);
        }
    }
    let _restore = Restore(Some(previous));
    work()
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

/// Embeds thumbnails on one thread of its own, so workers never wait for the model.
/// Each scan owns one; watcher changes share one per root for the life of the process.
pub struct ImageStage {
    sender: Mutex<Option<crossbeam_channel::Sender<StageItem>>>,
    abandoned: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl ImageStage {
    pub fn start(ctx: Arc<RootContext>, name: &str) -> Arc<Self> {
        let (sender, receiver) = crossbeam_channel::bounded::<StageItem>(SCAN_BACKLOG_LIMIT);
        let abandoned = Arc::new(AtomicBool::new(false));
        let thread_abandoned = Arc::clone(&abandoned);
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || {
                for (rel_path, sha, operation, promise) in receiver {
                    let mut outcome = (true, true);
                    if !thread_abandoned.load(Ordering::SeqCst) && ctx.values().image_search {
                        let ids = [("imageSearch".to_owned(), operation)].into_iter().collect();
                        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            attempt(ids, || {
                                with_stage(None, || process_image_embedding(&ctx, &rel_path, &sha))
                            })
                        }));
                        outcome = match run {
                            Ok((_, observed)) => observed.outcomes.get("imageSearch").copied().unwrap_or((true, true)),
                            Err(_) => {
                                log(&format!("image embed: unexpected failure for {rel_path}"));
                                (false, false)
                            }
                        };
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

    pub fn submit(&self, rel_path: &str, sha: &str, operation: &str) -> Promise {
        let promise = Promise::new();
        let sent = lock(&self.sender).as_ref().map(|s| {
            s.send((
                rel_path.to_owned(),
                sha.to_owned(),
                operation.to_owned(),
                promise.clone(),
            ))
            .is_ok()
        });
        if sent != Some(true) {
            promise.resolve((true, true));
        }
        promise
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
    let source = open_source(ctx, rel_path)?.path();
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

/// Fill embeddings for a file whose text is already chunked (`partial`). False when the
/// backend is down: not an error, the row stays `partial` for a later scan.
pub fn embed_missing(ctx: &RootContext, rel_path: &str, expected_sha: Option<&str>) -> Result<bool> {
    let _guard = ctx.path_locks.get(rel_path);
    ctx.maybe_refresh_features();
    if !ctx.values().semantic_search {
        return Ok(true);
    }
    if ctx.embed_backoff.paused() {
        return Ok(false);
    }
    if let Some(expected) = expected_sha
        && ctx
            .db
            .with(|c| db::file_content_key(c, ctx.root_id, rel_path))?
            .as_deref()
            != Some(expected)
    {
        anyhow::bail!(
            "ValueError: Source changed or is no longer indexed. Reindex its text before retrying semantic search."
        );
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
                return Ok(false);
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
    Ok(true)
}

/// `process_file`, recording any failure on the row: "indexed", "unchanged" or "error".
pub fn safe_process(ctx: &Arc<RootContext>, abs_path: &Path, rel_path: &str, stat: FileStat) -> &'static str {
    match process_file(ctx, abs_path, rel_path, stat) {
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

/// Yield `(abs, rel, stat)` for regular files below `root`, directories sorted by
/// lowercase name, skipping junk. `on_error` hears about unreadable entries.
pub fn walk(root: &Path, mut on_error: impl FnMut(), mut visit: impl FnMut(PathBuf, String, FileStat) -> bool) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries: Vec<std::fs::DirEntry> = match std::fs::read_dir(&dir) {
            Ok(entries) => entries.filter_map(std::result::Result::ok).collect(),
            Err(e) => {
                log(&format!("skip dir {}: {e}", dir.display()));
                on_error();
                continue;
            }
        };
        entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
        let mut subdirs = Vec::new();
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !should_index_name(&name, SKIP_NAMES) {
                continue;
            }
            let metadata = match std::fs::symlink_metadata(entry.path()) {
                Ok(metadata) => metadata,
                Err(e) => {
                    log(&format!("skip {}: {e}", entry.path().display()));
                    on_error();
                    continue;
                }
            };
            if metadata.is_dir() {
                if should_walk_dir(&name, SKIP_DIRS) {
                    subdirs.push(entry.path());
                }
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();
            if !visit(path, rel, FileStat::of(&metadata)) {
                return;
            }
        }
        stack.extend(subdirs.into_iter().rev());
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
    if let Err(e) = std::fs::read_dir(&ctx.abs_path) {
        log(&format!("[{}] scan skipped: root unavailable: {e}", ctx.name));
        return ScanResult {
            errors: 1,
            ..ScanResult::default()
        };
    }
    let started = match ctx.db.with(|c| {
        let started = db::start_scan(c, ctx.root_id)?;
        Ok((started, db::scan_manifest(c, ctx.root_id)?))
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
    let ((scan_id, started_at), manifest) = started;
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
                    for job in receiver {
                        tracked_job(&ctx, job, &counters, stage.as_ref(), image_op.as_ref());
                    }
                })
                .ok()
        })
        .collect();

    let mut seen = 0;
    let mut traversal_complete = true;
    let mut traversal_errors = false;
    walk(
        &ctx.abs_path,
        || traversal_errors = true,
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
    let deleted = if traversal_complete {
        ctx.db
            .with(|c| db::sweep_vanished(c, ctx.root_id, &unseen, started_at))
            .unwrap_or_else(|e| {
                log(&format!("[{}] sweep failed: {}", ctx.name, describe(&e)));
                0
            })
    } else {
        0
    };
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
    ctx.maybe_refresh_features();
    let features = ctx.values();
    if !features.indexer_enabled() {
        return FileResult::plain("disabled");
    }
    // Inline embedding paced every watcher worker at the model's speed.
    let stage = (features.image_search && !ctx.cfg.image_embed_url.is_empty()).then(|| ctx.watch_image_stage());
    let (status, observed) = attempt(HashMap::new(), || {
        with_stage(stage, || safe_process(ctx, abs_path, rel_path, stat))
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
    match ctx.db.with(|c| db::mark_deleted(c, ctx.root_id, rel_path, is_dir)) {
        Ok(ids) => {
            if !ids.is_empty() {
                emit_event(ctx, EventKind::Deleted, rel_path, None);
            }
            ids.len()
        }
        Err(e) => {
            log(&format!("watch: delete {rel_path} failed: {}", describe(&e)));
            0
        }
    }
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
        let moved = db::rename_paths(c, ctx.root_id, old, new, is_dir)?;
        if moved > 0 {
            db::insert_move(c, ctx.root_id, old, new, "watcher")?;
        }
        Ok(moved)
    });
    match moved {
        Ok(moved) => {
            if moved > 0 {
                emit_event(ctx, EventKind::Moved, old, Some(new));
            }
            moved as usize
        }
        Err(e) => {
            log(&format!("watch: rename {old} -> {new} failed: {}", describe(&e)));
            0
        }
    }
}
