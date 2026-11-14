//! The changes the indexer journals itself: what its watcher applies and what a scan finds,
//! against a real filesystem and Postgres.

mod common;

use std::sync::Arc;

use common::root_env::{Env, fv};
use fdrive_indexer::db::{self, NewChange};
use fdrive_indexer::features::FeatureValues;
use fdrive_indexer::indexer::{RootContext, scan_once};
use fdrive_indexer::journal::{self, Source};
use fdrive_indexer::runner::Handler;
use fdrive_indexer::watcher::WatchHandler;

fn text() -> FeatureValues {
    fv(false, true, false, false, false)
}

/// `(path, target, source)` of every journal row, in order.
fn journal(env: &Env) -> Vec<(String, Option<String>, String)> {
    env.client()
        .query(
            r#"SELECT path, target_path, source FROM "idx"."changes" ORDER BY id"#,
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect()
}

/// The journal rows written since `from` rows were there, as sorted `path` or `path -> target`.
fn since(env: &Env, from: usize) -> Vec<String> {
    let mut rows: Vec<String> = journal(env)
        .into_iter()
        .skip(from)
        .map(|(path, target, source)| {
            assert_eq!(source, "scan");
            target.map_or(path.clone(), |target| format!("{path} -> {target}"))
        })
        .collect();
    rows.sort();
    rows
}

fn watched(path: &str) -> (String, Option<String>, String) {
    (path.to_owned(), None, "watcher".to_owned())
}

fn index(handler: &Handler, env: &Env, rel: &str) -> String {
    let path = env.path(rel);
    handler
        .index_file(&path, rel, &std::fs::metadata(&path).unwrap())
        .status
}

// -- the watcher ---------------------------------------------------------------------------

#[test]
fn a_file_the_watcher_indexes_is_journaled_once_per_version() {
    let env = Env::new();
    let ctx = env.ctx(text());
    let handler = Handler(Arc::clone(&ctx));
    env.write("a.txt", b"hello");
    assert_eq!(index(&handler, &env, "a.txt"), "indexed");
    // Seen again unchanged: the index already has it, so nothing changed.
    assert_eq!(index(&handler, &env, "a.txt"), "unchanged");
    assert_eq!(journal(&env), [watched("a.txt")]);
    env.write("a.txt", b"hello again");
    assert_eq!(index(&handler, &env, "a.txt"), "indexed");
    assert_eq!(journal(&env), [watched("a.txt"), watched("a.txt")]);
}

#[test]
fn a_delete_the_watcher_applies_is_journaled_when_rows_went() {
    let env = Env::new();
    let ctx = env.ctx(text());
    let handler = Handler(Arc::clone(&ctx));
    env.write("a.txt", b"hello");
    index(&handler, &env, "a.txt");
    std::fs::remove_file(env.path("a.txt")).unwrap();
    assert_eq!(handler.mark_deleted("a.txt", false), 1);
    assert_eq!(handler.mark_deleted("a.txt", false), 0);
    assert_eq!(journal(&env), [watched("a.txt"), watched("a.txt")]);
    // An empty folder has no file rows, but its going is a change.
    std::fs::create_dir_all(env.path("empty")).unwrap();
    handler.folder_changed("empty");
    std::fs::remove_dir(env.path("empty")).unwrap();
    assert_eq!(handler.mark_deleted("empty", true), 0);
    assert_eq!(journal(&env)[2..], [watched("empty"), watched("empty")]);
}

#[test]
fn new_folders_the_watcher_records_are_journaled_once() {
    let env = Env::new();
    let ctx = env.ctx(text());
    let handler = Handler(Arc::clone(&ctx));
    std::fs::create_dir_all(env.path("alice/new/inner")).unwrap();
    handler.folder_changed("alice/new");
    assert_eq!(
        journal(&env),
        [watched("alice"), watched("alice/new"), watched("alice/new/inner")]
    );
    handler.folder_changed("alice/new");
    assert_eq!(journal(&env).len(), 3);
    // A folder below it that is gone is dropped and journaled.
    std::fs::remove_dir(env.path("alice/new/inner")).unwrap();
    handler.folder_changed("alice/new");
    assert_eq!(journal(&env)[3..], [watched("alice/new/inner")]);
}

#[test]
fn a_move_the_watcher_pairs_is_journaled_as_a_move() {
    let env = Env::new();
    let ctx = env.ctx(text());
    let handler = Handler(Arc::clone(&ctx));
    env.write("d/a.txt", b"hello");
    index(&handler, &env, "d/a.txt");
    handler.folder_changed("d");
    let from = journal(&env).len();
    std::fs::rename(env.path("d"), env.path("e")).unwrap();
    assert_eq!(handler.rename("d", "e", true), 1);
    // An empty folder moves only its folder rows; that is a move too.
    std::fs::create_dir_all(env.path("empty")).unwrap();
    handler.folder_changed("empty");
    std::fs::rename(env.path("empty"), env.path("moved")).unwrap();
    assert_eq!(handler.rename("empty", "moved", true), 0);
    // Nothing indexed at the old path: no move, the new path is looked at instead.
    assert_eq!(handler.rename("never", "seen", false), 0);
    let moved = |from: &str, to: &str| (from.to_owned(), Some(to.to_owned()), "watcher".to_owned());
    assert_eq!(
        journal(&env)[from..],
        [moved("d", "e"), watched("empty"), moved("empty", "moved")]
    );
    // A new extension is a delete of the old name; the new one is indexed as new.
    std::fs::rename(env.path("e/a.txt"), env.path("e/a.md")).unwrap();
    assert_eq!(handler.rename("e/a.txt", "e/a.md", false), 0);
    assert_eq!(journal(&env).last(), Some(&watched("e/a.txt")));
}

#[test]
fn outside_a_source_nothing_is_journaled() {
    let env = Env::new();
    let ctx = env.ctx(text());
    let (path, stat) = env.write("a.txt", b"hello");
    // The journal's reader and maintenance call these without a source.
    fdrive_indexer::indexer::watch_index(&ctx, &path, "a.txt", stat);
    fdrive_indexer::indexer::watch_rename(&ctx, "a.txt", "b.txt", false);
    fdrive_indexer::indexer::watch_mark_deleted(&ctx, "b.txt", false);
    std::fs::create_dir_all(env.path("d")).unwrap();
    fdrive_indexer::indexer::watch_folder(&ctx, "d");
    assert!(journal(&env).is_empty());
}

#[test]
fn a_journal_that_cannot_be_written_is_logged_and_left() {
    let env = Env::new();
    let ctx = common::root_env::context_with(env.config(), text(), |ctx| {
        ctx.db = db::Db {
            url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
            retries: 1,
        };
    });
    journal::record_as(&ctx, Source::Watcher, &[NewChange::path("a.txt")]);
    journal::with_source(Some(Source::Scan), || {
        journal::record(&ctx, vec![NewChange::path("b.txt")])
    });
    journal::record_as(&ctx, Source::Watcher, &[]);
    assert!(journal(&env).is_empty());
}

// -- scans ---------------------------------------------------------------------------------

/// A root scanned once, so the next scan has a baseline: `keep.txt`, `change.txt`,
/// `gone.txt`, `d/in.txt` and the folders `d`, `d/sub` and `old`.
fn scanned(env: &Env) -> Arc<RootContext> {
    let ctx = env.ctx(text());
    env.write("keep.txt", b"keep");
    env.write("change.txt", b"before");
    env.write("gone.txt", b"gone");
    env.write("d/in.txt", b"inside");
    std::fs::create_dir_all(env.path("d/sub")).unwrap();
    std::fs::create_dir_all(env.path("old")).unwrap();
    let first = scan_once(&ctx);
    assert_eq!((first.seen, first.changed, first.errors), (4, 4, 0));
    ctx
}

#[test]
fn the_first_scan_of_an_empty_index_journals_nothing() {
    let env = Env::new();
    let _ctx = scanned(&env);
    assert!(journal(&env).is_empty());
}

#[test]
fn a_scan_journals_what_changed_since_the_last_one() {
    let env = Env::new();
    let ctx = scanned(&env);
    env.write("new.txt", b"new");
    env.write("change.txt", b"after, and longer");
    std::fs::remove_file(env.path("gone.txt")).unwrap();
    std::fs::remove_dir(env.path("old")).unwrap();
    std::fs::create_dir_all(env.path("empty")).unwrap();
    env.write("fresh/x.txt", b"x");
    let second = scan_once(&ctx);
    assert_eq!((second.changed, second.deleted), (3, 1));
    assert_eq!(
        since(&env, 0),
        [
            "change.txt",
            "empty",
            "fresh",
            "fresh/x.txt",
            "gone.txt",
            "new.txt",
            "old"
        ]
    );
    // Nothing changed: nothing journaled.
    scan_once(&ctx);
    assert_eq!(journal(&env).len(), 7);
}

#[test]
fn a_reindex_is_no_change() {
    let env = Env::new();
    let ctx = scanned(&env);
    db::mark_pending(&mut env.client(), ctx.root_id, None).unwrap();
    assert_eq!(scan_once(&ctx).changed, 4);
    assert!(journal(&env).is_empty());
}

#[test]
fn a_scan_after_an_interrupted_first_one_journals_nothing() {
    let env = Env::new();
    let ctx = env.ctx(text());
    // A first scan that stopped part way: rows, but no finished scan.
    env.write("a.txt", b"one");
    env.seed(&ctx, "a.txt", &common::root_env::fake_sha('a'), "indexed");
    db::start_scan(&mut env.client(), ctx.root_id).unwrap();
    env.write("b.txt", b"two");
    assert_eq!(scan_once(&ctx).changed, 1);
    assert!(journal(&env).is_empty());
    // That one finished: the next is compared with it.
    env.write("c.txt", b"three");
    scan_once(&ctx);
    assert_eq!(since(&env, 0), ["c.txt"]);
}

#[test]
fn a_scan_after_the_index_was_cleared_journals_nothing() {
    let env = Env::new();
    let ctx = scanned(&env);
    env.client().execute(r#"DELETE FROM "idx"."files""#, &[]).unwrap();
    assert_eq!(scan_once(&ctx).changed, 4);
    assert!(journal(&env).is_empty());
}

#[test]
fn folders_are_journaled_only_against_folder_rows() {
    let env = Env::new();
    let ctx = scanned(&env);
    // As after an upgrade from before folder rows: files have a baseline, folders none.
    env.client().execute(r#"DELETE FROM "idx"."folders""#, &[]).unwrap();
    env.write("fresh/x.txt", b"x");
    scan_once(&ctx);
    assert_eq!(since(&env, 0), ["fresh/x.txt"]);
    assert_eq!(env.folders(&ctx).len(), 4);
}
