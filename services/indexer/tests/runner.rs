//! Start-up and the root loop (ported from `test_main.py`; process wiring and the HTTP
//! server are not ported).

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::fake_ml::IMAGE_EMBED;
use common::root_env::{Env, OFF, fv, jpeg};
use fdrive_indexer::config::{Config, ROOT_ID, ROOT_NAME};
use fdrive_indexer::db::{self, NewChange};
use fdrive_indexer::failures::FileResult;
use fdrive_indexer::files_marker::FILES_MARKER;
use fdrive_indexer::indexer::RootContext;
use fdrive_indexer::runner::{Handler, RootLoop, build_context, refresh_settings, start_watcher};
use fdrive_indexer::watcher::WatchHandler;
use fdrive_indexer::work::Applier;

fn quiet_config(env: &Env) -> Config {
    let mut cfg = env.config();
    cfg.watch = false;
    cfg
}

fn build(cfg: Config) -> Arc<RootContext> {
    let cfg = Arc::new(cfg);
    common::mark_files_folder(&cfg.database_url, &cfg.root);
    build_context(&cfg).unwrap()
}

fn scans(env: &Env) -> i64 {
    env.count("idx.scans")
}

/// A root as a running indexer leaves it: a file indexed by a finished scan, and the
/// journal's reader at its position.
fn scanned(env: &Env, cfg: Config) -> Arc<RootContext> {
    common::save_features(&env.url, fv(false, true, false, false, false));
    env.write("a.txt", b"hello");
    let ctx = build(cfg);
    // As at start: the loop is decided before the reader takes its first position.
    let mut root = RootLoop::new(&ctx).unwrap();
    Applier::new(Arc::clone(&ctx)).position().unwrap();
    root.step(&ctx, &AtomicBool::new(false));
    assert_eq!(scans(env), 1);
    ctx
}

fn save_setting(env: &Env, key: &str, value: serde_json::Value) {
    env.client()
        .execute(
            "INSERT INTO app.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            &[&key, &value],
        )
        .unwrap();
}

#[test]
fn build_context_serves_the_files_root_with_the_persisted_features() {
    let env = Env::new();
    let ctx = build(env.config());
    assert_eq!((ctx.name.as_str(), ctx.root_id), (ROOT_NAME, ROOT_ID));
    assert_eq!(ctx.abs_path, env.root);
    assert_eq!(ctx.extractor().root, ROOT_NAME);
    assert!(!ctx.values().indexer_enabled());
    assert_eq!(ctx.refresh_features, Some(ctx.cfg.settings_refresh));
}

#[test]
fn build_context_marks_old_text_less_pdfs_for_ocr_only_while_it_is_off() {
    for search_ocr in [false, true] {
        let env = Env::new();
        common::save_features(&env.url, fv(false, true, search_ocr, false, false));
        let mut c = env.client();
        for (path, ext) in [("scan.pdf", ".pdf"), ("photo.jpg", ".jpg")] {
            let id = db::upsert_file(
                &mut c,
                &db::NewFile {
                    root_id: ROOT_ID,
                    path,
                    name: path,
                    ext,
                    size: 1,
                    mtime_ns: 1,
                    sha256: "sha",
                    mime: None,
                },
            )
            .unwrap();
            db::update_file_status(&mut c, id, "no_text", 0, None).unwrap();
        }
        let ctx = build(env.config());
        // With OCR on, the old retry rule already read every no_text PDF.
        let expected = if search_ocr { "no_text" } else { "disabled:search_ocr" };
        assert_eq!(env.status(&ctx, "scan.pdf"), expected);
        assert_eq!(env.status(&ctx, "photo.jpg"), "no_text");
    }
}

#[test]
fn a_restart_with_persisted_media_features_is_not_a_backfill_transition() {
    let env = Env::new();
    common::save_features(&env.url, fv(true, false, false, false, true));
    let ctx = build(env.config());
    assert!(!refresh_settings(&ctx).unwrap());
    assert!(ctx.values().image_search);
    // Missing derivatives are still found from durable state; only a live toggle refreshes
    // every existing thumbnail.
    assert!(!ctx.needs_media_backfill());
}

#[test]
fn refresh_settings_reports_and_applies_changes() {
    let env = Env::new();
    let ctx = build(env.config());
    assert!(!refresh_settings(&ctx).unwrap());
    save_setting(&env, "indexer.workers", serde_json::json!(7));
    assert!(refresh_settings(&ctx).unwrap());
    assert_eq!(ctx.settings().workers, 7);
    assert!(!refresh_settings(&ctx).unwrap());
    common::save_features(&env.url, fv(false, true, false, false, false));
    assert!(refresh_settings(&ctx).unwrap());
    assert_eq!(ctx.features().revision, 2);
    assert!(ctx.values().text_search);
    // Only an explicit, valid selection enables anything.
    save_setting(&env, "features.configuration", serde_json::json!({"version": 2}));
    assert!(refresh_settings(&ctx).unwrap());
    assert!(!ctx.values().indexer_enabled());
}

