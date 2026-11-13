//! Changes the API queues in `idx.work`, applied against a real filesystem, Postgres and a
//! fake `ml` server.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::fake_ml::TEXT_EMBED;
use common::root_env::{Env, OFF, fv, wait_until};
use fdrive_indexer::db::{self, WorkRow};
use fdrive_indexer::indexer::{ContentHint, Embedded, FOREGROUND_WAIT_LIMIT, RootContext, Stage, embed_chunks};
use fdrive_indexer::work::{Applier, Change, Entry, WorkLoop, clean_path, entry, parse};

const WAIT: Duration = Duration::from_secs(10);

fn hex_sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn text_on() -> fdrive_indexer::features::FeatureValues {
    fv(false, true, false, true, false)
}

/// What the API records for an upload: `(sha256, size, mtime_ns, inode, ctime_ns)`.
type Hint<'a> = (&'a str, i64, i64, i64, i64);

/// The hint the API would send for the file at `rel` as it is now.
fn hint_for<'a>(env: &Env, rel: &str, sha: &'a str) -> Hint<'a> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(env.path(rel)).unwrap();
    (
        sha,
        m.size() as i64,
        m.mtime() * 1_000_000_000 + m.mtime_nsec(),
        m.ino() as i64,
        m.ctime() * 1_000_000_000 + m.ctime_nsec(),
    )
}

/// Queue a row the way the API does, notification included.
fn queue(env: &Env, ctx: &RootContext, path: &str, target: Option<&str>, hint: Option<Hint<'_>>) {
    queue_on(&mut env.client(), ctx, path, target, hint);
}

fn queue_on(c: &mut postgres::Client, ctx: &RootContext, path: &str, target: Option<&str>, hint: Option<Hint<'_>>) {
    let (sha, size, mtime, inode, ctime) = match hint {
        Some((sha, size, mtime, inode, ctime)) => (Some(sha), Some(size), Some(mtime), Some(inode), Some(ctime)),
        None => (None, None, None, None, None),
    };
    let root_id = i16::try_from(ctx.root_id).unwrap();
    c.execute(
        r#"INSERT INTO "idx"."work" (root_id, path, target_path, sha256, size, mtime_ns, inode, ctime_ns)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
        &[&root_id, &path, &target, &sha, &size, &mtime, &inode, &ctime],
    )
    .unwrap();
    c.execute("SELECT pg_notify('idx_work', 'r')", &[]).unwrap();
}

fn queued(env: &Env) -> i64 {
    env.count("idx.work")
}

