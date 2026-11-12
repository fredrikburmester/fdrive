//! Per-path locks so the watcher, a scan and maintenance passes never interleave writes
//! for one file. A lock on a directory also waits for every path below it.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

#[derive(Default)]
struct Entry {
    active: bool,
    users: usize,
}

#[derive(Default)]
pub struct PathLocks {
    entries: Mutex<HashMap<String, Entry>>,
    changed: Condvar,
}

fn overlaps(a: &str, b: &str) -> bool {
    a == b || a.is_empty() || b.is_empty() || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

pub struct Guard<'a> {
    locks: &'a PathLocks,
    keys: Vec<String>,
}

impl PathLocks {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn get(&self, key: &str) -> Guard<'_> {
        self.get_many(&[key])
    }

    pub fn get_many(&self, keys: &[&str]) -> Guard<'_> {
        let mut keys: Vec<String> = keys.iter().map(|k| k.trim_matches('/').to_owned()).collect();
        keys.sort();
        keys.dedup();
        let mut entries = self.lock();
        for key in &keys {
            entries.entry(key.clone()).or_default().users += 1;
        }
        while entries
            .iter()
            .any(|(held, entry)| entry.active && keys.iter().any(|key| overlaps(key, held)))
        {
            entries = self.changed.wait(entries).unwrap_or_else(PoisonError::into_inner);
        }
        for key in &keys {
            if let Some(entry) = entries.get_mut(key) {
                entry.active = true;
            }
        }
        Guard { locks: self, keys }
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }
}

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        let mut entries = self.locks.lock();
        for key in &self.keys {
            if let Some(entry) = entries.get_mut(key) {
                entry.active = false;
                entry.users -= 1;
                if entry.users == 0 {
                    entries.remove(key);
                }
            }
        }
        drop(entries);
        self.locks.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::*;

    #[test]
    fn entries_are_dropped_when_unused() {
        let locks = PathLocks::default();
        for i in 0..1000 {
            let _guard = locks.get(&format!("k{i}"));
        }
        assert!(locks.is_empty());
        let _a = locks.get("a");
        let _b = locks.get("b");
        assert!(!locks.is_empty());
    }

    #[test]
    fn a_parent_waits_for_a_child() {
        let locks = Arc::new(PathLocks::default());
        let child = locks.get("docs/a.txt");
        let acquired = Arc::new(AtomicBool::new(false));
        let handle = {
            let (locks, acquired) = (Arc::clone(&locks), Arc::clone(&acquired));
            std::thread::spawn(move || {
                let _parent = locks.get_many(&["docs", "other"]);
                acquired.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        assert!(!acquired.load(Ordering::SeqCst));
        let _unrelated = locks.get("elsewhere");
        drop(child);
        handle.join().unwrap();
        assert!(acquired.load(Ordering::SeqCst));
        drop(_unrelated);
        assert!(locks.is_empty());
        assert!(overlaps("", "x") && overlaps("a", "a/b") && !overlaps("a", "ab"));
    }
}
