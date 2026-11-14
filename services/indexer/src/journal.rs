//! The change journal's writing side in the indexer. `idx.changes` is one numbered record of
//! every change to a root, which fdrive's parts read from their own position instead of each
//! finding changes on its own (docs/plans/CHANGE-JOURNAL.md). The API and OCR journal the
//! changes they make; the indexer journals the changes made outside fdrive that it applies:
//! what the watcher sees and what a scan finds. It journals a change once the index has it,
//! and only under the source of the thread applying it, so the journal's own reader, which
//! runs without one, never writes a row for a row it read.

use std::cell::Cell;

use crate::db::{self, NewChange};
use crate::failures::describe;
use crate::indexer::RootContext;
use crate::log::log;

/// Who wrote a journal row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// fdrive's API, for a change it made.
    Api,
    /// The indexer's watcher, for a change made on the disk directly.
    Watcher,
    /// The indexer's scan, for a difference between the disk and the index.
    Scan,
    /// The OCR worker, for a PDF it rewrote.
    Ocr,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Watcher => "watcher",
            Self::Scan => "scan",
            Self::Ocr => "ocr",
        }
    }

    pub fn parse(source: &str) -> Option<Self> {
        match source {
            "api" => Some(Self::Api),
            "watcher" => Some(Self::Watcher),
            "scan" => Some(Self::Scan),
            "ocr" => Some(Self::Ocr),
            _ => None,
        }
    }

    /// Rows the indexer wrote itself, after it had applied the change they describe.
    pub fn is_indexers(self) -> bool {
        matches!(self, Self::Watcher | Self::Scan)
    }
}

thread_local! {
    static SOURCE: Cell<Option<Source>> = const { Cell::new(None) };
}

/// Run `work` with the changes it applies journaled as `source`; `None` journals nothing.
pub fn with_source<R>(source: Option<Source>, work: impl FnOnce() -> R) -> R {
    struct Restore(Option<Source>);
    impl Drop for Restore {
        fn drop(&mut self) {
            SOURCE.with(|s| s.set(self.0));
        }
    }
    let _restore = Restore(SOURCE.with(|s| s.replace(source)));
    work()
}

/// The source changes applied on this thread are journaled as, if any.
pub fn current() -> Option<Source> {
    SOURCE.with(Cell::get)
}

/// Journal `changes`, which the index has just taken in, as this thread's source; nothing
/// outside one.
pub fn record(ctx: &RootContext, changes: Vec<NewChange>) {
    if let Some(source) = current() {
        record_as(ctx, source, &changes);
    }
}

/// Journal `changes` as `source`. A failure is logged, never raised: the change is in the
/// index, and the journal only misses telling other readers about it.
pub fn record_as(ctx: &RootContext, source: Source, changes: &[NewChange]) {
    if changes.is_empty() {
        return;
    }
    let appended = ctx
        .db
        .with(|c| db::append_changes(c, ctx.root_id, &ctx.name, source.as_str(), changes));
    if let Err(e) = appended {
        log(&format!(
            "[{}] journal: cannot record {} {} change(s): {}",
            ctx.name,
            changes.len(),
            source.as_str(),
            describe(&e)
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_round_trip_and_only_the_indexers_own_are_its() {
        for source in [Source::Api, Source::Watcher, Source::Scan, Source::Ocr] {
            assert_eq!(Source::parse(source.as_str()), Some(source));
        }
        assert_eq!(Source::parse("web"), None);
        assert!(Source::Watcher.is_indexers() && Source::Scan.is_indexers());
        assert!(!Source::Api.is_indexers() && !Source::Ocr.is_indexers());
    }

    #[test]
    fn a_source_holds_for_its_scope_and_nests() {
        assert_eq!(current(), None);
        with_source(Some(Source::Scan), || {
            assert_eq!(current(), Some(Source::Scan));
            with_source(None, || assert_eq!(current(), None));
            assert_eq!(current(), Some(Source::Scan));
        });
        assert_eq!(current(), None);
        let caught = std::panic::catch_unwind(|| with_source(Some(Source::Watcher), || panic!("boom")));
        assert!(caught.is_err());
        assert_eq!(current(), None, "a panic restores the outer source");
    }
}
