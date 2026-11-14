//! Row stamps (`db::Stamp`): which of the indexer's reads vouch that a row's digest still
//! describes the file on disk, against a real filesystem and Postgres.

mod common;

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use common::root_env::{Env, fv};
use fdrive_indexer::db::Stamp;
use fdrive_indexer::features::FeatureValues;
use fdrive_indexer::indexer::{FileStat, RootContext, STAMP_SETTLE, earned_stamp, process_file, read_digest, settled};

/// Short enough for a test to wait out, long enough to span many ticks of any test machine's
/// file clock.
const SETTLE: Duration = Duration::from_millis(50);
const PAST: Duration = Duration::from_millis(150);

fn text_on() -> FeatureValues {
    fv(false, true, false, false, false)
}

fn hex_sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A root whose reads stamp a file `SETTLE` after its last change.
fn settling(env: &Env) -> Arc<RootContext> {
    env.ctx_with(text_on(), |ctx| ctx.stamp_settle = SETTLE)
}

fn stamp_of(env: &Env, rel: &str) -> Stamp {
    Stamp::of(&std::fs::metadata(env.path(rel)).unwrap())
}

fn index(env: &Env, ctx: &Arc<RootContext>, rel: &str) -> bool {
    process_file(ctx, &env.path(rel), rel, env.stat(rel)).unwrap()
}

/// Writes other bytes of the same length and puts the modification time back, as a client
/// that sets modification times can.
fn rewrite_keeping_time(env: &Env, rel: &str, bytes: &[u8]) {
    let path = env.path(rel);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    std::fs::write(&path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
}

#[test]
fn a_file_settles_once_its_change_time_is_old_enough() {
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    let second = 1_000_000_000;
    assert!(settled(99 * second, at, Duration::from_secs(1)));
    assert!(!settled(99 * second + 1, at, Duration::from_secs(1)));
    assert!(settled(100 * second, at, Duration::ZERO));
    assert_eq!(STAMP_SETTLE, Duration::from_secs(1));
}

#[test]
fn a_read_earns_a_stamp_only_for_the_settled_version_it_saw_throughout() {
    let env = Env::new();
    let (path, stat) = env.write("a.txt", b"hello");
    env.write("b.txt", b"other");
    let before = std::fs::metadata(&path).unwrap();
    let later = SystemTime::now() + PAST;
    assert_eq!(
        earned_stamp(stat, &before, &before, later, SETTLE),
        Some(Stamp::of(&before))
    );
    // Began before the file had settled: a write in the same tick could have been missed.
    assert_eq!(
        earned_stamp(stat, &before, &before, SystemTime::now(), PAST * 100),
        None
    );
    // Another inode or change time when the read ended.
    let other = std::fs::metadata(env.path("b.txt")).unwrap();
    assert_eq!(earned_stamp(stat, &before, &other, later, SETTLE), None);
    // Another version than the one the row will record.
    let grown = FileStat {
        size: stat.size + 1,
        ..stat
    };
    assert_eq!(earned_stamp(grown, &before, &before, later, SETTLE), None);

    std::thread::sleep(PAST);
    let mut file = std::fs::File::open(&path).unwrap();
    let (sha, stamp) = read_digest(&mut file, stat, SETTLE).unwrap();
    assert_eq!((sha, stamp), (hex_sha(b"hello"), Some(stamp_of(&env, "a.txt"))));
}

#[test]
fn a_settled_file_is_stamped_when_indexed_and_a_fresh_one_once_it_settles() {
    let env = Env::new();
    env.write("old.txt", b"old");
    std::thread::sleep(PAST);
    let ctx = settling(&env);
    assert!(index(&env, &ctx, "old.txt"));
    assert_eq!(env.row(&ctx, "old.txt").stamp, Some(stamp_of(&env, "old.txt")));

    // Indexed the moment it was written: too fresh to vouch for, and looked at again before
    // it settles, it is not even read.
    let fresh = env.ctx(text_on());
    env.write("new.txt", b"new");
    assert!(index(&env, &fresh, "new.txt"));
    assert!(!index(&env, &fresh, "new.txt"));
    let status = env.row(&fresh, "new.txt").status;
    assert_eq!(env.row(&fresh, "new.txt").stamp, None);

    // Once it has settled, a look at the unchanged file reads it and stamps the row, with no
    // new version to report.
    std::thread::sleep(PAST);
    assert!(!index(&env, &ctx, "new.txt"));
    let row = env.row(&ctx, "new.txt");
    assert_eq!(
        (row.stamp, row.sha256.as_deref(), row.status),
        (Some(stamp_of(&env, "new.txt")), Some(hex_sha(b"new").as_str()), status)
    );
    assert_eq!(env.events(), ["created", "created"]);
    // Stamped, it is left alone.
    assert!(!index(&env, &ctx, "new.txt"));
}

#[test]
fn a_rewrite_that_keeps_size_and_time_is_found_and_indexed_again() {
    let env = Env::new();
    env.write("a.txt", b"first");
    std::thread::sleep(PAST);
    let ctx = settling(&env);
    assert!(index(&env, &ctx, "a.txt"));
    let stat = env.stat("a.txt");
    let stamped = env.row(&ctx, "a.txt").stamp;
    assert_eq!(stamped, Some(stamp_of(&env, "a.txt")));

    rewrite_keeping_time(&env, "a.txt", b"other");
    assert_eq!(env.stat("a.txt"), stat, "size and modification time are as indexed");
    assert_ne!(Some(stamp_of(&env, "a.txt")), stamped, "the change time moved on");
    std::thread::sleep(PAST);
    assert!(index(&env, &ctx, "a.txt"));
    let row = env.row(&ctx, "a.txt");
    assert_eq!(
        (row.sha256.as_deref(), row.stamp),
        (Some(hex_sha(b"other").as_str()), Some(stamp_of(&env, "a.txt")))
    );
    assert_eq!(env.events(), ["created", "changed"]);
}

#[test]
fn a_row_without_a_digest_is_not_read_to_stamp_it() {
    let env = Env::new();
    env.write("a.txt", b"hello");
    std::thread::sleep(PAST);
    let ctx = settling(&env);
    env.seed(&ctx, "a.txt", "unused", "none");
    env.client().execute("UPDATE idx.files SET sha256 = NULL", &[]).unwrap();
    assert!(!index(&env, &ctx, "a.txt"));
    assert_eq!(env.row(&ctx, "a.txt").stamp, None);
}

#[test]
fn a_file_that_cannot_be_read_for_its_stamp_keeps_its_row() {
    let env = Env::new();
    let (path, stat) = env.write("a.txt", b"hello");
    std::thread::sleep(PAST);
    let ctx = settling(&env);
    env.seed(&ctx, "a.txt", &hex_sha(b"hello"), "none");
    // Something that is not a regular file now stands where the row's file was.
    std::fs::remove_file(&path).unwrap();
    std::process::Command::new("mkfifo").arg(&path).status().unwrap();
    assert!(!process_file(&ctx, &path, "a.txt", stat).unwrap());
    let row = env.row(&ctx, "a.txt");
    assert_eq!((row.status.as_str(), row.error, row.stamp), ("none", None, None));
}
