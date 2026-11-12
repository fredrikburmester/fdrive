//! A one-shot result another thread fills in, with callbacks run when it is.

use std::sync::{Arc, Condvar, Mutex};

/// `(ok, skipped)` for one feature of one file.
pub type Outcome = (bool, bool);

type Callback = Box<dyn FnOnce(Outcome) + Send>;

#[derive(Default)]
struct State {
    value: Option<Outcome>,
    callbacks: Vec<Callback>,
}

#[derive(Clone, Default)]
pub struct Promise {
    inner: Arc<(Mutex<State>, Condvar)>,
}

impl Promise {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn resolve(&self, value: Outcome) {
        let callbacks = {
            let mut state = self.inner.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if state.value.is_some() {
                return;
            }
            state.value = Some(value);
            std::mem::take(&mut state.callbacks)
        };
        self.inner.1.notify_all();
        for callback in callbacks {
            callback(value);
        }
    }

    /// Runs `callback` once the value is there, immediately when it already is.
    pub fn on_done(&self, callback: impl FnOnce(Outcome) + Send + 'static) {
        let value = {
            let mut state = self.inner.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match state.value {
                Some(value) => value,
                None => {
                    state.callbacks.push(Box::new(callback));
                    return;
                }
            }
        };
        callback(value);
    }

    pub fn wait(&self) -> Outcome {
        let mut state = self.inner.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        loop {
            if let Some(value) = state.value {
                return value;
            }
            state = self.inner.1.wait(state).unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    pub fn get(&self) -> Option<Outcome> {
        self.inner.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).value
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn callbacks_run_once_before_or_after() {
        let promise = Promise::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let before = Arc::clone(&calls);
        promise.on_done(move |v| {
            assert_eq!(v, (true, false));
            before.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(promise.get(), None);
        let waiter = {
            let promise = promise.clone();
            std::thread::spawn(move || promise.wait())
        };
        promise.resolve((true, false));
        promise.resolve((false, false));
        assert_eq!(waiter.join().unwrap(), (true, false));
        let after = Arc::clone(&calls);
        promise.on_done(move |_| {
            after.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(promise.wait(), (true, false));
    }
}
