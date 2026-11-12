//! The loops that keep the units in line with what the owner switched on.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use crate::features::{FeatureSource, FetchError, Gate, Verdict};
use crate::lifecycle::{UnitKind, Units};

/// Polls the feature document forever and reconciles the units against it.
pub async fn follow<S: FeatureSource>(source: S, units: Arc<Units>, poll: Duration, mut gate: Gate) {
    // Logged on change only: a poll every few seconds would otherwise bury
    // everything else an outage writes.
    let mut last_error: Option<FetchError> = None;
    loop {
        let result = source.fetch().await;
        let error = result.as_ref().err().cloned();
        if error != last_error {
            match &error {
                Some(FetchError::Unreachable(detail)) => tracing::warn!("feature endpoint unreachable: {detail}"),
                Some(FetchError::Invalid(detail)) => tracing::warn!("feature document rejected: {detail}"),
                None => tracing::info!("feature document is available again"),
            }
            last_error = error;
        }
        // Tokio's clock, so the grace windows are testable with paused time.
        let now = Instant::now().into_std();
        match gate.observe(result, now) {
            Verdict::Apply(snapshot) => units.apply(&snapshot, now),
            Verdict::FailClosed(reason) => units.fail_closed(reason),
            Verdict::Hold => {}
        }
        tokio::time::sleep(poll).await;
    }
}

/// Development mode: keeps `kinds` on with no feature document. Re-enabling
/// on an interval is what retries a model that failed to load.
pub async fn keep_enabled(units: Arc<Units>, kinds: Vec<UnitKind>, poll: Duration) {
    loop {
        for kind in &kinds {
            units.enable(*kind, None, Instant::now().into_std());
        }
        tokio::time::sleep(poll).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use super::*;
    use crate::features::{FeatureSnapshot, UNAVAILABLE, UNREACHABLE};
    use crate::http::test_support::units;
    use crate::lifecycle::Status;

    /// Answers each poll with the next scripted result, repeating the last.
    struct Scripted(Mutex<VecDeque<Result<FeatureSnapshot, FetchError>>>);

    impl Scripted {
        fn new(results: Vec<Result<FeatureSnapshot, FetchError>>) -> Self {
            Self(Mutex::new(results.into()))
        }
    }

    impl FeatureSource for Scripted {
        async fn fetch(&self) -> Result<FeatureSnapshot, FetchError> {
            let mut results = self.0.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results[0].clone()
            }
        }
    }

    const POLL: Duration = Duration::from_secs(3);

    fn gate() -> Gate {
        Gate::new(Duration::from_secs(9), Duration::from_secs(60))
    }

    /// Lets the spawned loop finish its next iteration.
    async fn next_poll() {
        tokio::time::sleep(POLL + Duration::from_millis(1)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn follows_the_document_and_fails_closed_when_it_goes_bad() {
        let units = units();
        let source = Scripted::new(vec![
            Ok(FeatureSnapshot::for_test(1, &["semanticSearch"])),
            Ok(FeatureSnapshot::for_test(2, &["imageSearch"])),
            Err(FetchError::Invalid("feature endpoint returned 401".into())),
        ]);
        let task = tokio::spawn(follow(source, Arc::clone(&units), POLL, gate()));

        tokio::task::yield_now().await;
        assert_eq!(units.status(UnitKind::Text).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Image).status, Status::Off);

        next_poll().await;
        assert_eq!(units.status(UnitKind::Text).status, Status::Off);
        assert_eq!(units.status(UnitKind::Image).status, Status::Ready);

        // Rejected documents are tolerated for the stale window, then stop everything.
        next_poll().await;
        assert_eq!(units.status(UnitKind::Image).status, Status::Ready);
        tokio::time::sleep(Duration::from_secs(9)).await;
        let image = units.status(UnitKind::Image);
        assert_eq!((image.status, image.error), (Status::Failed, Some(UNAVAILABLE)));
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn an_unreachable_endpoint_gets_the_longer_window() {
        let units = units();
        let source = Scripted::new(vec![
            Ok(FeatureSnapshot::for_test(1, &["textSearch"])),
            Err(FetchError::Unreachable("timeout".into())),
        ]);
        let task = tokio::spawn(follow(source, Arc::clone(&units), POLL, gate()));

        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(units.status(UnitKind::Extract).status, Status::Ready);
        tokio::time::sleep(Duration::from_secs(33)).await;
        let extract = units.status(UnitKind::Extract);
        assert_eq!((extract.status, extract.error), (Status::Failed, Some(UNREACHABLE)));
        task.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn static_units_come_up_without_a_document() {
        let units = units();
        let task = tokio::spawn(keep_enabled(
            Arc::clone(&units),
            vec![UnitKind::Text, UnitKind::Extract],
            POLL,
        ));
        tokio::task::yield_now().await;
        assert_eq!(units.status(UnitKind::Text).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Extract).status, Status::Ready);
        assert_eq!(units.status(UnitKind::Image).status, Status::Off);
        assert_eq!(units.status(UnitKind::Text).revision, None);
        task.abort();
    }
}
