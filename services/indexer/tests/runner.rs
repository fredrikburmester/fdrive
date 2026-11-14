//! Start-up and the per-root loop (ported from `test_main.py`; process wiring and the
//! HTTP server are not ported).

mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::fake_ml::IMAGE_EMBED;
use common::root_env::{Env, OFF, fv, jpeg};
use fdrive_indexer::config::Config;
use fdrive_indexer::db;
use fdrive_indexer::failures::FileResult;
use fdrive_indexer::files_marker::FILES_MARKER;
use fdrive_indexer::indexer::RootContext;
use fdrive_indexer::runner::{
    EXPECTED_SCHEMA_VERSION, Handler, RootLoop, build_context, refresh_settings, start_watcher,
};
use fdrive_indexer::watcher::WatchHandler;

fn quiet_config(env: &Env) -> Config {
    let mut cfg = env.config();
    cfg.watch = false;
    cfg
}

fn build(cfg: Config) -> Arc<RootContext> {
    let cfg = Arc::new(cfg);
    let (name, path) = cfg.roots[0].clone();
    common::mark_files_folder(&cfg.database_url, &path);
    build_context(&cfg, &name, &path).unwrap()
}

fn scans(env: &Env) -> i64 {
    env.count("idx.scans")
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
fn build_context_registers_the_root_with_the_persisted_features() {
    let env = Env::new();
    let ctx = build(env.config());
    assert_eq!(EXPECTED_SCHEMA_VERSION, 2);
    assert_eq!(ctx.name, "r");
    assert!(ctx.root_id > 0);
    assert_eq!(ctx.abs_path, env.root);
    assert_eq!(ctx.extractor().root, "r");
    assert!(!ctx.values().indexer_enabled());
    assert_eq!(ctx.refresh_features, Some(ctx.cfg.settings_refresh));
    // Again: the same root row.
    assert_eq!(build(env.config()).root_id, ctx.root_id);
}

#[test]
fn build_context_marks_old_text_less_pdfs_for_ocr_only_while_it_is_off() {
    for search_ocr in [false, true] {
        let env = Env::new();
        common::save_features(&env.url, fv(false, true, search_ocr, false, false));
        let mut c = env.client();
        let root_id = db::upsert_root(&mut c, "r").unwrap();
        for (path, ext) in [("scan.pdf", ".pdf"), ("photo.jpg", ".jpg")] {
            let id = db::upsert_file(
                &mut c,
                &db::NewFile {
                    root_id,
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
    let watchers = Mutex::new(HashMap::new());
    let mut root = RootLoop::default();

    // First step: the selection changed from nothing, and a scan is due.
    let wait = root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);
    assert!(wait <= ctx.cfg.settings_refresh && wait > Duration::ZERO);
    assert!(!watchers.lock().unwrap()["r"]);
    assert!(!root.has_watcher());

    // Feature polling does not rescan at its own cadence.
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);

    root.wake();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 2);

    // A settings change scans at once.
    save_setting(&env, "indexer.scan_interval_seconds", serde_json::json!(7200));
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 3);
    assert_eq!(ctx.settings().scan_interval_seconds, 7200);
    assert_eq!(
        root.step(&ctx, &watchers),
        ctx.cfg.settings_refresh.min(Duration::from_secs(7200))
    );
}

#[test]
fn the_loop_scans_when_the_journal_reader_asks_and_the_folder_is_right() {
    let env = Env::new();
    common::save_features(&env.url, fv(false, true, false, false, false));
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    let watchers = Mutex::new(HashMap::new());
    let mut root = RootLoop::default();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);

    // A request waits while the folder is not this installation's.
    let marker = env.path(FILES_MARKER);
    let id = std::fs::read_to_string(&marker).unwrap();
    std::fs::remove_file(&marker).unwrap();
    ctx.request_scan();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);
    std::fs::write(&marker, &id).unwrap();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 2);
    // Answered once.
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 2);
    assert!(!ctx.take_scan_request());
}

#[test]
fn the_loop_keeps_going_after_a_crash() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(false, true, false, false, false), |c| {
        c.db = db::Db {
            url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
            retries: 1,
        };
    });
    let watchers = Mutex::new(HashMap::new());
    let mut root = RootLoop::default();
    let wait = root.step(&ctx, &watchers);
    // Retried after the refresh interval rather than spinning.
    assert!(wait > ctx.cfg.settings_refresh - Duration::from_secs(1));
    assert!(watchers.lock().unwrap().is_empty());
    assert!(root.step(&ctx, &watchers) > Duration::ZERO);
}

#[test]
fn the_loop_stops_scanning_while_every_feature_is_off() {
    let env = Env::new();
    let ctx = build(env.config());
    let watchers = Mutex::new(HashMap::new());
    let mut root = RootLoop::default();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 0);
    assert!(!watchers.lock().unwrap()["r"]);
    common::save_features(&env.url, fv(false, true, false, false, false));
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);
    assert_eq!(watchers.lock().unwrap()["r"], cfg!(target_os = "linux"));
    common::save_features(&env.url, OFF);
    root.step(&ctx, &watchers);
    assert!(!root.has_watcher());
    assert!(!watchers.lock().unwrap()["r"]);
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
    let watchers = Mutex::new(HashMap::new());
    let mut root = RootLoop::default();
    root.step(&ctx, &watchers);
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 0);
    assert!(!root.has_watcher());

    // Back in place: the scan that was due runs at once.
    std::fs::write(&marker, &id).unwrap();
    root.step(&ctx, &watchers);
    assert_eq!(scans(&env), 1);
    assert_eq!(root.has_watcher(), cfg!(target_os = "linux"));

    // Gone again: the watcher stops.
    std::fs::remove_file(&marker).unwrap();
    root.wake();
    root.step(&ctx, &watchers);
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
    assert_eq!(handler.mark_deleted("a.txt", false), 0);
    assert!(!env.row(&ctx, "a.txt").deleted);
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
    assert_eq!(handler.mark_deleted("b.txt", false), 1);
    assert_eq!(handler.mark_deleted("b.txt", false), 0);
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
    let watchers = Arc::new(Mutex::new(HashMap::new()));
    let wake = Arc::new(fdrive_indexer::server::Wake::default());
    {
        let (ctx, watchers, wake) = (Arc::clone(&ctx), Arc::clone(&watchers), Arc::clone(&wake));
        // The loop never returns; the thread ends with the test process.
        std::thread::spawn(move || fdrive_indexer::runner::run_root(&ctx, &watchers, &wake));
    }
    let wait = Duration::from_secs(10);
    assert!(common::root_env::wait_until(wait, || scans(&env) == 1));
    assert_eq!(watchers.lock().unwrap().get("r"), Some(&false));
    wake.set();
    assert!(common::root_env::wait_until(wait, || scans(&env) == 2));
}