#[test]
fn refresh_settings_fails_without_a_database() {
    let env = Env::new();
    let ctx = env.ctx_with(OFF, |c| {
        c.db = db::Db {
            url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
            retries: 1,
        }
    });
    assert!(refresh_settings(&ctx).is_err());
}

#[test]
fn start_watcher_needs_watching_on_and_a_supported_platform() {
    let env = Env::new();
    assert!(start_watcher(&build(quiet_config(&env))).is_none());
    let watcher = start_watcher(&build(env.config()));
    // inotify exists only on Linux; elsewhere periodic scans carry the root.
    assert_eq!(watcher.is_some(), cfg!(target_os = "linux"));
    if let Some(watcher) = watcher {
        watcher.stop();
    }
}

#[test]
fn the_loop_scans_on_start_then_waits_for_its_interval_or_a_wake() {
    let env = Env::new();
    common::save_features(&env.url, fv(false, true, false, false, false));
    let ctx = build(quiet_config(&env));
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();

    // First step: nothing was ever scanned, so a scan is due.
    let wait = root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    assert!(wait <= ctx.cfg.settings_refresh && wait > Duration::ZERO);
    assert!(!watching.load(Ordering::SeqCst));
    assert!(!root.has_watcher());

    // Feature polling does not rescan at its own cadence.
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);

    root.wake();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 2);

    // A settings change scans at once.
    save_setting(&env, "indexer.scan_interval_seconds", serde_json::json!(7200));
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 3);
    assert_eq!(ctx.settings().scan_interval_seconds, 7200);
    assert_eq!(
        root.step(&ctx, &watching),
        ctx.cfg.settings_refresh.min(Duration::from_secs(7200))
    );
}

#[test]
fn a_restart_soon_after_a_scan_does_not_walk() {
    let env = Env::new();
    scanned(&env, quiet_config(&env));
    // Restarted: fdrive's changes since wait in the journal from the reader's position.
    let ctx = build(quiet_config(&env));
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();
    assert_eq!(root.step(&ctx, &watching), ctx.cfg.settings_refresh);
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    // A wake still scans at once.
    root.wake();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 2);
}

#[test]
fn a_restart_keeps_counting_the_interval_from_the_last_scan() {
    let env = Env::new();
    let mut cfg = quiet_config(&env);
    // A step then waits until the next scan is due, not until settings are read again.
    cfg.settings_refresh = Duration::from_secs(24 * 3600);
    scanned(&env, cfg.clone());
    env.client()
        .batch_execute("UPDATE idx.scans SET finished_at = now() - interval '20 minutes'")
        .unwrap();
    let ctx = build(cfg);
    let watching = AtomicBool::new(false);
    let wait = RootLoop::new(&ctx).unwrap().step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    assert!(
        wait > Duration::from_secs(39 * 60) && wait <= Duration::from_secs(40 * 60),
        "{wait:?}"
    );

    // Down for longer than the interval: the scan that came due runs at once.
    env.client()
        .batch_execute("UPDATE idx.scans SET finished_at = now() - interval '61 minutes'")
        .unwrap();
    RootLoop::new(&ctx).unwrap().step(&ctx, &watching);
    assert_eq!(scans(&env), 2);
}

#[test]
fn a_restart_walks_when_the_journal_cannot_cover_the_time_since() {
    for (case, change) in [
        // Cleared, or restored: a restore starts with an empty index.
        ("an empty index", "DELETE FROM idx.chunks; DELETE FROM idx.files"),
        // A journal the reader has no position in, as after a restore.
        ("no position", "DELETE FROM idx.change_cursors"),
    ] {
        let env = Env::new();
        scanned(&env, quiet_config(&env));
        env.client().batch_execute(change).unwrap();
        let ctx = build(quiet_config(&env));
        let mut root = RootLoop::new(&ctx).unwrap();
        root.step(&ctx, &AtomicBool::new(false));
        assert_eq!(scans(&env), 2, "{case}");
    }
}

#[test]
fn a_restart_walks_when_rows_it_never_read_were_pruned() {
    let env = Env::new();
    let ctx = scanned(&env, quiet_config(&env));
    // While the indexer was down, fdrive changed two files and the older row was pruned.
    let changes = [NewChange::path("b.txt"), NewChange::path("c.txt")];
    db::append_changes(&mut env.client(), ctx.root_id, &ctx.name, "api", &changes).unwrap();
    env.client()
        .batch_execute("DELETE FROM idx.changes WHERE id = (SELECT min(id) FROM idx.changes)")
        .unwrap();
    let ctx = build(quiet_config(&env));
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    // The reader's first look finds the gap and asks for a scan.
    assert_eq!(Applier::new(Arc::clone(&ctx)).drain().unwrap(), 0);
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 2);
}

