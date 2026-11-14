//! Start-up and the per-root loop: refresh settings and features, keep the watcher in step
//! with them, and scan on the interval, on a wake, or after a watcher overflow.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::config::Config;
use crate::db::{self, Db};
use crate::failures::FileResult;
use crate::indexer::{
    FileStat, RootContext, scan_once, watch_folder, watch_index, watch_mark_deleted, watch_rename, work_features,
};
use crate::log::log;
use crate::paths::ext_of;
use crate::server::Wake;
use crate::settings;
use crate::watcher::{WatchHandler, Watcher};

pub const EXPECTED_SCHEMA_VERSION: i64 = 2;

pub fn build_context(cfg: &Arc<Config>, name: &str, path: &Path) -> Result<Arc<RootContext>> {
    let db = Db::new(&cfg.database_url);
    let (root_id, raw) = db.with(|c| Ok((db::upsert_root(c, name)?, db::read_settings(c)?)))?;
    // A restart is not a feature transition: start from the persisted selection.
    let mut ctx = RootContext::new(
        name,
        root_id,
        path.to_path_buf(),
        Arc::clone(cfg),
        crate::features::resolve(&raw),
    );
    ctx.refresh_features = Some(cfg.settings_refresh);
    if !ctx.values().search_ocr {
        let moved = db.with(|c| db::mark_pdfs_skipped_by_ocr(c, root_id))?;
        if moved > 0 {
            log(&format!(
                "[{name}] {moved} PDFs without a text layer will be read once OCR is enabled"
            ));
        }
    }
    Ok(Arc::new(ctx))
}

/// Re-read settings and features; true when anything changed.
pub fn refresh_settings(ctx: &RootContext) -> Result<bool> {
    let raw = ctx.db.with(db::read_settings)?;
    let changed = ctx.set_settings(settings::resolve(&raw, &ctx.cfg.default_settings()));
    if !changed.is_empty() {
        log(&format!("[{}] settings changed: {}", ctx.name, changed.join(", ")));
    }
    let features_changed = ctx.set_features(crate::features::resolve(&raw));
    Ok(!changed.is_empty() || features_changed)
}

/// The watcher's callbacks into the indexer, reporting live activity per feature.
pub struct Handler(pub Arc<RootContext>);

impl WatchHandler for Handler {
    fn index_file(&self, abs: &Path, rel: &str, metadata: &std::fs::Metadata) -> FileResult {
        watch_index(&self.0, abs, rel, FileStat::of(metadata))
    }

    fn mark_deleted(&self, rel: &str, is_dir: bool) -> usize {
        if !self.0.files_folder_verified() {
            return 0;
        }
        watch_mark_deleted(&self.0, rel, is_dir)
    }

    fn rename(&self, old_rel: &str, new_rel: &str, is_dir: bool) -> usize {
        if !self.0.files_folder_verified() {
            return 0;
        }
        watch_rename(&self.0, old_rel, new_rel, is_dir)
    }

    fn folder_changed(&self, rel: &str) {
        if !self.0.files_folder_verified() {
            return;
        }
        watch_folder(&self.0, rel);
    }

    fn on_queue(&self, abs: &Path) -> Box<dyn FnOnce(&FileResult) + Send> {
        let ctx = Arc::clone(&self.0);
        let configuration = ctx.features();
        let ext = ext_of(&abs.to_string_lossy());
        let operations = ctx.activity.start_watch(
            &work_features(&configuration.values, Some(&ext), false, false),
            configuration.revision,
        );
        Box::new(move |result: &FileResult| {
            let (deferred, done): (Vec<_>, Vec<_>) = operations
                .into_iter()
                .partition(|op| result.deferred.contains_key(op.feature()));
            ctx.activity
                .finish_watch(&done, result.status != "error", result.outcomes.as_ref());
            for op in deferred {
                if let Some(promise) = result.deferred.get(op.feature()) {
                    let ctx = Arc::clone(&ctx);
                    promise.on_done(move |outcome| {
                        let outcomes = [(op.feature().to_owned(), outcome)].into_iter().collect();
                        ctx.activity.finish_watch(&[Arc::clone(&op)], true, Some(&outcomes));
                    });
                }
            }
        })
    }