fn live_paths(env: &Env, ctx: &RootContext) -> Vec<String> {
    let mut paths: Vec<String> = env
        .client()
        .query(
            r#"SELECT path FROM "idx"."files" WHERE root_id = $1::bigint AND deleted_at IS NULL"#,
            &[&ctx.root_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    paths.sort();
    paths
}

fn drain(ctx: &Arc<RootContext>) -> usize {
    Applier::new(Arc::clone(ctx)).drain().unwrap()
}

/// Wait for the text stage to finish a file's embeddings.
fn indexed(env: &Env, ctx: &RootContext, rel: &str) -> bool {
    wait_until(WAIT, || env.status(ctx, rel) == "indexed")
}

fn row(path: &str, target: Option<&str>, sha: Option<&str>, size: Option<i64>, mtime: Option<i64>) -> WorkRow {
    WorkRow {
        id: 1,
        path: path.to_owned(),
        target_path: target.map(str::to_owned),
        sha256: sha.map(str::to_owned),
        size,
        mtime_ns: mtime,
        inode: sha.map(|_| -5),
        ctime_ns: sha.map(|_| 11),
    }
}

// -- parsing -------------------------------------------------------------------------------

#[test]
fn paths_are_cleaned_and_traversal_is_refused() {
    assert_eq!(clean_path("alice/a.txt").as_deref(), Some("alice/a.txt"));
    assert_eq!(clean_path("/alice/docs/").as_deref(), Some("alice/docs"));
    for bad in ["", "/", "a//b", "a/../b", "./a", "a\\b", "a/\u{7}"] {
        assert_eq!(clean_path(bad), None, "{bad:?}");
    }
}

#[test]
fn rows_parse_to_changes_and_hints_need_every_column() {
    let sha = "a".repeat(64);
    assert_eq!(
        parse(&row("a.txt", None, Some(&sha), Some(3), Some(9))),
        Some(Change::Path {
            path: "a.txt".to_owned(),
            hint: Some(ContentHint {
                sha256: sha.clone(),
                size: 3,
                mtime_ns: 9,
                // The stored bits of an inode number past the signed range.
                inode: u64::MAX - 4,
                ctime_ns: 11
            })
        })
    );
    // Without the inode or the change time, a digest proves nothing.
    for missing in [
        WorkRow {
            inode: None,
            ..row("a.txt", None, Some(&sha), Some(3), Some(9))
        },
        WorkRow {
            ctime_ns: None,
            ..row("a.txt", None, Some(&sha), Some(3), Some(9))
        },
    ] {
        assert_eq!(
            parse(&missing),
            Some(Change::Path {
                path: "a.txt".to_owned(),
                hint: None
            })
        );
    }
    // A partial hint, a malformed digest or a negative size is no hint.
    for (sha, size, mtime) in [
        (Some(sha.as_str()), None, Some(9)),
        (Some("not-a-digest"), Some(3), Some(9)),
        (Some(&"A".repeat(64)), Some(3), Some(9)),
        (Some(&"../".repeat(21)), Some(3), Some(9)),
        (Some(sha.as_str()), Some(-1), Some(9)),
    ] {
        assert_eq!(
            parse(&row("a.txt", None, sha, size, mtime)),
            Some(Change::Path {
                path: "a.txt".to_owned(),
                hint: None
            })
        );
    }
    assert_eq!(
        parse(&row("a", Some("b/c"), None, None, None)),
        Some(Change::Moved {
            from: "a".to_owned(),
            to: "b/c".to_owned()
        })
    );
    assert_eq!(parse(&row("../a", None, None, None, None)), None);
    assert_eq!(parse(&row("a", Some("../b"), None, None, None)), None);
}

// -- what is on disk -----------------------------------------------------------------------

#[test]
fn entries_are_judged_like_the_walk() {
    let env = Env::new();
    let (_, stat) = env.write("d/a.txt", b"hello");
    env.write(".git/x.txt", b"hidden");
    env.write("d/.DS_Store", b"junk");
    std::fs::create_dir_all(env.path("node_modules")).unwrap();
    std::os::unix::fs::symlink(env.path("d"), env.path("link")).unwrap();
    std::os::unix::fs::symlink(env.path("d/a.txt"), env.path("file-link")).unwrap();
    assert_eq!(entry(&env.root, "d/a.txt"), Entry::File(stat));
    assert_eq!(entry(&env.root, "d"), Entry::Dir);
    for gone in [
        "missing.txt",
        "d/a.txt/below",
        ".git/x.txt",
        "d/.DS_Store",
        "node_modules",
        "link",
        "link/a.txt",
        "file-link",
        "d/.fdrive-partial-0123456789abcdef",
        "../escape",
    ] {
        assert_eq!(entry(&env.root, gone), Entry::Gone, "{gone}");
    }
    // The root itself is never a queued path.
    assert_eq!(entry(&env.root, ""), Entry::Unknown);
}

// -- applying changes ----------------------------------------------------------------------

#[test]
fn an_upload_is_indexed_with_the_digest_the_api_sent() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("alice/a.txt", b"hello world");
    // A digest the file does not have proves the file was not hashed again.
    let claimed = "b".repeat(64);
    queue(
        &env,
        &ctx,
        "alice/a.txt",
        None,
        Some(hint_for(&env, "alice/a.txt", &claimed)),
    );
    assert_eq!(drain(&ctx), 1);
    assert_eq!(queued(&env), 0);
    assert_eq!(env.row(&ctx, "alice/a.txt").sha256.as_deref(), Some(claimed.as_str()));
    assert!(indexed(&env, &ctx, "alice/a.txt"));
    assert_eq!(env.events(), ["created"]);
}

#[test]
fn a_hint_for_another_file_is_ignored() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    let claimed = "b".repeat(64);
    let (sha, size, mtime, inode, ctime) = hint_for(&env, "a.txt", &claimed);
    // A client sets the time but not the inode or change time: an upload of other bytes
    // with the same size and time, or a later change to this file, is not what was hinted.
    for hint in [
        (sha, size, mtime + 1, inode, ctime),
        (sha, size, mtime, inode + 1, ctime),
        (sha, size, mtime, inode, ctime + 1),
    ] {
        env.client().execute("DELETE FROM idx.files", &[]).unwrap();
        queue(&env, &ctx, "a.txt", None, Some(hint));
        drain(&ctx);
        assert_eq!(env.row(&ctx, "a.txt").sha256, Some(hex_sha(b"hello world")));
    }
}

