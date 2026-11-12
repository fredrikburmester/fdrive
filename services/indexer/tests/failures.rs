//! Durable failure history in `idx.processing_failures` (ported from `test_failures.py`;
//! the clear, rebuild and retry HTTP paths live in the server tests).

mod common;

use std::collections::HashMap;

use common::fake_ml::{self, IMAGE_EMBED, TEXT_EMBED};
use common::root_env::{Env, context_with, fv, png};
use fdrive_indexer::db;
use fdrive_indexer::failures::{self, Report, attempt, describe, failed, ok, report, resolving_skip, skipped};
use fdrive_indexer::indexer::{RootContext, process_file, process_inner, scan_once};

type Record = (String, String, String, String, i32, bool, String);

fn records(env: &Env) -> Vec<Record> {
    env.client()
        .query(
            "SELECT feature, path, code, message, attempts, resolved_at IS NOT NULL, operation_id \
             FROM idx.processing_failures ORDER BY id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5), r.get(6)))
        .collect()
}

fn fail(ctx: &RootContext, path: &str, feature: &str, error: &str) {
    report(&ctx.db, ctx.root_id, path, feature, failed(error));
}

#[test]
fn a_failure_is_persisted_with_its_operation() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    let ids: HashMap<String, String> = [("thumbnails".to_owned(), "run-before-restart".to_owned())].into();
    let ((), observed) = attempt(ids, || fail(&ctx, "broken.png", "thumbnails", "DecodeError: bad bytes"));
    assert_eq!(observed.outcomes["thumbnails"], (false, false));
    // A fresh connection sees the committed row.
    let row = &records(&env)[0];
    assert_eq!(
        row,
        &(
            "thumbnails".to_owned(),
            "broken.png".to_owned(),
            "DecodeError".to_owned(),
            "DecodeError: bad bytes".to_owned(),
            1,
            false,
            "run-before-restart".to_owned()
        )
    );
    // Outside an attempt each report gets an operation id of its own.
    fail(&ctx, "other.png", "thumbnails", "x".repeat(3000).as_str());
    let other = &records(&env)[1];
    assert_eq!((other.2.chars().count(), other.3.chars().count()), (100, 2000));
    assert!(uuid_like(&other.6));
}

fn uuid_like(value: &str) -> bool {
    value.len() == 36 && value.matches('-').count() == 4
}

#[test]
fn attempts_count_per_root_path_and_feature_and_recurrence_starts_over() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    let mut cfg = env.config();
    cfg.roots = vec![("other".to_owned(), env.root.clone())];
    let other = context_with(cfg, fv(true, false, false, false, false), |_| {});
    for _ in 0..2 {
        fail(&ctx, "same.png", "thumbnails", "DecodeError: bad bytes");
    }
    fail(&ctx, "same.png", "imageSearch", "ValueError: rejected");
    fail(&other, "same.png", "thumbnails", "PermissionError: denied");
    let attempts: Vec<i32> = records(&env).iter().map(|r| r.4).collect();
    assert_eq!(attempts, vec![2, 1, 1]);

    let first_failed = |env: &Env| -> chrono::DateTime<chrono::Utc> {
        env.client()
            .query_one(
                "SELECT first_failed_at FROM idx.processing_failures ORDER BY id LIMIT 1",
                &[],
            )
            .unwrap()
            .get(0)
    };
    let before = first_failed(&env);
    report(&ctx.db, ctx.root_id, "same.png", "thumbnails", ok());
    let rows = records(&env);
    assert!(rows[0].5, "success resolves");
    assert!(!rows[1].5 && !rows[2].5, "other features and roots are untouched");

    std::thread::sleep(std::time::Duration::from_millis(5));
    fail(&ctx, "same.png", "thumbnails", "DecodeError: changed bytes");
    let row = &records(&env)[0];
    assert_eq!((row.3.as_str(), row.4, row.5), ("DecodeError: changed bytes", 1, false));
    assert!(first_failed(&env) > before);
}

