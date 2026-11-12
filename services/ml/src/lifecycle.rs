//! The on/off state of each unit, independent of HTTP and of polling.
//!
//! A unit holds one resource: a loaded model, or nothing for extraction.
//! Enabling it loads the resource on another thread; disabling drops it,
//! which frees a model's memory once in-flight requests finish. The status
//! document keeps the shape the bundled runtime controller published, so the
//! API reads it unchanged.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::features::FeatureSnapshot;
use crate::image::ImageEmbedder;
use crate::text::TextEmbedder;

/// The API shows this literal to the owner, so it stays fixed.
pub const RETRIES_EXHAUSTED: &str = "worker exceeded bounded startup retries";

const MAX_ATTEMPTS: u32 = 3;
const RETRY_AFTER: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitKind {
    Text,
    Image,
    Extract,
}

impl UnitKind {
    pub const ALL: [UnitKind; 3] = [UnitKind::Text, UnitKind::Image, UnitKind::Extract];

    /// Also the unit's path prefix.
    pub fn name(self) -> &'static str {
        match self {
            UnitKind::Text => "text",
            UnitKind::Image => "image",
            UnitKind::Extract => "extract",
        }
    }

    /// The owner-facing features that need this unit, sorted. Extraction
    /// feeds every kind of text search, as the Tika container did.
    pub fn features(self) -> &'static [&'static str] {
        match self {
            UnitKind::Text => &["semanticSearch"],
            UnitKind::Image => &["imageSearch"],
            UnitKind::Extract => &["searchOcr", "semanticSearch", "textSearch"],
        }
    }

    pub fn parse(name: &str) -> Option<UnitKind> {
        UnitKind::ALL.into_iter().find(|kind| kind.name() == name)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Off,
    Preparing,
    Ready,
    Failed,
}

/// `GET /<unit>/runtime`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RuntimeStatus {
    pub status: Status,
    pub revision: Option<u64>,
    pub features: &'static [&'static str],
    pub attempts: u32,
    /// Whether a resource is loaded or loading. Named for the controller's
    /// child process, which the API still reads.
    pub child: bool,
    pub error: Option<&'static str>,
}

/// Loads a unit's resource. Blocking; the error is logged, never published.
pub type Loader<R> = Arc<dyn Fn() -> Result<R, String> + Send + Sync>;
/// Runs a load somewhere other than the caller's stack.
pub type Spawner = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

pub fn thread_spawner() -> Spawner {
    Arc::new(|job| {
        std::thread::spawn(job);
    })
}

/// For a unit with nothing to load: it is ready before `enable` returns.
pub fn inline_spawner() -> Spawner {
    Arc::new(|job| job())
}

struct Inner<R> {
    status: Status,
    revision: Option<u64>,
    attempts: u32,
    exhausted_at: Option<Instant>,
    error: Option<&'static str>,
    resource: Option<R>,
    loading: bool,
    /// Bumped on every stop so a load that finishes afterwards is discarded.
    generation: u64,
}

pub struct Unit<R> {
    kind: UnitKind,
    loader: Loader<R>,
    spawner: Spawner,
    inner: Mutex<Inner<R>>,
}

