//! Durable per-file diagnostics in `idx.processing_failures`, and the per-attempt record
//! of each feature's outcome. Recording a failure must never fail processing.

use std::cell::RefCell;
use std::collections::HashMap;

use crate::db::Db;
use crate::log::log;
use crate::promise::{Outcome, Promise};

pub const FEATURES: [&str; 4] = ["thumbnails", "textSearch", "semanticSearch", "imageSearch"];

/// What happened to each feature of one file while an attempt was open.
#[derive(Debug, Clone, Default)]
pub struct Attempt {
    pub id: String,
    pub operation_ids: HashMap<String, String>,
    pub outcomes: HashMap<String, Outcome>,
    /// Features handed to another thread, resolving to their outcome when done.
    pub deferred: HashMap<String, Promise>,
}

impl std::fmt::Debug for Promise {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Promise({:?})", self.get())
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Attempt>> = const { RefCell::new(None) };
}

struct Reset(bool);

impl Drop for Reset {
    fn drop(&mut self) {
        if self.0 {
            CURRENT.with(|c| c.borrow_mut().take());
        }
    }
}

/// Run `work` inside an attempt and return what it observed. A nested call joins the
/// attempt already open on this thread.
pub fn attempt<R>(operation_ids: HashMap<String, String>, work: impl FnOnce() -> R) -> (R, Attempt) {
    let opened = CURRENT.with(|c| {
        let mut current = c.borrow_mut();
        if current.is_some() {
            return false;
        }
        *current = Some(Attempt { id: uuid::Uuid::new_v4().to_string(), operation_ids, ..Attempt::default() });
        true
    });
    let reset = Reset(opened);
    let result = work();
    let observed = CURRENT.with(|c| c.borrow().clone()).unwrap_or_default();
    drop(reset);
    (result, observed)
}

pub fn current_operation_id(feature: &str) -> Option<String> {
    CURRENT.with(|c| c.borrow().as_ref().map(|a| a.operation_ids.get(feature).cloned().unwrap_or_else(|| a.id.clone())))
}

pub fn in_attempt() -> bool {
    CURRENT.with(|c| c.borrow().is_some())
}

pub fn defer(feature: &str, promise: Promise) {
    CURRENT.with(|c| {
        if let Some(a) = c.borrow_mut().as_mut() {
            a.deferred.insert(feature.to_owned(), promise);
        }
    });
}

/// The message stored for an error: the whole cause chain, capped at 2,000 characters.
pub fn describe(error: &anyhow::Error) -> String {
    format!("{error:#}").chars().take(2000).collect()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Report<'a> {
    pub error: Option<&'a str>,
    pub skipped: bool,
    /// A skip that read the file and found nothing to process settles earlier failures.
    pub resolves: bool,
}

pub fn ok() -> Report<'static> {
    Report::default()
}

pub fn failed(error: &str) -> Report<'_> {
    Report { error: Some(error), ..Report::default() }
}

pub fn skipped() -> Report<'static> {
    Report { skipped: true, ..Report::default() }
}

pub fn resolving_skip() -> Report<'static> {
    Report { skipped: true, resolves: true, ..Report::default() }
}