#[test]
fn the_loop_scans_when_the_journal_reader_asks_and_the_folder_is_right() {
    let env = Env::new();
    common::save_features(&env.url, fv(false, true, false, false, false));
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);

    // A request waits while the folder is not this installation's.
    let marker = env.path(FILES_MARKER);
    let id = std::fs::read_to_string(&marker).unwrap();
    std::fs::remove_file(&marker).unwrap();
    ctx.request_scan();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    std::fs::write(&marker, &id).unwrap();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 2);
    // Answered once.
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 2);
    assert!(!ctx.take_scan_request());
}

#[test]
fn the_loop_keeps_going_after_a_crash() {
    let env = Env::new();
    let mut root = RootLoop::new(&env.ctx(fv(false, true, false, false, false))).unwrap();
    // The database goes away after start.
    let ctx = env.ctx_with(fv(false, true, false, false, false), |c| {
        c.db = db::Db {
            url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
            retries: 1,
        };
    });
    assert!(RootLoop::new(&ctx).is_err());
    let watching = AtomicBool::new(false);
    let wait = root.step(&ctx, &watching);
    // Retried after the refresh interval rather than spinning.
    assert!(wait > ctx.cfg.settings_refresh - Duration::from_secs(1));
    assert!(root.step(&ctx, &watching) > Duration::ZERO);
}

#[test]
fn the_loop_stops_scanning_while_every_feature_is_off() {
    let env = Env::new();
    let ctx = build(env.config());
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 0);
    assert!(!watching.load(Ordering::SeqCst));
    common::save_features(&env.url, fv(false, true, false, false, false));
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    assert_eq!(watching.load(Ordering::SeqCst), cfg!(target_os = "linux"));
    common::save_features(&env.url, OFF);
    root.step(&ctx, &watching);
    assert!(!root.has_watcher());
    assert!(!watching.load(Ordering::SeqCst));
}

#[test]
fn the_loop_neither_scans_nor_watches_a_folder_without_its_marker() {
    let env = Env::new();
    common::save_features(&env.url, fv(false, true, false, false, false));
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    let marker = env.path(FILES_MARKER);
    let id = std::fs::read_to_string(&marker).unwrap();
    std::fs::remove_file(&marker).unwrap();
    let watching = AtomicBool::new(false);
    let mut root = RootLoop::new(&ctx).unwrap();
    root.step(&ctx, &watching);
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 0);
    assert!(!root.has_watcher());

    // Back in place: the scan that was due runs at once.
    std::fs::write(&marker, &id).unwrap();
    root.step(&ctx, &watching);
    assert_eq!(scans(&env), 1);
    assert_eq!(root.has_watcher(), cfg!(target_os = "linux"));

    // Gone again: the watcher stops.
    std::fs::remove_file(&marker).unwrap();
    root.wake();
    root.step(&ctx, &watching);
    assert!(!root.has_watcher());
    assert_eq!(scans(&env), 1);
}

#[test]
fn watcher_folders_wait_for_the_marker() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    let handler = Handler(Arc::clone(&ctx));
    std::fs::create_dir_all(env.path("alice/new")).unwrap();
    std::fs::remove_file(env.path(FILES_MARKER)).unwrap();
    handler.folder_changed("alice/new");
    assert!(env.folders(&ctx).is_empty());
    common::mark_files_folder(&ctx.cfg.database_url, &env.path(""));
    handler.folder_changed("alice/new");
    assert_eq!(
        env.folders(&ctx).into_iter().map(|(path, _)| path).collect::<Vec<_>>(),
        ["alice", "alice/new"]
    );
}

#[test]
fn watcher_deletes_and_renames_wait_for_the_marker() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    let handler = Handler(Arc::clone(&ctx));
    let (path, _) = env.write("a.txt", b"hello");
    assert_eq!(
        handler
            .index_file(&path, "a.txt", &std::fs::metadata(&path).unwrap())
            .status,
        "indexed"
    );
    std::fs::remove_file(env.path(FILES_MARKER)).unwrap();
    assert_eq!(handler.rename("a.txt", "b.txt", false), 0);
    assert_eq!(handler.delete("a.txt", false), 0);
    assert!(env.has_row(&ctx, "a.txt"));
}