impl<R: Clone + Send + 'static> Unit<R> {
    pub fn new(kind: UnitKind, loader: Loader<R>, spawner: Spawner) -> Arc<Self> {
        Arc::new(Self {
            kind,
            loader,
            spawner,
            inner: Mutex::new(Inner {
                status: Status::Off,
                revision: None,
                attempts: 0,
                exhausted_at: None,
                error: None,
                resource: None,
                loading: false,
                generation: 0,
            }),
        })
    }

    pub fn kind(&self) -> UnitKind {
        self.kind
    }

    /// The feature is on: keep the resource, or start loading it. Called on
    /// every poll, which is also what retries a failed load.
    pub fn enable(self: &Arc<Self>, revision: Option<u64>, now: Instant) {
        let generation = {
            let mut inner = self.lock();
            inner.observe_revision(revision);
            if inner.resource.is_some() {
                inner.status = Status::Ready;
                inner.error = None;
                return;
            }
            if inner.loading {
                return;
            }
            if inner.attempts >= MAX_ATTEMPTS {
                // Bounded retries latch the unit off only for a while. Without
                // this window a model that failed to download during an outage
                // would stay dead until the owner saved settings again.
                let exhausted_at = *inner.exhausted_at.get_or_insert(now);
                if now.duration_since(exhausted_at) < RETRY_AFTER {
                    inner.status = Status::Failed;
                    inner.error = Some(RETRIES_EXHAUSTED);
                    return;
                }
                inner.reset_attempts();
            }
            inner.attempts += 1;
            inner.loading = true;
            inner.status = Status::Preparing;
            inner.error = None;
            inner.generation
        };
        let unit = Arc::clone(self);
        (self.spawner)(Box::new(move || {
            let result = (unit.loader)();
            unit.finish(generation, result);
        }));
    }

    /// The feature is off: drop the resource.
    pub fn disable(&self, revision: Option<u64>) {
        let mut inner = self.lock();
        inner.observe_revision(revision);
        inner.stop(Status::Off, None);
    }

    /// The feature document is gone: drop the resource and say why.
    pub fn fail_closed(&self, reason: &'static str) {
        self.lock().stop(Status::Failed, Some(reason));
    }

    pub fn resource(&self) -> Option<R> {
        self.lock().resource.clone()
    }

    pub fn status(&self) -> RuntimeStatus {
        let inner = self.lock();
        RuntimeStatus {
            status: inner.status,
            revision: inner.revision,
            features: self.kind.features(),
            attempts: inner.attempts,
            child: inner.resource.is_some() || inner.loading,
            error: inner.error,
        }
    }

    fn finish(&self, generation: u64, result: Result<R, String>) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        inner.loading = false;
        match result {
            Ok(resource) => {
                inner.resource = Some(resource);
                inner.status = Status::Ready;
                inner.error = None;
                tracing::info!(unit = self.kind.name(), "ready");
            }
            // Stays `preparing`: the next poll retries or reports exhaustion.
            Err(detail) => tracing::error!(
                unit = self.kind.name(),
                attempt = inner.attempts,
                "load failed: {detail}"
            ),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<R>> {
        // No code path panics while holding the lock, and a poisoned unit
        // must still be able to stop.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl<R> Inner<R> {
    /// A new revision means the owner changed settings, which clears the
    /// retry latch immediately.
    fn observe_revision(&mut self, revision: Option<u64>) {
        if revision != self.revision {
            self.revision = revision;
            self.reset_attempts();
        }
    }

    fn reset_attempts(&mut self) {
        self.attempts = 0;
        self.exhausted_at = None;
        self.error = None;
    }

    fn stop(&mut self, status: Status, error: Option<&'static str>) {
        self.generation += 1;
        self.loading = false;
        self.resource = None;
        self.status = status;
        self.error = error;
    }
}

/// The three units, reconciled together against one feature document.
pub struct Units {
    pub text: Arc<Unit<Arc<dyn TextEmbedder>>>,
    pub image: Arc<Unit<Arc<dyn ImageEmbedder>>>,
    pub extract: Arc<Unit<()>>,
}

impl Units {
    pub fn apply(&self, snapshot: &FeatureSnapshot, now: Instant) {
        let revision = Some(snapshot.revision);
        for kind in UnitKind::ALL {
            if kind.features().iter().any(|feature| snapshot.enabled(feature)) {
                self.enable(kind, revision, now);
            } else {
                match kind {
                    UnitKind::Text => self.text.disable(revision),
                    UnitKind::Image => self.image.disable(revision),
                    UnitKind::Extract => self.extract.disable(revision),
                }
            }
        }
    }

    pub fn enable(&self, kind: UnitKind, revision: Option<u64>, now: Instant) {
        match kind {
            UnitKind::Text => self.text.enable(revision, now),
            UnitKind::Image => self.image.enable(revision, now),
            UnitKind::Extract => self.extract.enable(revision, now),
        }
    }

    pub fn fail_closed(&self, reason: &'static str) {
        self.text.fail_closed(reason);
        self.image.fail_closed(reason);
        self.extract.fail_closed(reason);
    }

    pub fn status(&self, kind: UnitKind) -> RuntimeStatus {
        match kind {
            UnitKind::Text => self.text.status(),
            UnitKind::Image => self.image.status(),
            UnitKind::Extract => self.extract.status(),
        }
    }
}

#[cfg(test)]
pub mod test_support {
    use std::sync::Mutex;

    use super::*;

    type Job = Box<dyn FnOnce() + Send>;

    /// Collects load jobs so a test decides when each one runs.
    #[derive(Clone, Default)]
    pub struct ManualSpawner(Arc<Mutex<Vec<Job>>>);

    impl ManualSpawner {
        pub fn spawner(&self) -> Spawner {
            let jobs = Arc::clone(&self.0);
            Arc::new(move |job| jobs.lock().unwrap().push(job))
        }

        pub fn pending(&self) -> usize {
            self.0.lock().unwrap().len()
        }

        pub fn run_all(&self) {
            let jobs: Vec<Job> = std::mem::take(&mut *self.0.lock().unwrap());
            for job in jobs {
                job();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::test_support::ManualSpawner;
    use super::*;
    use crate::features::{FeatureSnapshot, UNAVAILABLE};

    struct Fixture {
        unit: Arc<Unit<u32>>,
        spawner: ManualSpawner,
        fail: Arc<AtomicBool>,
    }

    fn fixture() -> Fixture {
        let spawner = ManualSpawner::default();
        let fail = Arc::new(AtomicBool::new(false));
        let failing = Arc::clone(&fail);
        let loader: Loader<u32> = Arc::new(move || {
            if failing.load(Ordering::SeqCst) {
                Err("boom".into())
            } else {
                Ok(42)
            }
        });
        Fixture {
            unit: Unit::new(UnitKind::Text, loader, spawner.spawner()),
            spawner,
            fail,
        }
    }

    #[test]
    fn starts_off_with_nothing_loaded() {
        let f = fixture();
        let status = f.unit.status();
        assert_eq!(status.status, Status::Off);
        assert_eq!(status.features, ["semanticSearch"]);
        assert!(!status.child);
        assert_eq!(f.unit.resource(), None);
    }

    #[test]
    fn enabling_loads_once_and_becomes_ready() {
        let f = fixture();
        let now = Instant::now();
        f.unit.enable(Some(1), now);
        // A second poll while the load is in flight must not start another.
        f.unit.enable(Some(1), now);
        assert_eq!(f.spawner.pending(), 1);
        let status = f.unit.status();
        assert_eq!(
            (status.status, status.attempts, status.child),
            (Status::Preparing, 1, true)
        );
        assert_eq!(f.unit.resource(), None);

        f.spawner.run_all();
        assert_eq!(f.unit.resource(), Some(42));
        f.unit.enable(Some(1), now);
        assert_eq!(f.spawner.pending(), 0);
        let status = f.unit.status();
        assert_eq!(
            (status.status, status.revision, status.error),
            (Status::Ready, Some(1), None)
        );
    }

    #[test]
    fn disabling_drops_the_resource() {
        let f = fixture();
        f.unit.enable(Some(1), Instant::now());
        f.spawner.run_all();
        f.unit.disable(Some(2));
        let status = f.unit.status();
        assert_eq!(
            (status.status, status.revision, status.child),
            (Status::Off, Some(2), false)
        );
        assert_eq!(f.unit.resource(), None);
    }

    #[test]
    fn a_load_that_finishes_after_a_stop_is_discarded() {
        let f = fixture();
        f.unit.enable(Some(1), Instant::now());
        f.unit.disable(Some(2));
        f.spawner.run_all();
        assert_eq!(f.unit.resource(), None);
        assert_eq!(f.unit.status().status, Status::Off);
    }

    #[test]
    fn failing_closed_drops_the_resource_and_reports_why() {
        let f = fixture();
        f.unit.enable(Some(1), Instant::now());
        f.spawner.run_all();
        f.unit.fail_closed(UNAVAILABLE);
        let status = f.unit.status();
        assert_eq!((status.status, status.error), (Status::Failed, Some(UNAVAILABLE)));
        assert_eq!(f.unit.resource(), None);

        // The document coming back restarts the unit and clears the reason.
        f.unit.enable(Some(1), Instant::now());
        f.spawner.run_all();
        let status = f.unit.status();
        assert_eq!((status.status, status.error), (Status::Ready, None));
    }

    #[test]
    fn failed_loads_retry_a_bounded_number_of_times() {
        let f = fixture();
        f.fail.store(true, Ordering::SeqCst);
        let start = Instant::now();
        for attempt in 1..=3 {
            f.unit.enable(Some(1), start);
            assert_eq!(f.unit.status().attempts, attempt);
            f.spawner.run_all();
            assert_eq!(f.unit.status().status, Status::Preparing);
        }
        f.unit.enable(Some(1), start);
        assert_eq!(f.spawner.pending(), 0);
        let status = f.unit.status();
        assert_eq!(
            (status.status, status.error, status.child),
            (Status::Failed, Some(RETRIES_EXHAUSTED), false)
        );

        // Still latched just before the window ends, retried once it has.
        f.unit.enable(Some(1), start + RETRY_AFTER - Duration::from_secs(1));
        assert_eq!(f.spawner.pending(), 0);
        f.fail.store(false, Ordering::SeqCst);
        f.unit.enable(Some(1), start + RETRY_AFTER);
        assert_eq!(f.unit.status().attempts, 1);
        f.spawner.run_all();
        assert_eq!(f.unit.status().status, Status::Ready);
    }

    #[test]
    fn a_new_revision_clears_the_retry_latch() {
        let f = fixture();
        f.fail.store(true, Ordering::SeqCst);
        let now = Instant::now();
        for _ in 0..3 {
            f.unit.enable(Some(1), now);
            f.spawner.run_all();
        }
        f.unit.enable(Some(1), now);
        assert_eq!(f.unit.status().status, Status::Failed);

        f.unit.enable(Some(2), now);
        let status = f.unit.status();
        assert_eq!(
            (status.status, status.attempts, status.error),
            (Status::Preparing, 1, None)
        );
    }

    #[test]
    fn the_inline_spawner_is_ready_before_enable_returns() {
        let unit = Unit::new(UnitKind::Extract, Arc::new(|| Ok(())), inline_spawner());
        unit.enable(Some(3), Instant::now());
        assert_eq!(unit.status().status, Status::Ready);
        assert_eq!(unit.kind(), UnitKind::Extract);
    }

    #[test]
    fn the_thread_spawner_runs_the_job() {
        let (sender, receiver) = std::sync::mpsc::channel();
        thread_spawner()(Box::new(move || sender.send(7).unwrap()));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok(7));
    }

    #[test]
    fn status_serializes_in_the_controller_shape() {
        let f = fixture();
        f.unit.enable(Some(4), Instant::now());
        f.spawner.run_all();
        assert_eq!(
            serde_json::to_value(f.unit.status()).unwrap(),
            serde_json::json!({
                "status": "ready",
                "revision": 4,
                "features": ["semanticSearch"],
                "attempts": 1,
                "child": true,
                "error": null
            })
        );
    }

    #[test]
    fn unit_names_round_trip() {
        for kind in UnitKind::ALL {
            assert_eq!(UnitKind::parse(kind.name()), Some(kind));
            let mut sorted = kind.features().to_vec();
            sorted.sort_unstable();
            assert_eq!(sorted, kind.features());
        }
        assert_eq!(UnitKind::parse("ocr"), None);
    }

    #[test]
    fn units_follow_the_feature_document() {
        let units = crate::http::test_support::units();
        let now = Instant::now();
        units.apply(&FeatureSnapshot::for_test(1, &["textSearch"]), now);
        assert_eq!(units.status(UnitKind::Extract).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Text).status, Status::Off);
        assert_eq!(units.status(UnitKind::Image).status, Status::Off);

        units.apply(&FeatureSnapshot::for_test(2, &["semanticSearch", "imageSearch"]), now);
        assert_eq!(units.status(UnitKind::Extract).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Text).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Image).status, Status::Ready);

        units.apply(&FeatureSnapshot::for_test(3, &["thumbnails", "pdfOcr"]), now);
        for kind in UnitKind::ALL {
            assert_eq!(units.status(kind).status, Status::Off);
            assert_eq!(units.status(kind).revision, Some(3));
        }

        units.fail_closed(UNAVAILABLE);
        for kind in UnitKind::ALL {
            assert_eq!(units.status(kind).error, Some(UNAVAILABLE));
        }
    }
}