#[test]
fn a_file_that_is_already_indexed_is_left_alone() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    assert!(indexed(&env, &ctx, "a.txt"));
    let embedded = env.ml.count(TEXT_EMBED);
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    assert_eq!(env.ml.count(TEXT_EMBED), embedded);
    assert_eq!(env.events(), ["created"]);
}

#[test]
fn a_deleted_file_or_folder_loses_its_rows() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"one");
    env.write("d/b.txt", b"two");
    env.write("d/e/c.txt", b"three");
    queue(&env, &ctx, "a.txt", None, None);
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["a.txt", "d/b.txt", "d/e/c.txt"]);
    std::fs::remove_file(env.path("a.txt")).unwrap();
    std::fs::remove_dir_all(env.path("d")).unwrap();
    queue(&env, &ctx, "a.txt", None, None);
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert!(live_paths(&env, &ctx).is_empty());
    assert_eq!(env.count("idx.chunks"), 0);
    assert_eq!(env.events(), ["created", "created", "created", "deleted", "deleted"]);
}

#[test]
fn a_moved_file_keeps_its_row_without_being_read_again() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    assert!(indexed(&env, &ctx, "a.txt"));
    let id = env.row(&ctx, "a.txt");
    let embedded = env.ml.count(TEXT_EMBED);
    std::fs::rename(env.path("a.txt"), env.path("b.txt")).unwrap();
    queue(&env, &ctx, "a.txt", Some("b.txt"), None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["b.txt"]);
    assert_eq!(env.row(&ctx, "b.txt").sha256, id.sha256);
    assert_eq!(env.status(&ctx, "b.txt"), "indexed");
    assert_eq!(env.ml.count(TEXT_EMBED), embedded);
    assert_eq!(env.events(), ["created", "moved"]);
    assert_eq!(env.count("idx.moves"), 1);
}

#[test]
fn a_moved_folder_moves_its_rows_and_matches_the_disk() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("d/a.txt", b"one");
    env.write("d/s/b.txt", b"two");
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    // A stale row where the folder lands is replaced by what the move brings.
    env.write("e/old.txt", b"stale");
    queue(&env, &ctx, "e", None, None);
    drain(&ctx);
    std::fs::remove_dir_all(env.path("e")).unwrap();
    std::fs::rename(env.path("d"), env.path("e")).unwrap();
    queue(&env, &ctx, "d", Some("e"), None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["e/a.txt", "e/s/b.txt"]);
}

#[test]
fn a_file_moved_out_of_sight_is_deleted_and_one_moved_back_is_indexed() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    std::fs::create_dir_all(env.path("node_modules")).unwrap();
    std::fs::rename(env.path("a.txt"), env.path("node_modules/a.txt")).unwrap();
    queue(&env, &ctx, "a.txt", Some("node_modules/a.txt"), None);
    drain(&ctx);
    assert!(live_paths(&env, &ctx).is_empty());
    std::fs::rename(env.path("node_modules/a.txt"), env.path("b.txt")).unwrap();
    queue(&env, &ctx, "node_modules/a.txt", Some("b.txt"), None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["b.txt"]);
}

#[test]
fn a_renamed_extension_is_indexed_as_a_new_file() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    std::fs::rename(env.path("a.txt"), env.path("a.md")).unwrap();
    queue(&env, &ctx, "a.txt", Some("a.md"), None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["a.md"]);
    assert_eq!(env.events()[1..], ["deleted", "created"]);
}

#[test]
fn a_folder_is_compared_with_its_rows() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("d/a.txt", b"one");
    env.write("d/b.txt", b"two");
    env.write("d/.git/c.txt", b"hidden");
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["d/a.txt", "d/b.txt"]);
    std::fs::remove_file(env.path("d/a.txt")).unwrap();
    env.write("d/c.txt", b"three");
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["d/b.txt", "d/c.txt"]);
}

fn folder_paths(env: &Env, ctx: &RootContext) -> Vec<String> {
    env.folders(ctx).into_iter().map(|(path, _)| path).collect()
}