#[test]
fn skips_are_not_recovery_but_resolving_skips_are() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    fail(&ctx, "empty.png", "thumbnails", "DecodeError: original issue");
    let ((), observed) = attempt(HashMap::new(), || {
        report(&ctx.db, ctx.root_id, "empty.png", "thumbnails", skipped());
    });
    assert_eq!(observed.outcomes["thumbnails"], (true, true));
    assert!(!records(&env)[0].5);
    // A skip with an error is still only a skip.
    report(
        &ctx.db,
        ctx.root_id,
        "empty.png",
        "thumbnails",
        Report {
            error: Some("waiting"),
            skipped: true,
            resolves: false,
        },
    );
    assert_eq!(records(&env)[0].4, 1);
    // A skip that read the file and found nothing to make settles the earlier failure.
    report(&ctx.db, ctx.root_id, "empty.png", "thumbnails", resolving_skip());
    assert!(records(&env)[0].5);
}

#[test]
fn prune_keeps_unresolved_drops_old_and_resolves_deleted_files() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    fail(&ctx, "open.png", "thumbnails", "DecodeError: open");
    fail(&ctx, "old.png", "thumbnails", "DecodeError: old");
    fail(&ctx, "recent.png", "thumbnails", "DecodeError: recent");
    report(&ctx.db, ctx.root_id, "recent.png", "thumbnails", ok());
    env.client()
        .batch_execute(
            "UPDATE idx.processing_failures SET resolved_at = now() - interval '31 days' WHERE path = 'old.png'",
        )
        .unwrap();
    failures::prune(&ctx.db).unwrap();
    let paths: Vec<String> = records(&env).into_iter().map(|r| r.1).collect();
    assert_eq!(paths, vec!["open.png", "recent.png"]);

    let mut c = env.client();
    env.write("open.png", b"x");
    env.seed(&ctx, "open.png", "sha", "indexed");
    db::mark_deleted(&mut c, ctx.root_id, "open.png", false).unwrap();
    failures::prune(&ctx.db).unwrap();
    assert!(records(&env)[0].5, "a deleted file's failure is resolved");
}

#[test]
fn the_resolved_history_cap_never_discards_unresolved_records() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    env.client()
        .execute(
            "INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id, resolved_at) \
             SELECT $1::int2, 'resolved-' || n, 'thumbnails', 'Error', 'old error', 'old-scan', now() - n * interval '1 second' \
             FROM generate_series(1, 10002) n",
            &[&(ctx.root_id as i16)],
        )
        .unwrap();
    fail(&ctx, "still-broken.png", "thumbnails", "Error: unresolved");
    failures::prune(&ctx.db).unwrap();
    let mut c = env.client();
    let resolved: i64 = c
        .query_one(
            "SELECT count(*) FROM idx.processing_failures WHERE resolved_at IS NOT NULL",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(resolved, 10_000);
    // The newest resolved records are the ones kept.
    let oldest_kept: i64 = c
        .query_one(
            "SELECT count(*) FROM idx.processing_failures WHERE path IN ('resolved-10001', 'resolved-10002')",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(oldest_kept, 0);
    let unresolved: String = c
        .query_one(
            "SELECT path FROM idx.processing_failures WHERE resolved_at IS NULL",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(unresolved, "still-broken.png");
}

#[test]
fn descriptions_carry_the_cause_chain() {
    let error = anyhow::anyhow!("CalledProcessError: ffmpeg exited with 1: Invalid data found when processing input")
        .context("thumbnail");
    let text = describe(&error);
    assert!(text.starts_with("thumbnail: ") && text.contains("Invalid data"));
    // Attempts never leak across calls.
    let ((), first) = attempt(HashMap::new(), || {});
    let ((), second) = attempt(HashMap::new(), || {});
    assert_ne!(first.id, second.id);
    assert!(!failures::in_attempt());
}

#[test]
fn an_unavailable_history_never_breaks_processing() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, false, false));
    env.client()
        .batch_execute("ALTER TABLE idx.processing_failures RENAME TO temporarily_unavailable")
        .unwrap();
    let (path, stat) = env.write("bad.png", b"corrupt");
    assert!(process_file(&ctx, &path, "bad.png", stat).unwrap());
    assert_eq!(env.status(&ctx, "bad.png"), "disabled:search_ocr");
    report(&ctx.db, ctx.root_id, "bad.png", "thumbnails", ok());
    // A scan reads the history with its manifest: it reports the crash instead of panicking.
    assert_eq!(scan_once(&ctx).errors, 1);
    env.client()
        .batch_execute("ALTER TABLE idx.temporarily_unavailable RENAME TO processing_failures")
        .unwrap();
    assert!(records(&env).is_empty());
}

