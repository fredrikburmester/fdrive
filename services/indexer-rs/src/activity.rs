//! Bounded, thread-safe live work counters. Reading them never touches storage.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use crate::events::iso_now;

#[derive(Debug)]
struct OperationState {
    phase: &'static str,
    state: String,
    processed: u64,
    scheduled: u64,
    total: Option<u64>,
    errors: u64,
    skipped: u64,
    finished_at: Option<String>,
}

/// One unit of reported work: a scan, watcher changes, or a queued reindex, for one feature.
#[derive(Debug)]
pub struct Operation {
    pub id: String,
    pub kind: &'static str,
    pub features: Vec<String>,
    pub revision: i64,
    started_at: String,
    state: Mutex<OperationState>,
}

pub type Op = Arc<Operation>;

impl Operation {
    pub fn new(kind: &'static str, features: Vec<String>, revision: i64, phase: &'static str) -> Op {
        Arc::new(Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            features,
            revision,
            started_at: iso_now(),
            state: Mutex::new(OperationState {
                phase,
                state: "running".to_owned(),
                processed: 0,
                scheduled: 0,
                total: None,
                errors: 0,
                skipped: 0,
                finished_at: None,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, OperationState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn feature(&self) -> &str {
        self.features.first().map_or("", String::as_str)
    }

    pub fn enqueue(&self) {
        self.lock().scheduled += 1;
    }

    pub fn advance(&self, ok: bool, skipped: bool) {
        let mut s = self.lock();
        s.processed += 1;
        s.errors += u64::from(!ok);
        s.skipped += u64::from(skipped);
    }

    pub fn discovered(&self) {
        let mut s = self.lock();
        s.total = Some(s.scheduled);
        s.phase = "processing";
    }

    pub fn finish(&self, state: &str) {
        let mut s = self.lock();
        s.state = if state == "completed" && s.errors > 0 { "failed".to_owned() } else { state.to_owned() };
        s.finished_at = Some(iso_now());
    }

    pub fn errors(&self) -> u64 {
        self.lock().errors
    }

    pub fn counts(&self) -> (String, u64, u64) {
        let s = self.lock();
        (s.state.clone(), s.processed, s.scheduled)
    }

    fn is_active(&self) -> bool {
        matches!(self.lock().state.as_str(), "running" | "waiting")
    }

    pub fn snapshot(&self) -> Value {
        let s = self.lock();
        json!({
            "id": self.id, "kind": self.kind, "features": self.features, "revision": self.revision,
            "state": s.state, "phase": s.phase, "processed": s.processed, "total": s.total,
            "errors": s.errors, "skipped": s.skipped, "unit": "files",
            "startedAt": self.started_at, "finishedAt": s.finished_at,
        })
    }
}

#[derive(Default)]
struct RootState {
    scan: Vec<Op>,
    watch: HashMap<String, Op>,
    queued: Option<Op>,
}

/// One scan per root and one aggregate of concurrent watcher work per feature.
#[derive(Default)]
pub struct RootActivity {
    state: Mutex<RootState>,
}

impl RootActivity {
    fn lock(&self) -> MutexGuard<'_, RootState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn queue_scan(&self, features: Vec<String>, revision: i64) {
        let mut s = self.lock();
        if s.queued.is_none() {
            s.queued = Some(Operation::new("reindex", features, revision, "queued"));
        }
    }

    pub fn stop_queued(&self) {
        self.lock().queued = None;
    }

    pub fn start_scan(&self, features: &[String], revision: i64) -> HashMap<String, Op> {
        let mut s = self.lock();
        s.queued = None;
        s.scan = features.iter().map(|f| Operation::new("scan", vec![f.clone()], revision, "discovering")).collect();
        s.scan.iter().map(|op| (op.feature().to_owned(), Arc::clone(op))).collect()
    }

    pub fn start_watch(&self, features: &[String], revision: i64) -> Vec<Op> {
        let mut s = self.lock();
        features
            .iter()
            .map(|feature| {
                let op = match s.watch.get(feature) {
                    Some(op) if op.is_active() => Arc::clone(op),
                    _ => {
                        let op = Operation::new("watch", vec![feature.clone()], revision, "processing");
                        s.watch.insert(feature.clone(), Arc::clone(&op));
                        op
                    }
                };
                op.enqueue();
                op
            })
            .collect()
    }

    /// Advance each operation by the file's outcome for its feature; finish it once every
    /// scheduled file has reported.
    pub fn finish_watch(&self, operations: &[Op], ok: bool, outcomes: Option<&HashMap<String, (bool, bool)>>) {
        let _guard = self.lock();
        for op in operations {
            let (result, skipped) =
                outcomes.and_then(|o| o.get(op.feature()).copied()).unwrap_or((ok, outcomes.is_some()));
            op.advance(result, skipped);
            let (_, processed, scheduled) = op.counts();
            if processed == scheduled {
                op.finish("completed");
            }
        }
    }

    pub fn snapshot(&self) -> Vec<Value> {
        let s = self.lock();
        s.scan.iter().chain(s.watch.values()).chain(s.queued.iter()).map(|op| op.snapshot()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn features(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn scans_report_totals_after_discovery() {
        let activity = RootActivity::default();
        activity.queue_scan(features(&["textSearch"]), 1);
        activity.queue_scan(features(&["thumbnails"]), 1);
        assert_eq!(activity.snapshot().len(), 1);
        let ops = activity.start_scan(&features(&["textSearch", "thumbnails"]), 2);
        let text = &ops["textSearch"];
        text.enqueue();
        assert_eq!(text.snapshot()["total"], Value::Null);
        text.discovered();
        text.advance(true, false);
        text.finish("completed");
        let snap = text.snapshot();
        assert_eq!((snap["total"].as_u64(), snap["state"].as_str()), (Some(1), Some("completed")));
        assert_eq!(snap["phase"], "processing");
        ops["thumbnails"].advance(false, false);
        ops["thumbnails"].finish("completed");
        assert_eq!(ops["thumbnails"].snapshot()["state"], "failed");
        assert_eq!(activity.snapshot().len(), 2);
        activity.queue_scan(features(&["x"]), 1);
        activity.stop_queued();
        assert_eq!(activity.snapshot().len(), 2);
    }

    #[test]
    fn watch_operations_are_shared_until_done() {
        let activity = RootActivity::default();
        let a = activity.start_watch(&features(&["thumbnails"]), 1);
        let b = activity.start_watch(&features(&["thumbnails"]), 1);
        assert_eq!(a[0].id, b[0].id);
        activity.finish_watch(&a, true, None);
        assert_eq!(a[0].snapshot()["state"], "running");
        let outcomes: HashMap<String, (bool, bool)> = [("thumbnails".to_owned(), (false, false))].into_iter().collect();
        activity.finish_watch(&b, true, Some(&outcomes));
        assert_eq!(a[0].snapshot()["state"], "failed");
        let c = activity.start_watch(&features(&["thumbnails"]), 1);
        assert_ne!(c[0].id, a[0].id);
        let empty = HashMap::new();
        activity.finish_watch(&c, true, Some(&empty));
        assert_eq!(c[0].snapshot()["skipped"], 1);
    }

    #[test]
    fn concurrent_finishes_lose_nothing() {
        let activity = Arc::new(RootActivity::default());
        let ops: Vec<Vec<Op>> = (0..100).map(|_| activity.start_watch(&features(&["textSearch"]), 1)).collect();
        let handles: Vec<_> = ops
            .chunks(13)
            .map(|chunk| {
                let activity = Arc::clone(&activity);
                let chunk = chunk.to_vec();
                std::thread::spawn(move || chunk.iter().for_each(|op| activity.finish_watch(op, true, None)))
            })
            .collect();
        handles.into_iter().for_each(|h| h.join().unwrap());
        let snap = ops[0][0].snapshot();
        assert_eq!((snap["processed"].as_u64(), snap["state"].as_str()), (Some(100), Some("completed")));
    }
}