#[test]
fn a_new_folder_is_recorded_with_the_folders_above_and_in_it() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    std::fs::create_dir_all(env.path("alice/Microlärande")).unwrap();
    queue(&env, &ctx, "alice/Microlärande", None, None);
    drain(&ctx);
    assert_eq!(
        env.folders(&ctx),
        [
            ("alice".to_owned(), "alice".to_owned()),
            ("alice/Microlärande".to_owned(), "Microlärande".to_owned())
        ]
    );
    env.write("alice/d/s/a.txt", b"one");
    std::fs::create_dir_all(env.path("alice/d/.git/objects")).unwrap();
    queue(&env, &ctx, "alice/d", None, None);
    drain(&ctx);
    assert_eq!(
        folder_paths(&env, &ctx),
        ["alice", "alice/Microlärande", "alice/d", "alice/d/s"]
    );
}

#[test]
fn an_upload_records_the_folders_it_landed_in() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("alice/new/deeper/a.txt", b"one");
    queue(&env, &ctx, "alice/new/deeper/a.txt", None, None);
    drain(&ctx);
    assert_eq!(folder_paths(&env, &ctx), ["alice", "alice/new", "alice/new/deeper"]);
    // A top-level file has no folder above it.
    env.write("top.txt", b"two");
    queue(&env, &ctx, "top.txt", None, None);
    drain(&ctx);
    assert_eq!(folder_paths(&env, &ctx), ["alice", "alice/new", "alice/new/deeper"]);
}

#[test]
fn folders_that_are_gone_lose_their_rows() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    std::fs::create_dir_all(env.path("d/s/t")).unwrap();
    std::fs::create_dir_all(env.path("d/u")).unwrap();
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert_eq!(folder_paths(&env, &ctx), ["d", "d/s", "d/s/t", "d/u"]);
    // Comparing a folder with the disk drops what is gone below it.
    std::fs::remove_dir_all(env.path("d/s")).unwrap();
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert_eq!(folder_paths(&env, &ctx), ["d", "d/u"]);
    // A deleted folder takes its rows and those below it.
    std::fs::remove_dir_all(env.path("d")).unwrap();
    queue(&env, &ctx, "d", None, None);
    drain(&ctx);
    assert!(folder_paths(&env, &ctx).is_empty());
}

#[test]
fn a_moved_folder_takes_its_folder_rows_along() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    std::fs::create_dir_all(env.path("old/empty")).unwrap();
    env.write("old/s/a.txt", b"one");
    std::fs::create_dir_all(env.path("new/s")).unwrap();
    queue(&env, &ctx, "old", None, None);
    queue(&env, &ctx, "new", None, None);
    drain(&ctx);
    std::fs::remove_dir_all(env.path("new")).unwrap();
    std::fs::rename(env.path("old"), env.path("new")).unwrap();
    queue(&env, &ctx, "old", Some("new"), None);
    drain(&ctx);
    assert_eq!(
        env.folders(&ctx),
        [
            ("new".to_owned(), "new".to_owned()),
            ("new/empty".to_owned(), "empty".to_owned()),
            ("new/s".to_owned(), "s".to_owned())
        ]
    );
    assert_eq!(live_paths(&env, &ctx), ["new/s/a.txt"]);
}

#[test]
fn while_indexing_is_off_no_folder_is_recorded() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    std::fs::create_dir_all(env.path("d")).unwrap();
    fdrive_indexer::indexer::watch_folder(&ctx, "d");
    fdrive_indexer::indexer::record_folders(&ctx, &fdrive_indexer::indexer::folder_chain(&env.path(""), "d"), None);
    assert!(env.folders(&ctx).is_empty());
}

#[test]
fn a_file_replaced_by_a_folder_loses_its_row() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("x", b"a file");
    queue(&env, &ctx, "x", None, None);
    drain(&ctx);
    std::fs::remove_file(env.path("x")).unwrap();
    env.write("x/inner.txt", b"now a folder");
    queue(&env, &ctx, "x", None, None);
    drain(&ctx);
    assert_eq!(live_paths(&env, &ctx), ["x/inner.txt"]);
}