/// A rename the kernel pairs by its cookie moves the file's row; a copy and a delete, as a
/// move over SMB can arrive, deletes the row and indexes the copy as a new file.
#[cfg(target_os = "linux")]
#[test]
fn a_paired_rename_keeps_the_row_and_an_unpaired_move_makes_a_new_one() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.watch_debounce = Duration::from_millis(100);
    let ctx = common::root_env::context_with(cfg, fv(false, true, false, false, false), |_| {});
    let watcher = start_watcher(&ctx).unwrap();
    let wait = |done: &dyn Fn() -> bool| common::root_env::wait_until(Duration::from_secs(10), done);
    env.write("a.txt", b"hello");
    assert!(wait(&|| env.row_id(&ctx, "a.txt").is_some()));
    let (id, sha) = env.row_id(&ctx, "a.txt").unwrap();

    std::fs::rename(env.path("a.txt"), env.path("b.txt")).unwrap();
    assert!(wait(&|| env.row_id(&ctx, "b.txt").is_some()));
    assert_eq!(env.row_id(&ctx, "b.txt"), Some((id, sha.clone())));
    assert!(!env.has_row(&ctx, "a.txt"));

    std::fs::copy(env.path("b.txt"), env.path("c.txt")).unwrap();
    std::fs::remove_file(env.path("b.txt")).unwrap();
    assert!(wait(
        &|| env.row_id(&ctx, "c.txt").is_some() && !env.has_row(&ctx, "b.txt")
    ));
    let (fresh, fresh_sha) = env.row_id(&ctx, "c.txt").unwrap();
    assert_ne!(fresh, id);
    assert_eq!(fresh_sha, sha);
    watcher.stop();
}

#[test]
fn watcher_callbacks_index_delete_and_rename() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let handler = Handler(Arc::clone(&ctx));
    let (path, _) = env.write("a.txt", b"hello");
    let finish = handler.on_queue(&path);
    let result = handler.index_file(&path, "a.txt", &std::fs::metadata(&path).unwrap());
    assert_eq!(result.status, "indexed");
    finish(&result);
    let text = Env::snapshot(&ctx, "textSearch");
    assert_eq!(
        (
            text["kind"].as_str(),
            text["state"].as_str(),
            text["processed"].as_u64()
        ),
        (Some("watch"), Some("completed"), Some(1))
    );
    assert_eq!(handler.rename("a.txt", "b.txt", false), 1);
    assert_eq!(handler.delete("b.txt", false), 1);
    assert_eq!(handler.delete("b.txt", false), 0);
    handler.log("watch: a message");

    // A failed job reports an error for every feature it was queued for.
    let finish = handler.on_queue(&env.path("gone.txt"));
    finish(&FileResult::plain("error"));
    let text = Env::snapshot(&ctx, "textSearch");
    assert_eq!(
        (text["state"].as_str(), text["errors"].as_u64()),
        (Some("failed"), Some(1))
    );
}

#[test]
fn watcher_changes_do_not_wait_for_image_embeddings() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    let handler = Handler(Arc::clone(&ctx));
    env.ml.hold(IMAGE_EMBED);
    let names = ["a.jpg", "b.jpg"];
    let paths: Vec<_> = names
        .iter()
        .enumerate()
        .map(|(i, name)| env.write(name, &jpeg(16, 16, i as u8)).0)
        .collect();
    let finishes: Vec<_> = paths.iter().map(|path| handler.on_queue(path)).collect();
    for ((path, name), finish) in paths.iter().zip(names).zip(finishes) {
        // Each change returns while the model is still busy with the first image.
        finish(&handler.index_file(path, name, &std::fs::metadata(path).unwrap()));
    }
    let watch = |feature: &str| {
        let op = Env::snapshot(&ctx, feature);
        (
            op["state"].as_str().unwrap().to_owned(),
            op["processed"].as_u64().unwrap(),
        )
    };
    assert_eq!(watch("thumbnails"), ("completed".to_owned(), 2));
    assert_eq!(watch("imageSearch"), ("running".to_owned(), 0));
    assert_eq!(env.count("app.image_embeddings"), 0);
    env.ml.release(IMAGE_EMBED);
    assert!(common::root_env::wait_until(Duration::from_secs(5), || watch(
        "imageSearch"
    )
    .0 != "running"));
    assert_eq!(watch("imageSearch"), ("completed".to_owned(), 2));
    assert_eq!(env.count("app.image_embeddings"), 2);
}

#[test]
fn run_root_scans_and_rescans_when_woken() {
    let env = Env::new();
    common::save_features(&env.url, fv(false, true, false, false, false));
    let ctx = build(quiet_config(&env));
    let wake = Arc::new(fdrive_indexer::server::Wake::default());
    {
        let (ctx, wake) = (Arc::clone(&ctx), Arc::clone(&wake));
        // The loop never returns; the thread ends with the test process.
        let root = RootLoop::new(&ctx).unwrap();
        std::thread::spawn(move || fdrive_indexer::runner::run_root(root, &ctx, &AtomicBool::new(false), &wake));
    }
    let wait = Duration::from_secs(10);
    assert!(common::root_env::wait_until(wait, || scans(&env) == 1));
    wake.set();
    assert!(common::root_env::wait_until(wait, || scans(&env) == 2));
}