pub fn report(db: &Db, root_id: i64, path: &str, feature: &str, report: Report<'_>) {
    let operation_id = CURRENT.with(|c| {
        let mut current = c.borrow_mut();
        current.as_mut().map(|a| {
            a.outcomes.insert(feature.to_owned(), (report.skipped || report.error.is_none(), report.skipped));
            a.operation_ids.get(feature).cloned().unwrap_or_else(|| a.id.clone())
        })
    });
    if report.skipped && !report.resolves {
        return; // A dependency wait or skipped attempt is not evidence of recovery.
    }
    let operation_id = operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let written = db.with(|c| {
        match report.error {
            None => c.execute(
                "UPDATE idx.processing_failures SET resolved_at = now() \
                 WHERE root_id = $1::bigint AND path = $2 AND feature = $3 AND resolved_at IS NULL",
                &[&root_id, &path, &feature],
            )?,
            Some(error) => {
                let code: String = error.split(':').next().unwrap_or(error).chars().take(100).collect();
                let message: String = error.chars().take(2000).collect();
                c.execute(
                    "INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id) \
                     VALUES ($1::bigint, $2, $3, $4, $5, $6) ON CONFLICT (root_id, path, feature) DO UPDATE SET \
                     code = EXCLUDED.code, message = EXCLUDED.message, operation_id = EXCLUDED.operation_id, \
                     attempts = CASE WHEN processing_failures.resolved_at IS NULL \
                       THEN processing_failures.attempts + 1 ELSE 1 END, \
                     first_failed_at = CASE WHEN processing_failures.resolved_at IS NULL \
                       THEN processing_failures.first_failed_at ELSE now() END, \
                     last_failed_at = now(), resolved_at = NULL",
                    &[&root_id, &path, &feature, &code, &message, &operation_id],
                )?
            }
        };
        Ok(())
    });
    if let Err(error) = written {
        log(&format!(
            "failure history unavailable for {feature} {path}: {}; result: {}",
            describe(&error),
            report.error.unwrap_or("resolved")
        ));
    }
}

/// Keep unresolved issues, resolve those of deleted files, and keep at most 30 days or
/// 10,000 resolved records.
pub fn prune(db: &Db) -> anyhow::Result<()> {
    db.with(|c| {
        c.execute(
            "UPDATE idx.processing_failures p SET resolved_at = now() FROM idx.files f \
             WHERE p.root_id = f.root_id AND p.path = f.path AND f.deleted_at IS NOT NULL AND p.resolved_at IS NULL",
            &[],
        )?;
        c.execute(
            "DELETE FROM idx.processing_failures WHERE resolved_at < now() - interval '30 days' \
             OR id IN (SELECT id FROM idx.processing_failures WHERE resolved_at IS NOT NULL \
             ORDER BY resolved_at DESC, id DESC OFFSET 10000)",
            &[],
        )?;
        Ok(())
    })
}

/// What one watcher or scan job reports back: its status and every feature's outcome.
#[derive(Debug, Clone)]
pub struct FileResult {
    pub status: String,
    pub outcomes: Option<HashMap<String, Outcome>>,
    pub deferred: HashMap<String, Promise>,
}

impl FileResult {
    pub fn plain(status: &str) -> Self {
        Self { status: status.to_owned(), outcomes: None, deferred: HashMap::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_attempts_share_one_record() {
        assert!(!in_attempt());
        let ids: HashMap<String, String> = [("thumbnails".to_owned(), "op-1".to_owned())].into_iter().collect();
        let db = Db { url: "postgres://invalid@127.0.0.1:1/x".into(), retries: 1 };
        let (_, observed) = attempt(ids, || {
            assert_eq!(current_operation_id("thumbnails").as_deref(), Some("op-1"));
            let (_, inner) = attempt(HashMap::new(), || {
                report(&db, 1, "a", "imageSearch", skipped());
                defer("semanticSearch", Promise::new());
            });
            assert!(inner.outcomes.contains_key("imageSearch"));
            assert!(current_operation_id("textSearch").is_some());
        });
        assert_eq!(observed.outcomes["imageSearch"], (true, true));
        assert!(observed.deferred.contains_key("semanticSearch"));
        assert!(!in_attempt());
        assert_eq!(current_operation_id("x"), None);
        defer("ignored", Promise::new());
        report(&db, 1, "a", "thumbnails", failed("boom: bad"));
        assert!(format!("{:?}", Promise::new()).contains("None"));
    }

    #[test]
    fn descriptions_are_capped() {
        let error = anyhow::anyhow!("{}", "x".repeat(3000)).context("decoding");
        let text = describe(&error);
        assert!(text.starts_with("decoding: x"));
        assert_eq!(text.chars().count(), 2000);
        assert_eq!(FileResult::plain("error").status, "error");
        assert!(resolving_skip().resolves && ok().error.is_none());
    }
}
