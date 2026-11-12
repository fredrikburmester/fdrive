//! Progress records for background maintenance passes. Every pass shares one admission
//! lock, so only one heavy pass runs at a time across the process.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use crate::events::iso_now;

#[derive(Default)]
struct JobState {
    running: bool,
    processed: u64,
    total: u64,
    started_at: Option<String>,
    finished_at: Option<String>,
    errors: u64,
    skipped: u64,
    total_known: bool,
    outcome: Option<&'static str>,
    revision: i64,
    run_id: String,
}

pub struct Job {
    state: Mutex<JobState>,
    admission: Arc<AtomicBool>,
}

impl Job {
    pub fn new(admission: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self { state: Mutex::default(), admission })
    }

    fn lock(&self) -> MutexGuard<'_, JobState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claim the shared admission and reset for a new run; false when anything is running.
    pub fn try_start(&self, revision: i64) -> bool {
        if self.admission.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return false;
        }
        *self.lock() = JobState {
            running: true,
            started_at: Some(iso_now()),
            revision,
            run_id: uuid::Uuid::new_v4().to_string(),
            ..JobState::default()
        };
        true
    }

    pub fn run_id(&self) -> String {
        self.lock().run_id.clone()
    }

    pub fn advance(&self, ok: bool, skipped: bool) {
        let mut s = self.lock();
        s.processed += 1;
        s.skipped += u64::from(skipped);
        s.errors += u64::from(!ok);
    }

    pub fn discover(&self, count: u64) {
        self.lock().total += count;
    }

    pub fn discovered(&self) {
        self.lock().total_known = true;
    }

    pub fn fail(&self) {
        let mut s = self.lock();
        s.errors += 1;
        s.outcome = Some("failed");
    }

    pub fn finish(&self) {
        let mut s = self.lock();
        if !s.running {
            return;
        }
        s.running = false;
        s.outcome = s.outcome.or(Some(if s.errors > 0 {
            "failed"
        } else if s.total_known && s.processed < s.total {
            "stopped"
        } else {
            "completed"
        }));
        s.finished_at = Some(iso_now());
        self.admission.store(false, Ordering::SeqCst);
    }

    pub fn snapshot(&self) -> Value {
        let s = self.lock();
        json!({
            "running": s.running, "processed": s.processed, "total": s.total, "total_known": s.total_known,
            "started_at": s.started_at, "finished_at": s.finished_at, "errors": s.errors, "outcome": s.outcome,
        })
    }

    pub fn activity_snapshot(&self, kind: &str, features: &[&str]) -> Option<Value> {
        let s = self.lock();
        let started_at = s.started_at.as_ref()?;
        Some(json!({
            "id": s.run_id, "kind": kind, "features": features, "revision": s.revision,
            "state": if s.running { "running" } else { s.outcome.unwrap_or("completed") },
            "phase": if s.total_known || s.processed > 0 { "processing" } else { "discovering" },
            "processed": s.processed, "total": if s.total_known { Some(s.total) } else { None },
            "errors": s.errors, "skipped": s.skipped,
            "unit": if kind.ends_with("Clear") { "entries" } else { "files" },
            "startedAt": started_at, "finishedAt": s.finished_at,
        }))
    }
}

/// Start `run` on its own thread once admitted. `run` must not call `finish`; this does.
pub fn spawn(job: &Arc<Job>, revision: i64, name: &str, run: impl FnOnce(&Arc<Job>) + Send + 'static) -> bool {
    if !job.try_start(revision) {
        return false;
    }
    let thread_job = Arc::clone(job);
    let started = std::thread::Builder::new().name(name.to_owned()).spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(&thread_job)));
        if outcome.is_err() {
            thread_job.fail();
            crate::log::log(&format!("{} crashed", std::thread::current().name().unwrap_or("job")));
        }
        thread_job.finish();
    });
    if started.is_err() {
        job.fail();
        job.finish();
    }
    started.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_is_shared_and_released() {
        let admission = Arc::new(AtomicBool::new(false));
        let (a, b) = (Job::new(Arc::clone(&admission)), Job::new(Arc::clone(&admission)));
        assert_eq!(a.snapshot()["outcome"], Value::Null);
        assert_eq!(a.snapshot()["total_known"], false);
        assert!(a.activity_snapshot("thumbnailRebuild", &["thumbnails"]).is_none());
        assert!(a.try_start(3));
        assert!(!b.try_start(3));
        assert!(!a.try_start(3));
        a.discover(2);
        assert_eq!(a.activity_snapshot("indexClear", &[]).unwrap()["phase"], "discovering");
        a.discovered();
        a.advance(true, true);
        let snap = a.activity_snapshot("indexClear", &["textSearch"]).unwrap();
        assert_eq!((snap["unit"].as_str(), snap["total"].as_u64(), snap["state"].as_str()), (Some("entries"), Some(2), Some("running")));
        a.finish();
        assert_eq!(a.snapshot()["outcome"], "stopped");
        a.finish();
        assert!(b.try_start(1));
        b.advance(false, false);
        b.finish();
        assert_eq!(b.snapshot()["outcome"], "failed");
        assert!(a.try_start(1));
        a.finish();
        assert_eq!(a.snapshot()["outcome"], "completed");
        assert_eq!(a.activity_snapshot("imageRebuild", &[]).unwrap()["unit"], "files");
    }

    #[test]
    fn spawned_runs_release_even_after_a_panic() {
        let admission = Arc::new(AtomicBool::new(false));
        let job = Job::new(Arc::clone(&admission));
        assert!(spawn(&job, 0, "test-job", |_| panic!("boom")));
        while job.snapshot()["running"] == true {
            std::thread::yield_now();
        }
        assert_eq!(job.snapshot()["outcome"], "failed");
        assert!(!admission.load(Ordering::SeqCst));
        assert!(spawn(&job, 0, "test-job", |job| job.advance(true, false)));
        while job.snapshot()["running"] == true {
            std::thread::yield_now();
        }
        assert_eq!(job.snapshot()["outcome"], "completed");
        assert!(!job.run_id().is_empty());
    }
}