    fn log(&self, message: &str) {
        log(message);
    }
}

pub fn start_watcher(ctx: &Arc<RootContext>) -> Option<Watcher> {
    if !ctx.cfg.watch {
        return None;
    }
    let watcher = Watcher::new(
        ctx.abs_path.clone(),
        Arc::new(Handler(Arc::clone(ctx))),
        ctx.settings().workers.max(1),
        ctx.cfg.watch_debounce,
    )
    .and_then(|watcher| watcher.start().map(|()| watcher));
    match watcher {
        Ok(watcher) => {
            log(&format!(
                "[{}] watching {} directories for changes (debounce {}s)",
                ctx.name,
                watcher.dirs(),
                ctx.cfg.watch_debounce.as_secs_f64()
            ));
            Some(watcher)
        }
        Err(e) => {
            log(&format!(
                "[{}] watcher unavailable ({e}); relying on periodic scans only",
                ctx.name
            ));
            None
        }
    }
}

/// One root's loop state: the watcher it keeps in step with the features, and when the
/// next scan is due.
pub struct RootLoop {
    watcher: Option<Watcher>,
    next_scan: Instant,
}

impl Default for RootLoop {
    fn default() -> Self {
        Self {
            watcher: None,
            next_scan: Instant::now(),
        }
    }
}

impl RootLoop {
    /// Refresh settings, keep the watcher in step with the features, and scan when due.
    /// Returns how long to wait before the next step.
    pub fn step(&mut self, ctx: &Arc<RootContext>, watchers: &Mutex<HashMap<String, bool>>) -> Duration {
        let step = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<()> {
            if refresh_settings(ctx)? {
                self.next_scan = Instant::now();
            }
            // A folder without this installation's marker is neither watched nor scanned; a
            // due scan waits and runs as soon as the folder is right.
            let verified = ctx.files_folder_verified();
            let enabled = ctx.values().indexer_enabled() && verified;
            if enabled && self.watcher.is_none() {
                self.watcher = start_watcher(ctx);
            } else if !enabled && let Some(stopped) = self.watcher.take() {
                stopped.stop();
            }
            watchers
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(ctx.name.clone(), self.watcher.is_some());
            let overflowed = self.watcher.as_ref().is_some_and(Watcher::take_overflow);
            if verified && (Instant::now() >= self.next_scan || overflowed) {
                scan_once(ctx);
                self.next_scan = Instant::now() + Duration::from_secs(ctx.settings().scan_interval_seconds);
            }
            Ok(())
        }));
        if !matches!(step, Ok(Ok(()))) {
            let reason = match step {
                Ok(Err(e)) => crate::failures::describe(&e),
                _ => "panic".to_owned(),
            };
            log(&format!("[{}] scan crashed: {reason}", ctx.name));
            self.next_scan = Instant::now() + ctx.cfg.settings_refresh;
        }
        // Feature selection is polled quickly even with a long scan interval.
        self.next_scan
            .saturating_duration_since(Instant::now())
            .min(ctx.cfg.settings_refresh)
    }

    /// Scan at the next step.
    pub fn wake(&mut self) {
        self.next_scan = Instant::now();
    }

    pub fn has_watcher(&self) -> bool {
        self.watcher.is_some()
    }
}

/// One root's loop; never returns.
pub fn run_root(ctx: &Arc<RootContext>, watchers: &Mutex<HashMap<String, bool>>, wake: &Wake) {
    let mut root = RootLoop::default();
    loop {
        let timeout = root.step(ctx, watchers);
        if wake.wait(timeout) {
            root.wake();
        }
    }
}