#[test]
fn queue_order_holds_across_an_upload_and_a_move() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    let sha = hex_sha(b"hello world");
    let hint = hint_for(&env, "a.txt", &sha);
    std::fs::rename(env.path("a.txt"), env.path("b.txt")).unwrap();
    queue(&env, &ctx, "a.txt", None, Some(hint));
    queue(&env, &ctx, "a.txt", Some("b.txt"), None);
    assert_eq!(drain(&ctx), 2);
    assert_eq!(live_paths(&env, &ctx), ["b.txt"]);
}

#[test]
fn many_uploads_are_indexed_in_parallel_and_drained_in_batches() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let count = usize::try_from(fdrive_indexer::work::BATCH).unwrap() + 5;
    let mut c = env.client();
    for i in 0..count {
        env.write(&format!("u/{i}.txt"), format!("file {i}").as_bytes());
        queue_on(&mut c, &ctx, &format!("u/{i}.txt"), None, None);
    }
    assert_eq!(drain(&ctx), count);
    assert_eq!(live_paths(&env, &ctx).len(), count);
    assert_eq!(queued(&env), 0);
    assert_eq!(ctx.foreground_pending(), 0);
}

#[test]
fn while_indexing_is_off_the_queue_is_dropped() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    assert_eq!(drain(&ctx), 1);
    assert_eq!(queued(&env), 0);
    assert!(live_paths(&env, &ctx).is_empty());
}

#[test]
fn malformed_rows_are_dropped() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "../a.txt", None, None);
    queue(&env, &ctx, "a.txt", Some("/"), None);
    assert_eq!(drain(&ctx), 2);
    assert_eq!(queued(&env), 0);
    assert!(live_paths(&env, &ctx).is_empty());
}

#[test]
fn a_change_to_something_unreadable_is_left_for_the_scan() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    // A name longer than the filesystem allows cannot be read, even by root.
    let long = "x".repeat(300);
    assert_eq!(entry(&env.root, &long), Entry::Unknown);
    assert_eq!(entry(&env.root, &format!("{long}/a.txt")), Entry::Unknown);
    let applier = Applier::new(Arc::clone(&ctx));
    applier.apply(&Change::Path {
        path: long.clone(),
        hint: None,
    });
    applier.apply(&Change::Moved {
        from: "a.txt".to_owned(),
        to: long,
    });
    // Nothing was decided about rows it could not check.
    assert_eq!(live_paths(&env, &ctx), ["a.txt"]);
    // Below a root that is not a folder there is nothing at all.
    assert_eq!(entry(&env.path("a.txt"), "x"), Entry::Gone);
}

#[test]
fn a_queue_without_a_database_reports_an_error() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.database_url = "postgres://nobody@127.0.0.1:1/nope".to_owned();
    let ctx = common::root_env::context_with(env.config(), text_on(), |ctx| {
        ctx.db = db::Db {
            url: cfg.database_url.clone(),
            retries: 1,
        };
    });
    assert!(Applier::new(ctx).drain().is_err());
}

// -- the loop ------------------------------------------------------------------------------

#[test]
fn the_loop_wakes_on_a_notification() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let mut work = WorkLoop::new(Arc::clone(&ctx));
    assert_eq!(work.step(Duration::from_millis(50)), 0);
    assert!(work.is_listening());
    env.write("a.txt", b"hello world");
    let queued_later = std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(200));
            queue(&env, &ctx, "a.txt", None, None);
        });
        let started = Instant::now();
        work.step(Duration::from_secs(30));
        started.elapsed()
    });
    assert!(queued_later < Duration::from_secs(10), "{queued_later:?}");
    assert_eq!(work.step(Duration::from_millis(10)), 1);
    assert_eq!(live_paths(&env, &ctx), ["a.txt"]);
}

#[test]
fn the_loop_polls_without_a_database() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.database_url = "postgres://nobody@127.0.0.1:1/nope".to_owned();
    let url = cfg.database_url.clone();
    let ctx = common::root_env::context_with(env.config(), text_on(), |ctx| {
        ctx.db = db::Db { url, retries: 1 };
        ctx.cfg = Arc::new(cfg);
    });
    let mut work = WorkLoop::new(ctx);
    assert_eq!(work.step(Duration::from_millis(10)), 0);
    assert!(!work.is_listening());
    // Still not listening, and only said once.
    assert_eq!(work.step(Duration::from_millis(10)), 0);
    assert!(!work.is_listening());
}

