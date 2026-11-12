//! A pause for an embedding backend that went away: one log line per outage instead of
//! one per file, and a bounded number of probes while it is down.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_PAUSE: Duration = Duration::from_secs(60);

pub struct Backoff {
    pause: Duration,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
    resume_at: Mutex<Option<Instant>>,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new(DEFAULT_PAUSE, Box::new(Instant::now))
    }
}

impl Backoff {
    pub fn new(pause: Duration, clock: Box<dyn Fn() -> Instant + Send + Sync>) -> Self {
        Self { pause, clock, resume_at: Mutex::new(None) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, Option<Instant>> {
        self.resume_at.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A failed backend stays pending until a retry actually succeeds.
    pub fn waiting(&self) -> bool {
        self.state().is_some()
    }

    pub fn paused(&self) -> bool {
        let now = (self.clock)();
        self.state().is_some_and(|at| now < at)
    }

    /// Pause; true only for the first failure of an outage.
    pub fn note_failure(&self) -> bool {
        let now = (self.clock)();
        let mut state = self.state();
        let first = state.is_none();
        *state = Some(now + self.pause);
        first
    }

    /// Clear the pause; true only when this ends an outage.
    pub fn note_success(&self) -> bool {
        self.state().take().is_some()
    }
}

/// Whether an HTTP failure means the backend is absent rather than rejecting one payload.
pub fn is_outage(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause.downcast_ref::<reqwest::Error>().is_some_and(|e| e.is_connect() || e.is_timeout() || e.is_request())
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    #[test]
    fn logs_once_per_outage() {
        let base = Instant::now();
        let offset = Arc::new(AtomicU64::new(0));
        let clock = Arc::clone(&offset);
        let backoff =
            Backoff::new(Duration::from_secs(60), Box::new(move || base + Duration::from_secs(clock.load(Ordering::SeqCst))));
        assert!(!backoff.paused() && !backoff.waiting());
        assert!(backoff.note_failure());
        assert!(!backoff.note_failure());
        assert!(backoff.paused() && backoff.waiting());
        offset.store(59, Ordering::SeqCst);
        assert!(backoff.paused());
        offset.store(60, Ordering::SeqCst);
        assert!(!backoff.paused() && backoff.waiting());
        assert!(!backoff.note_failure(), "a failed re-probe extends the pause silently");
        assert!(backoff.paused());
        assert!(backoff.note_success());
        assert!(!backoff.note_success());
        assert!(backoff.note_failure(), "a later outage reports again");
        assert!(Backoff::default().note_failure());
    }

    #[test]
    fn transport_errors_are_outages() {
        let refused = reqwest::blocking::Client::new().get("http://127.0.0.1:1/").send().unwrap_err();
        assert!(is_outage(&anyhow::Error::new(refused)));
        assert!(!is_outage(&anyhow::anyhow!("413 payload too large")));
    }
}