#[test]
fn a_backend_outage_is_waiting_not_a_file_failure() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.embed_url = fake_ml::closed_url();
    let ctx = context_with(cfg, fv(false, true, false, true, false), |_| {});
    env.write("words.txt", b"searchable words");
    assert_eq!(scan_once(&ctx).errors, 0);
    assert!(records(&env).is_empty());
    let semantic = Env::snapshot(&ctx, "semanticSearch");
    assert_eq!(
        (semantic["errors"].as_u64(), semantic["skipped"].as_u64()),
        (Some(0), Some(1))
    );
}

#[test]
fn an_image_failure_does_not_count_against_thumbnails() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.write("good.png", &png(16, 16));
    env.ml.fail(IMAGE_EMBED, 500);
    assert_eq!(scan_once(&ctx).errors, 1);
    let thumbnails = Env::snapshot(&ctx, "thumbnails");
    assert_eq!(
        (thumbnails["errors"].as_u64(), thumbnails["state"].as_str()),
        (Some(0), Some("completed"))
    );
    let image = Env::snapshot(&ctx, "imageSearch");
    assert_eq!(
        (image["errors"].as_u64(), image["state"].as_str()),
        (Some(1), Some("failed"))
    );
    let rows = records(&env);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, "imageSearch");
    // The scan's operation id is what the record points at.
    assert_eq!(rows[0].6, image["id"].as_str().unwrap());
}

#[test]
fn a_text_retry_repairs_chunks_without_running_other_features() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, true, true));
    let (path, stat) = env.write("repaired.txt", b"recovered text");
    fail(&ctx, "repaired.txt", "textSearch", "DecodeError: could not read");
    process_inner(&ctx, &path, "repaired.txt", stat, None, Some("textSearch")).unwrap();
    assert!(records(&env)[0].5);
    let text: String = env
        .client()
        .query_one("SELECT text FROM idx.chunks", &[])
        .unwrap()
        .get(0);
    assert_eq!(text, "recovered text");
    // No embedding: the row keeps its chunks for the semantic retry.
    assert_eq!(env.status(&ctx, "repaired.txt"), "partial");
    assert_eq!(env.ml.count(TEXT_EMBED), 0);
    assert!(env.ml.seen().is_empty());

    // The same for an image: no thumbnail or embedding is made.
    let (path, stat) = env.write("photo.png", &png(8, 8));
    process_inner(&ctx, &path, "photo.png", stat, None, Some("textSearch")).unwrap();
    assert_eq!(env.thumbnail_files(), 0);
    assert!(env.ml.seen().is_empty());
}

#[test]
fn a_missing_root_fails_its_scan() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    std::fs::remove_dir(&env.root).unwrap();
    assert_eq!(scan_once(&ctx).errors, 1);
    let snapshot = ctx.activity.snapshot();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0]["state"], "failed");
    assert!(records(&env).is_empty());
}

#[test]
fn prune_reports_a_missing_history() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    env.client()
        .batch_execute("ALTER TABLE idx.processing_failures RENAME TO gone")
        .unwrap();
    assert!(failures::prune(&ctx.db).is_err());
    env.client()
        .batch_execute("ALTER TABLE idx.gone RENAME TO processing_failures")
        .unwrap();
    env.client()
        .batch_execute("ALTER TABLE idx.files RENAME TO gone")
        .unwrap();
    assert!(failures::prune(&ctx.db).is_err());
}

#[test]
fn a_video_without_a_picture_resolves_an_earlier_failure_as_a_skip() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    let path = env.path("voice.mp4");
    let made = std::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc",
            "-t",
            "0.2",
        ])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    if !made {
        eprintln!("skipped: ffmpeg is not installed");
        return;
    }
    fail(
        &ctx,
        "voice.mp4",
        "thumbnails",
        "CalledProcessError: Output file does not contain any stream",
    );
    let stat = env.stat("voice.mp4");
    let outcome = fdrive_indexer::indexer::process_thumbnails(
        &ctx,
        &path,
        "voice.mp4",
        ".mp4",
        &common::root_env::fake_sha('a'),
        stat.size,
        false,
    );
    assert_eq!(outcome, (true, true));
    assert!(records(&env)[0].5);
    assert_eq!(env.count("app.thumbnails"), 0);
}