#[test]
fn the_loop_listens_again_after_losing_its_connection() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    let mut work = WorkLoop::new(Arc::clone(&ctx));
    work.step(Duration::from_millis(10));
    assert!(work.is_listening());
    // End every other session, the listener's included.
    env.client()
        .execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
            &[],
        )
        .unwrap();
    work.step(Duration::from_millis(50));
    assert!(!work.is_listening());
    work.step(Duration::from_millis(10));
    assert!(work.is_listening());
}

// -- foreground work and the text stage ----------------------------------------------------

#[test]
fn scans_wait_for_foreground_work_but_not_forever() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    let started = Instant::now();
    ctx.yield_to_foreground(FOREGROUND_WAIT_LIMIT);
    assert!(started.elapsed() < Duration::from_secs(1));
    let guard = ctx.foreground();
    assert_eq!(ctx.foreground_pending(), 1);
    let started = Instant::now();
    ctx.yield_to_foreground(Duration::from_millis(100));
    assert!(started.elapsed() >= Duration::from_millis(100));
    let waiting = std::thread::scope(|scope| {
        let waiter = scope.spawn(|| {
            let started = Instant::now();
            ctx.yield_to_foreground(FOREGROUND_WAIT_LIMIT);
            started.elapsed()
        });
        std::thread::sleep(Duration::from_millis(100));
        drop(guard);
        waiter.join().unwrap()
    });
    assert!(waiting < Duration::from_secs(5));
    assert_eq!(ctx.foreground_pending(), 0);
}

#[test]
fn queued_text_is_searchable_before_its_embeddings_arrive() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.ml.hold(TEXT_EMBED);
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    // Chunked and searchable by text; the stage is still waiting for the model.
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    let chunks: i64 = env
        .client()
        .query_one("SELECT count(*) FROM idx.chunks WHERE embedding IS NULL", &[])
        .unwrap()
        .get(0);
    assert_eq!(chunks, 1);
    assert_eq!(env.events(), ["created"]);
    env.ml.release(TEXT_EMBED);
    assert!(indexed(&env, &ctx, "a.txt"));
    assert!(env.unresolved().is_empty());
}

#[test]
fn a_failed_staged_embedding_is_recorded_and_left_partial() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.ml.fail(TEXT_EMBED, 400);
    env.write("a.txt", b"hello world");
    queue(&env, &ctx, "a.txt", None, None);
    drain(&ctx);
    assert!(wait_until(WAIT, || !env.unresolved().is_empty()));
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    assert_eq!(
        env.unresolved(),
        [("a.txt".to_owned(), "semanticSearch".to_owned())].into()
    );
}

#[test]
fn the_text_stage_skips_a_superseded_or_disabled_file() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    env.write("a.txt", b"hello world");
    env.seed(&ctx, "a.txt", &"c".repeat(64), "partial");
    assert_eq!(
        embed_chunks(&ctx, "a.txt", Some(&"d".repeat(64))).unwrap(),
        Embedded::Superseded
    );
    let stage = Stage::text(Arc::clone(&ctx), "text-test");
    assert_eq!(stage.submit("a.txt", &"d".repeat(64), "op").wait(), (true, true));
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    assert_eq!(stage.submit("a.txt", &"c".repeat(64), "op").wait(), (true, false));
    assert_eq!(env.status(&ctx, "a.txt"), "indexed");
    stage.close(false);
    assert!(stage.try_submit("a.txt", "x", "op").is_none());
    let off = env.ctx(fv(false, true, false, false, false));
    let stage = Stage::text(Arc::clone(&off), "text-off");
    assert_eq!(stage.submit("a.txt", "x", "op").wait(), (true, true));
    assert_eq!(embed_chunks(&off, "a.txt", None).unwrap(), Embedded::Off);
    stage.close(false);
}

#[test]
fn a_full_text_stage_embeds_on_the_worker() {
    let env = Env::new();
    let ctx = env.ctx(text_on());
    let stage = ctx.watch_text_stage();
    assert!(Arc::ptr_eq(&stage, &ctx.watch_text_stage()));
    // A closed stage takes nothing, as a full one would.
    stage.close(false);
    let (path, stat) = env.write("a.txt", b"hello world");
    let result = fdrive_indexer::indexer::watch_index(&ctx, &path, "a.txt", stat);
    assert_eq!(result.status, "indexed");
    assert!(!result.deferred.contains_key("semanticSearch"));
    assert_eq!(env.status(&ctx, "a.txt"), "indexed");
}
