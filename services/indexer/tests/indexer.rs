//! Orchestration in `indexer` against a real filesystem, Postgres and a fake `ml` server
//! (ported from `test_indexer.py`).

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::fake_ml::{self, IMAGE_EMBED, IMAGE_HEALTH, TEXT_EMBED, TIKA};
use common::root_env::{
    Env, OFF, context_with, fake_sha, fv, jpeg, manual_clock, pdf, png, tesseract_available, wait_until,
};
use fdrive_indexer::backoff::Backoff;
use fdrive_indexer::db::{self, ManifestRow};
use fdrive_indexer::events::EventKind;
use fdrive_indexer::features::FeatureConfiguration;
use fdrive_indexer::files_marker::FILES_MARKER;
use fdrive_indexer::indexer::{
    self, FileStat, ImageStage, backfill_media, embed_missing, embed_thumbnail, emit_event, error_kind,
    exclusion_still_applies, guess_mime, process_file, process_thumbnails, safe_process, scan_once,
    should_retry_unchanged, unchanged_in_db, walk, watch_index, watch_mark_deleted, watch_rename, work_features,
};
use fdrive_indexer::settings::Settings;

const SECOND: Duration = Duration::from_secs(5);

fn configuration(revision: i64, values: fdrive_indexer::features::FeatureValues) -> FeatureConfiguration {
    FeatureConfiguration { revision, values }
}

fn hex_sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn walked(root: &std::path::Path) -> (Vec<String>, usize) {
    let mut seen = Vec::new();
    let mut errors = 0;
    walk(
        root,
        || errors += 1,
        |_, rel, _| {
            seen.push(rel);
            true
        },
    );
    (seen, errors)
}

// -- hashing and walking -------------------------------------------------------------------

#[test]
fn sha256_of_files_and_fifos() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.bin");
    std::fs::write(&file, b"hello world").unwrap();
    assert_eq!(fdrive_indexer::fsx::sha256_of(&file).unwrap(), hex_sha(b"hello world"));
    let fifo = dir.path().join("replaced.txt");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    // A FIFO is refused without blocking on it.
    let error = fdrive_indexer::fsx::sha256_of(&fifo).unwrap_err();
    assert!(error.to_string().contains("not a regular file"), "{error}");
}

#[test]
fn walk_skips_junk_and_sorts_directories() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for (rel, body) in [
        ("b.txt", "b"),
        ("A.txt", "a"),
        (".DS_Store", "junk"),
        ("._a.txt", "resource fork"),
        ("node_modules/x.txt", "x"),
        (".git/config", "x"),
        ("sub/c.txt", "c"),
        ("sub/deeper/d.txt", "d"),
        ("Zed/e.txt", "e"),
        // An upload fdrive's own storage is still writing, and names that only resemble one.
        ("sub/.fdrive-partial-0123456789abcdef", "unfinished"),
        ("sub/.fdrive-partial-0123456789abcdef.docx", "kept"),
    ] {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }
    assert!(
        std::process::Command::new("mkfifo")
            .arg(root.join("pipe"))
            .status()
            .unwrap()
            .success()
    );
    std::os::unix::fs::symlink(root.join("missing"), root.join("broken-link")).unwrap();
    std::os::unix::fs::symlink(root.join("sub"), root.join("linked-dir")).unwrap();
    let (seen, errors) = walked(root);
    assert_eq!(
        seen,
        vec![
            "A.txt",
            "b.txt",
            "sub/.fdrive-partial-0123456789abcdef.docx",
            "sub/c.txt",
            "sub/deeper/d.txt",
            "Zed/e.txt"
        ]
    );
    assert_eq!(errors, 0);

    // Stopping early ends the walk.
    let mut first = Vec::new();
    walk(
        root,
        || {},
        |_, rel, stat| {
            assert!(stat.size > 0 && stat.mtime_ns > 0);
            first.push(rel);
            false
        },
    );
    assert_eq!(first, vec!["A.txt"]);
}

#[test]
fn walk_reports_unreadable_directories_and_continues() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("good.txt"), "x").unwrap();
    std::fs::create_dir(root.join("bad")).unwrap();
    std::fs::write(root.join("bad/hidden.txt"), "x").unwrap();
    std::fs::set_permissions(root.join("bad"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let (seen, errors) = walked(root);
    std::fs::set_permissions(root.join("bad"), std::fs::Permissions::from_mode(0o755)).unwrap();
    if seen.contains(&"bad/hidden.txt".to_owned()) {
        return; // Running as root: permissions do not apply.
    }
    assert_eq!(seen, vec!["good.txt"]);
    assert_eq!(errors, 1);
    let (_, missing_errors) = walked(&root.join("missing"));
    assert_eq!(missing_errors, 1);
}

// -- pure decisions ------------------------------------------------------------------------

fn manifest_row(size: i64, mtime_ns: i64, status: &str, deleted: bool) -> ManifestRow {
    ManifestRow {
        size,
        mtime_ns,
        status: status.to_owned(),
        deleted,
        sha256: None,
        image_embedded: false,
        thumbnail_failed: false,
    }
}

#[test]
fn unchanged_in_db_needs_a_settled_live_row_of_the_same_version() {
    let stat = FileStat {
        size: 10,
        mtime_ns: 123,
    };
    assert!(!unchanged_in_db(None, stat));
    assert!(unchanged_in_db(Some(&manifest_row(10, 123, "indexed", false)), stat));
    assert!(!unchanged_in_db(Some(&manifest_row(10, 123, "pending", false)), stat));
    assert!(!unchanged_in_db(Some(&manifest_row(10, 123, "indexed", true)), stat));
    assert!(!unchanged_in_db(Some(&manifest_row(9, 123, "indexed", false)), stat));
    assert!(!unchanged_in_db(Some(&manifest_row(10, 124, "indexed", false)), stat));
}

#[test]
fn retry_rules_for_unchanged_rows() {
    let text = fv(false, true, false, false, false);
    let ocr = fv(false, true, true, false, false);
    let semantic = fv(false, true, false, true, false);
    assert!(!should_retry_unchanged("excluded:image_dir", &text));
    assert!(should_retry_unchanged("excluded:image_dir", &ocr));
    assert!(!should_retry_unchanged(
        "excluded:image_dir",
        &fv(false, false, true, false, false)
    ));
    assert!(should_retry_unchanged("disabled:text", &text));
    assert!(!should_retry_unchanged("disabled:text", &OFF));
    assert!(should_retry_unchanged("excluded", &text));
    assert!(!should_retry_unchanged("disabled:search_ocr", &text));
    assert!(should_retry_unchanged("disabled:search_ocr", &ocr));
    assert!(should_retry_unchanged("partial", &semantic));
    assert!(!should_retry_unchanged("partial", &text));
    for settled in ["indexed", "no_text", "none", "error", "empty"] {
        assert!(
            !should_retry_unchanged(settled, &fv(true, true, true, true, true)),
            "{settled}"
        );
    }
}

#[test]
fn work_features_follow_the_file_kind() {
    let all = fv(true, true, true, true, true);
    let names =
        |ext: Option<&str>, embed_only: bool, media_only: bool| work_features(&all, ext, embed_only, media_only);
    assert_eq!(
        names(None, false, false),
        ["textSearch", "semanticSearch", "thumbnails", "imageSearch"]
    );
    assert_eq!(names(Some(".txt"), false, false), ["textSearch", "semanticSearch"]);
    assert_eq!(
        names(Some(".jpg"), false, false),
        ["textSearch", "semanticSearch", "thumbnails", "imageSearch"]
    );
    assert_eq!(
        names(Some(".pdf"), false, false),
        ["textSearch", "semanticSearch", "thumbnails"]
    );
    assert_eq!(names(Some(".mp4"), false, false), ["textSearch", "thumbnails"]);
    assert_eq!(names(Some(".txt"), true, false), ["semanticSearch"]);
    assert_eq!(names(Some(".jpg"), false, true), ["thumbnails", "imageSearch"]);
    assert_eq!(names(Some(".jpg"), true, true), ["thumbnails", "imageSearch"]);
    assert!(work_features(&OFF, None, false, false).is_empty());
}

#[test]
fn mime_and_error_names() {
    assert_eq!(guess_mime("a.txt").as_deref(), Some("text/plain"));
    assert_eq!(guess_mime("deck.KEY").as_deref(), Some("application/vnd.apple.keynote"));
    assert_eq!(guess_mime("a.pages").as_deref(), Some("application/vnd.apple.pages"));
    assert_eq!(
        guess_mime("a.numbers").as_deref(),
        Some("application/vnd.apple.numbers")
    );
    assert_eq!(guess_mime("noext"), None);
    assert_eq!(error_kind(&anyhow::anyhow!("ValueError: bad")), "ValueError");
    assert_eq!(error_kind(&anyhow::anyhow!("no colon here")), "Error");
    assert_eq!(error_kind(&anyhow::anyhow!("two words: x")), "Error");
    let refused = reqwest::blocking::Client::new()
        .get(fake_ml::closed_url())
        .send()
        .unwrap_err();
    assert_eq!(error_kind(&anyhow::Error::new(refused)), "ConnectError");
    let ml = fake_ml::FakeMl::start();
    let status = reqwest::blocking::Client::new()
        .get(format!("{}/missing", ml.url))
        .send()
        .unwrap()
        .error_for_status()
        .unwrap_err();
    assert_eq!(error_kind(&anyhow::Error::new(status)), "HTTPStatusError");
    let builder = reqwest::blocking::Client::new().get("not a url").send().unwrap_err();
    assert_eq!(error_kind(&anyhow::Error::new(builder)), "HTTPError");
}

#[test]
fn exclusions_apply_until_their_limit_or_rule_changes() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let over = ctx.cfg.image_max_bytes.max(ctx.cfg.text_max_bytes) + 1;
    for path in ["large.png", "large.pdf", "large.docx"] {
        assert!(exclusion_still_applies(&ctx, path, over), "{path}");
        assert!(!exclusion_still_applies(&ctx, path, 1), "{path}");
    }
    assert!(!exclusion_still_applies(&ctx, "notes.txt", over));
    let mut settings = ctx.settings();
    settings.text_exclude_globs = vec!["r/private/*".to_owned()];
    settings.ocr_image_globs = vec!["r/scans/*".to_owned()];
    assert_eq!(
        ctx.set_settings(settings.clone()),
        vec!["text_exclude_globs", "ocr_image_globs"]
    );
    assert!(ctx.set_settings(settings).is_empty());
    assert!(exclusion_still_applies(&ctx, "private/notes.txt", 1));
    assert!(exclusion_still_applies(&ctx, "photos/a.png", 1));
    assert!(!exclusion_still_applies(&ctx, "scans/a.png", 1));
    assert_eq!(ctx.extractor().ocr_image_globs.patterns(), ["r/scans/*"]);
}

// -- process_file --------------------------------------------------------------------------

#[test]
fn a_new_text_file_is_hashed_chunked_and_embedded() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    let (path, stat) = env.write("a.txt", b"hello world");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    let row = env.row(&ctx, "a.txt");
    assert_eq!(row.status, "indexed");
    assert_eq!(row.sha256.unwrap(), hex_sha(b"hello world"));
    let mut c = env.client();
    let chunk = c
        .query_one("SELECT text, embedding IS NOT NULL FROM idx.chunks", &[])
        .unwrap();
    assert_eq!(
        (chunk.get::<_, String>(0), chunk.get::<_, bool>(1)),
        ("hello world".to_owned(), true)
    );
    let mime: Option<String> = c.query_one("SELECT mime FROM idx.files", &[]).unwrap().get(0);
    assert_eq!(mime.as_deref(), Some("text/plain"));
    let requests = env.ml.requests(TEXT_EMBED);
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].json(),
        serde_json::json!({"inputs": ["passage: hello world"], "truncate": true, "normalize": true})
    );
    // The same version is settled.
    assert!(!process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(safe_process(&ctx, &path, "a.txt", stat), "unchanged");
    assert_eq!(env.ml.count(TEXT_EMBED), 1);
}

#[test]
fn changed_and_pending_rows_are_rehashed() {
    for status in ["indexed", "pending"] {
        let env = Env::new();
        let ctx = env.ctx(fv(false, true, false, false, false));
        let (path, stat) = env.write("a.txt", b"hello");
        let id = env.seed(&ctx, "a.txt", "old", status);
        if status == "indexed" {
            env.client()
                .execute("UPDATE idx.files SET size = size - 1 WHERE id = $1", &[&id])
                .unwrap();
        }
        assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
        assert_eq!(env.row(&ctx, "a.txt").sha256.unwrap(), hex_sha(b"hello"), "{status}");
    }
}

#[test]
fn a_rejected_embedding_marks_the_file_partial_and_records_the_failure() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    env.ml.fail(TEXT_EMBED, 413);
    for name in ["a.txt", "b.txt"] {
        let (path, stat) = env.write(name, b"hello");
        assert!(process_file(&ctx, &path, name, stat).unwrap());
        let row = env.row(&ctx, name);
        assert_eq!(
            (row.status.as_str(), row.error.as_deref()),
            ("partial", Some("embed:HTTPStatusError"))
        );
    }
    // A backend that rejects one payload is not an outage: every file is tried.
    assert_eq!(env.ml.count(TEXT_EMBED), 2);
    assert!(!ctx.embed_backoff.waiting());
    assert_eq!(
        env.unresolved(),
        [("a.txt", "semanticSearch"), ("b.txt", "semanticSearch")]
            .map(|(p, f)| (p.to_owned(), f.to_owned()))
            .into()
    );
    // Chunks keep their text without vectors for a later retry.
    assert_eq!(env.count("idx.chunks"), 2);
}

#[test]
fn an_unreachable_embed_backend_is_probed_once_and_not_a_file_failure() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.embed_url = fake_ml::closed_url();
    let ctx = context_with(cfg, fv(false, true, false, true, false), |_| {});
    for name in ["a.txt", "b.txt", "c.txt"] {
        let (path, stat) = env.write(name, b"hello");
        assert!(process_file(&ctx, &path, name, stat).unwrap());
    }
    let errors: Vec<(String, Option<String>)> = ["a.txt", "b.txt", "c.txt"]
        .iter()
        .map(|n| {
            let row = env.row(&ctx, n);
            (row.status, row.error)
        })
        .collect();
    assert_eq!(errors[0], ("partial".to_owned(), Some("embed:ConnectError".to_owned())));
    // The rest were not sent anywhere: the pause already knew.
    for later in &errors[1..] {
        assert_eq!(*later, ("partial".to_owned(), Some("embed:unavailable".to_owned())));
    }
    assert!(ctx.embed_backoff.paused());
    assert!(env.unresolved().is_empty());
}

#[test]
fn embedding_resumes_once_the_pause_expires() {
    let env = Env::new();
    let (clock, now) = manual_clock();
    let ctx = env.ctx_with(fv(false, true, false, true, false), |ctx| {
        ctx.embed_backoff = Backoff::new(Duration::from_secs(60), now);
    });
    assert!(ctx.embed_backoff.note_failure());
    let (path, stat) = env.write("a.txt", b"hello");
    process_file(&ctx, &path, "a.txt", stat).unwrap();
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    assert_eq!(env.ml.count(TEXT_EMBED), 0);
    clock.store(60, Ordering::SeqCst);
    let (path, stat) = env.write("b.txt", b"hello");
    process_file(&ctx, &path, "b.txt", stat).unwrap();
    assert_eq!(env.status(&ctx, "b.txt"), "indexed");
    assert!(!ctx.embed_backoff.waiting());
    // The partial row is then filled in by the embedding retry.
    assert!(embed_missing(&ctx, "a.txt", None).unwrap());
    assert_eq!(env.status(&ctx, "a.txt"), "indexed");
}

#[test]
fn extraction_statuses() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let cases: [(&str, &[u8], &str, Option<&str>); 6] = [
        ("broken.pdf", b"not a pdf", "error", None),
        ("a.zip", b"PK", "none", None),
        ("empty.txt", b"", "empty", None),
        ("photo.png", b"png", "disabled:search_ocr", None),
        ("doc.docx", b"docx bytes", "partial", None),
        ("short.docx", b"docx", "no_text", None),
    ];
    for (name, bytes, status, error) in cases {
        if name == "short.docx" {
            env.ml.set_tika_text("tiny");
        }
        let (path, stat) = env.write(name, bytes);
        assert!(process_file(&ctx, &path, name, stat).unwrap());
        let row = env.row(&ctx, name);
        assert_eq!(row.status, status, "{name}");
        if let Some(error) = error {
            assert_eq!(row.error.as_deref(), Some(error));
        }
    }
    assert!(env.row(&ctx, "broken.pdf").error.unwrap().starts_with("FileDataError"));
    assert_eq!(
        env.unresolved(),
        [("broken.pdf".to_owned(), "textSearch".to_owned())].into()
    );
    assert_eq!(env.ml.count(TIKA), 2);
    assert_eq!(env.ml.requests(TIKA)[0].body, b"docx bytes");
    // An unsupported document is an error, not a crash.
    env.ml.fail(TIKA, 422);
    let (path, stat) = env.write("weird.docx", b"weird");
    process_file(&ctx, &path, "weird.docx", stat).unwrap();
    assert_eq!(
        (env.status(&ctx, "weird.docx"), env.row(&ctx, "weird.docx").error),
        ("error".to_owned(), Some("unsupported".to_owned()))
    );
}

#[test]
fn excluded_text_stays_quiet_until_the_rule_is_removed() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let mut settings: Settings = ctx.settings();
    settings.text_exclude_globs = vec!["r/*.txt".to_owned()];
    ctx.set_settings(settings.clone());
    let (path, stat) = env.write("a.txt", b"excluded");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    let row = env.row(&ctx, "a.txt");
    assert_eq!(
        (row.status.as_str(), row.error.as_deref()),
        ("excluded", Some("excluded:prefix"))
    );
    assert!(env.unresolved().is_empty());
    let result = scan_once(&ctx);
    assert_eq!((result.seen, result.changed, result.errors), (1, 0, 0));
    assert!(!process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.events(), ["created"]);
    settings.text_exclude_globs = vec![];
    ctx.set_settings(settings);
    assert_eq!(scan_once(&ctx).changed, 1);
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    assert_eq!(env.events(), ["created"], "re-deriving the same version emits nothing");
}

#[test]
fn semantic_search_off_keeps_chunks_without_calling_embed() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let (path, stat) = env.write("a.txt", b"searchable text");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    let row = env.row(&ctx, "a.txt");
    assert_eq!((row.status.as_str(), row.error), ("partial", None));
    assert_eq!(env.ml.count(TEXT_EMBED), 0);
    assert_eq!(env.count("idx.chunks"), 1);
}

#[test]
fn image_search_alone_still_builds_internal_thumbnails() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, false, false, false, true));
    let bytes = png(64, 48);
    let (path, stat) = env.write("a.png", &bytes);
    assert!(process_file(&ctx, &path, "a.png", stat).unwrap());
    let sha = hex_sha(&bytes);
    assert!(env.has_thumbnails(&sha));
    assert_eq!(env.count("app.thumbnails"), 2);
    assert_eq!(env.status(&ctx, "a.png"), "disabled:text");
    assert_eq!(
        db::image_embedding_model(&mut env.client(), &sha).unwrap().as_deref(),
        Some("model-a")
    );
}

#[test]
fn a_scan_deletes_nothing_from_a_folder_without_this_installations_marker() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.files_folder_recheck = Duration::ZERO;
    });
    env.write("alice/a.txt", b"one");
    env.write("alice/b.txt", b"two");
    assert_eq!(scan_once(&ctx).changed, 2);
    let mut indexed: Vec<String> = env.statuses(&ctx).into_keys().collect();
    indexed.sort();
    assert_eq!(
        indexed,
        ["alice/a.txt", "alice/b.txt"],
        "the marker itself is never indexed"
    );
    let live = || env.count("idx.files WHERE deleted_at IS NULL");

    // An empty folder mounted in its place, as Compose does when FDRIVE_FILES_DIR is unset.
    std::fs::remove_dir_all(env.path("alice")).unwrap();
    let marker = env.path(FILES_MARKER);
    let id = std::fs::read_to_string(&marker).unwrap();
    std::fs::remove_file(&marker).unwrap();
    assert_eq!(
        scan_once(&ctx),
        indexer::ScanResult {
            errors: 1,
            ..Default::default()
        }
    );
    assert_eq!(live(), 2);
    for refused in ["\n", "0b8f4f0e-6a4c-4f6e-8d33-7f1e2a9c4b21\n"] {
        std::fs::write(&marker, refused).unwrap();
        assert_eq!(scan_once(&ctx).deleted, 0, "{refused:?}");
        assert_eq!(live(), 2);
    }

    // This installation's folder again: the files really are gone.
    std::fs::write(&marker, id).unwrap();
    assert_eq!(scan_once(&ctx).deleted, 2);
    assert_eq!(live(), 0);
}

#[test]
fn the_marker_verdict_is_reused_and_survives_a_database_outage() {
    let env = Env::new();
    let cfg = Arc::new(env.config());
    let root_id = db::upsert_root(&mut env.client(), "r").unwrap();
    let mut ctx = indexer::RootContext::new("r", root_id, env.root.clone(), Arc::clone(&cfg), common::features(OFF));
    ctx.files_folder_recheck = Duration::from_secs(3600);
    assert!(!ctx.files_folder_verified(), "no installation id recorded yet");
    common::mark_files_folder(&env.url, &env.root);
    assert!(!ctx.files_folder_verified(), "the last verdict is reused for a moment");
    ctx.files_folder_recheck = Duration::ZERO;
    assert!(ctx.files_folder_verified());
    ctx.db = db::Db {
        url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
        retries: 1,
    };
    assert!(ctx.files_folder_verified(), "an outage keeps the last verdict");

    let mut offline = indexer::RootContext::new("r", root_id, env.root.clone(), cfg, common::features(OFF));
    offline.db = db::Db {
        url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
        retries: 1,
    };
    assert!(
        !offline.files_folder_verified(),
        "nothing to keep without a first verdict"
    );
}

#[test]
fn nothing_is_processed_while_every_feature_is_off() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    let (path, stat) = env.write("a.txt", b"untouched");
    assert!(!process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.count("idx.files"), 0);
    assert_eq!(scan_once(&ctx), Default::default());
    assert_eq!(watch_index(&ctx, &path, "a.txt", stat).status, "disabled");
    assert_eq!(watch_mark_deleted(&ctx, "a.txt", false), 0);
    assert_eq!(watch_rename(&ctx, "a.txt", "b.txt", false), 0);
    assert!(ctx.activity.snapshot().is_empty());
}

#[test]
fn thumbnails_are_generated_for_real_images() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, false, false));
    let bytes = jpeg(80, 40, 1);
    let (path, stat) = env.write("a.jpg", &bytes);
    assert!(process_file(&ctx, &path, "a.jpg", stat).unwrap());
    let sha = hex_sha(&bytes);
    assert!(env.has_thumbnails(&sha));
    let rows: Vec<(i32, i32, i32)> = env
        .client()
        .query("SELECT size, width, height FROM app.thumbnails ORDER BY size", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(rows, vec![(256, 80, 40), (1024, 80, 40)]);
    // A broken image fails its thumbnail, not the file.
    let (path, stat) = env.write("broken.png", b"not a png");
    assert!(process_file(&ctx, &path, "broken.png", stat).unwrap());
    assert_eq!(env.status(&ctx, "broken.png"), "disabled:search_ocr");
    assert_eq!(
        env.unresolved(),
        [("broken.png".to_owned(), "thumbnails".to_owned())].into()
    );
}

#[test]
fn thumbnail_skips_do_not_resolve_failures_but_resolving_skips_do() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    fdrive_indexer::failures::report(
        &ctx.db,
        ctx.root_id,
        "empty.png",
        "thumbnails",
        fdrive_indexer::failures::failed("DecodeError: original issue"),
    );
    let sha = fake_sha('b');
    assert_eq!(
        process_thumbnails(&ctx, &env.path("empty.png"), "empty.png", ".png", &sha, 0, false),
        (true, true)
    );
    assert_eq!(
        process_thumbnails(&ctx, &env.path("a.txt"), "a.txt", ".txt", &sha, 10, false),
        (true, true)
    );
    assert_eq!(env.unresolved().len(), 1);
}

// -- image embeddings ----------------------------------------------------------------------

#[test]
fn embed_thumbnail_is_a_no_op_without_an_image_unit() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.image_embed_url = String::new();
    let ctx = context_with(cfg, fv(true, false, false, false, true), |_| {});
    env.fake_thumbnail("ab");
    assert!(!embed_thumbnail(&ctx, "ab", &mut Vec::new()).unwrap());
    assert!(env.ml.seen().is_empty());
    // A watcher change embeds inline when there is no unit to hand it to.
    let bytes = png(8, 8);
    let (path, stat) = env.write("a.png", &bytes);
    let result = watch_index(&ctx, &path, "a.png", stat);
    assert_eq!(result.status, "indexed");
    assert!(result.deferred.is_empty());
    assert_eq!(result.outcomes.unwrap()["imageSearch"], (true, true));
}

#[test]
fn embed_thumbnail_waits_while_the_unit_is_unhealthy() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.fake_thumbnail("ab");
    env.ml.fail(IMAGE_HEALTH, 503);
    assert!(!embed_thumbnail(&ctx, "ab", &mut Vec::new()).unwrap());
    assert_eq!(env.ml.count(IMAGE_EMBED), 0);
    assert!(ctx.image_embed_backoff.paused());
    // A wrong dimension is a hard stop too.
    let other = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_health_ttl = Duration::ZERO
    });
    env.ml
        .respond(IMAGE_HEALTH, 200, r#"{"status":"ok","model":"m","dim":512}"#);
    assert!(!embed_thumbnail(&other, "ab", &mut Vec::new()).unwrap());
    assert!(other.image_embed_backoff.paused());
    assert_eq!(env.ml.count(IMAGE_EMBED), 0);
}

#[test]
fn embed_thumbnail_embeds_skips_current_and_replaces_stale_models() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    let mut errors = Vec::new();
    // Thumbnailing already reported a missing thumbnail.
    assert!(!embed_thumbnail(&ctx, "missing", &mut errors).unwrap());
    assert!(errors.is_empty());

    env.fake_thumbnail("aa");
    assert!(embed_thumbnail(&ctx, "aa", &mut errors).unwrap());
    let mut c = env.client();
    assert_eq!(
        db::image_embedding_model(&mut c, "aa").unwrap().as_deref(),
        Some("model-a")
    );
    let posted = env.ml.requests(IMAGE_EMBED);
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].images(), 1);
    assert!(String::from_utf8_lossy(&posted[0].body).contains("WEBP"));

    // Already on the configured model: nothing to send.
    assert!(embed_thumbnail(&ctx, "aa", &mut errors).unwrap());
    assert_eq!(env.ml.count(IMAGE_EMBED), 1);

    env.fake_thumbnail("bb");
    db::upsert_image_embedding(&mut c, "bb", "model-old", &[0.5; 1024]).unwrap();
    assert!(embed_thumbnail(&ctx, "bb", &mut errors).unwrap());
    assert_eq!(
        db::image_embedding_model(&mut c, "bb").unwrap().as_deref(),
        Some("model-a")
    );

    env.fake_thumbnail("cc");
    env.ml
        .respond(IMAGE_EMBED, 200, r#"{"model":"model-a","dim":1024,"embeddings":[]}"#);
    assert!(!embed_thumbnail(&ctx, "cc", &mut errors).unwrap());
    assert_eq!(db::image_embedding_model(&mut c, "cc").unwrap(), None);

    // An unreadable thumbnail is reported as an error.
    let thumb = env.thumb_path("dd", 256);
    std::fs::create_dir_all(&thumb).unwrap();
    assert!(!embed_thumbnail(&ctx, "dd", &mut errors).unwrap());
    assert_eq!(errors.len(), 1);
    assert!(errors[0].starts_with("OSError"));
}

#[test]
fn image_embedding_resumes_after_its_pause() {
    let env = Env::new();
    let (clock, now) = manual_clock();
    let ctx = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_embed_backoff = Backoff::new(Duration::from_secs(60), now);
    });
    env.fake_thumbnail("ab");
    assert!(ctx.image_embed_backoff.note_failure());
    assert!(!embed_thumbnail(&ctx, "ab", &mut Vec::new()).unwrap());
    assert!(env.ml.seen().is_empty(), "a paused unit is not probed");
    clock.store(61, Ordering::SeqCst);
    assert!(embed_thumbnail(&ctx, "ab", &mut Vec::new()).unwrap());
    assert!(!ctx.image_embed_backoff.waiting());
    assert_eq!(
        db::image_embedding_model(&mut env.client(), "ab").unwrap().as_deref(),
        Some("model-a")
    );
}

#[test]
fn an_image_unit_outage_is_probed_once_per_backoff_window() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.image_embed_url = fake_ml::closed_url();
    let (clock, now) = manual_clock();
    let ctx = context_with(cfg, fv(true, false, false, false, true), |c| {
        c.image_embed_backoff = Backoff::new(Duration::from_secs(60), now);
    });
    for i in 0..100 {
        assert!(!embed_thumbnail(&ctx, &i.to_string(), &mut Vec::new()).unwrap());
    }
    assert!(ctx.image_embed_backoff.paused());
    clock.store(61, Ordering::SeqCst);
    assert!(!ctx.image_embed_backoff.paused());
    assert!(!embed_thumbnail(&ctx, "retry", &mut Vec::new()).unwrap());
    assert!(ctx.image_embed_backoff.paused(), "a failed re-probe pauses again");

    // The same through the fake: one health probe per window.
    let (clock, now) = manual_clock();
    let probed = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_embed_backoff = Backoff::new(Duration::from_secs(60), now);
        c.image_health_ttl = Duration::ZERO;
    });
    env.ml.fail(IMAGE_HEALTH, 500);
    for i in 0..100 {
        assert!(!embed_thumbnail(&probed, &i.to_string(), &mut Vec::new()).unwrap());
    }
    assert_eq!(env.ml.count(IMAGE_HEALTH), 1);
    clock.store(61, Ordering::SeqCst);
    assert!(!embed_thumbnail(&probed, "retry", &mut Vec::new()).unwrap());
    assert_eq!(env.ml.count(IMAGE_HEALTH), 2);
}

#[test]
fn image_health_is_reused_until_it_expires() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    for sha in ["aa", "bb"] {
        env.fake_thumbnail(sha);
        assert!(embed_thumbnail(&ctx, sha, &mut Vec::new()).unwrap());
    }
    assert_eq!(env.ml.count(IMAGE_HEALTH), 1);
    let expiring = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_health_ttl = Duration::ZERO
    });
    env.fake_thumbnail("cc");
    assert!(embed_thumbnail(&expiring, "cc", &mut Vec::new()).unwrap());
    assert!(embed_thumbnail(&expiring, "cc", &mut Vec::new()).unwrap());
    assert_eq!(env.ml.count(IMAGE_HEALTH), 3);
}

#[test]
fn an_unanswered_probe_keeps_a_healthy_answer_but_reported_problems_win() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_health_ttl = Duration::ZERO
    });
    let healthy = fdrive_indexer::image_embed::Health {
        status: "ok".into(),
        model: Some("model-a".into()),
        dim: Some(1024),
    };
    let loading = fdrive_indexer::image_embed::Health {
        status: "loading".into(),
        model: Some("model-a".into()),
        dim: None,
    };
    let mut seen = Vec::new();
    // Not yet known, healthy, busy past the probe timeout, restarted, down.
    env.ml.fail(IMAGE_HEALTH, 500);
    seen.push(ctx.image_embed_status());
    env.ml.reset(IMAGE_HEALTH);
    seen.push(ctx.image_embed_status());
    env.ml.fail(IMAGE_HEALTH, 500);
    seen.push(ctx.image_embed_status());
    env.ml
        .respond(IMAGE_HEALTH, 200, r#"{"status":"loading","model":"model-a"}"#);
    seen.push(ctx.image_embed_status());
    env.ml.fail(IMAGE_HEALTH, 500);
    seen.push(ctx.image_embed_status());
    assert_eq!(
        seen,
        vec![None, Some(healthy.clone()), Some(healthy), Some(loading), None]
    );
}

#[test]
fn a_busy_health_probe_does_not_pause_image_embedding() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(true, false, false, false, true), |c| {
        c.image_health_ttl = Duration::ZERO
    });
    env.fake_thumbnail("aa");
    assert!(embed_thumbnail(&ctx, "aa", &mut Vec::new()).unwrap());
    env.ml.fail(IMAGE_HEALTH, 500);
    env.fake_thumbnail("bb");
    assert!(embed_thumbnail(&ctx, "bb", &mut Vec::new()).unwrap());
    assert!(!ctx.image_embed_backoff.waiting());
}

#[test]
fn image_embedding_follows_process_file() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, true, true));
    // A text file never asks the image unit anything.
    let (path, stat) = env.write("a.txt", b"hello");
    process_file(&ctx, &path, "a.txt", stat).unwrap();
    assert_eq!(env.ml.count(IMAGE_HEALTH) + env.ml.count(IMAGE_EMBED), 0);

    // A rejected embedding fails only image search.
    env.ml.fail(IMAGE_EMBED, 500);
    let bytes = png(16, 16);
    let (path, stat) = env.write("a.png", &bytes);
    assert!(process_file(&ctx, &path, "a.png", stat).unwrap());
    assert_eq!(
        env.unresolved(),
        [("a.png".to_owned(), "imageSearch".to_owned())].into()
    );
    assert!(env.has_thumbnails(&hex_sha(&bytes)));

    // Without a thumbnail there is nothing to embed: an error that names the cause.
    env.ml.reset(IMAGE_EMBED);
    let (path, stat) = env.write("broken.png", b"broken");
    process_file(&ctx, &path, "broken.png", stat).unwrap();
    let message: String = env
        .client()
        .query_one(
            "SELECT message FROM idx.processing_failures WHERE path = 'broken.png' AND feature = 'imageSearch'",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(message.starts_with("Thumbnail unavailable"));
}

// -- embed_missing -------------------------------------------------------------------------

#[test]
fn embed_missing_fills_partial_chunks_and_marks_indexed() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    let mut c = env.client();
    env.write("a.txt", b"x");
    let id = env.seed(&ctx, "a.txt", "sha1", "partial");
    db::insert_chunks(&mut c, id, &["hello".into()], &[None]).unwrap();
    assert!(embed_missing(&ctx, "a.txt", Some("sha1")).unwrap());
    assert_eq!(env.status(&ctx, "a.txt"), "indexed");
    assert!(
        db::chunks_missing_embeddings(&mut c, ctx.root_id, "a.txt")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        env.ml.requests(TEXT_EMBED)[0].json()["inputs"],
        serde_json::json!(["passage: hello"])
    );

    // No missing chunks: marked indexed without a request.
    env.write("b.txt", b"y");
    env.seed(&ctx, "b.txt", "sha2", "partial");
    assert!(embed_missing(&ctx, "b.txt", None).unwrap());
    assert_eq!(env.status(&ctx, "b.txt"), "indexed");
    assert_eq!(env.ml.count(TEXT_EMBED), 1);

    // The source changed since its text was read.
    let error = embed_missing(&ctx, "b.txt", Some("other")).unwrap_err();
    assert!(error.to_string().contains("Source changed"));

    // A rejected request fails the file.
    env.write("c.txt", b"z");
    let id = env.seed(&ctx, "c.txt", "sha3", "partial");
    db::insert_chunks(&mut c, id, &["words".into()], &[None]).unwrap();
    env.ml.fail(TEXT_EMBED, 500);
    assert!(embed_missing(&ctx, "c.txt", None).is_err());
    assert_eq!(env.status(&ctx, "c.txt"), "partial");
    assert_eq!(
        env.unresolved(),
        [("c.txt".to_owned(), "semanticSearch".to_owned())].into()
    );

    // Semantic search off: nothing to do.
    let off = env.ctx(fv(false, true, false, false, false));
    assert!(embed_missing(&off, "c.txt", None).unwrap());
    assert_eq!(env.status(&ctx, "c.txt"), "partial");
}

#[test]
fn embed_missing_leaves_the_row_alone_while_the_backend_is_down() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.embed_url = fake_ml::closed_url();
    let ctx = context_with(cfg, fv(false, true, false, true, false), |_| {});
    env.write("a.txt", b"hello");
    let id = env.seed(&ctx, "a.txt", "sha1", "partial");
    db::insert_chunks(&mut env.client(), id, &["hello".into()], &[None]).unwrap();
    assert!(!embed_missing(&ctx, "a.txt", None).unwrap());
    assert!(ctx.embed_backoff.paused());
    // Paused: not even tried.
    assert!(!embed_missing(&ctx, "a.txt", None).unwrap());
    // Neither counted as an error nor marked indexed: the next scan retries it.
    assert_eq!(scan_once(&ctx).errors, 0);
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
    assert!(env.unresolved().is_empty());
}

// -- feature transitions -------------------------------------------------------------------

#[test]
fn enabling_thumbnails_backfills_unchanged_media_without_reextracting() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    env.write("a.jpg", &jpeg(32, 32, 3));
    env.write("archive.bin", b"binary");
    let sha = fake_sha('a');
    env.seed(&ctx, "a.jpg", &sha, "indexed");
    env.seed(&ctx, "archive.bin", &fake_sha('b'), "indexed");
    assert!(ctx.set_features(configuration(3, fv(true, false, false, false, false))));
    assert!(ctx.needs_media_backfill());
    let result = scan_once(&ctx);
    assert_eq!((result.seen, result.changed, result.errors), (2, 0, 0));
    // The stored key was reused, not a fresh hash of the file.
    assert!(env.has_thumbnails(&sha));
    let row = env.row(&ctx, "a.jpg");
    assert_eq!(
        (row.status.as_str(), row.sha256.as_deref()),
        ("indexed", Some(sha.as_str()))
    );
    assert_eq!(env.status(&ctx, "archive.bin"), "indexed");
    assert!(!ctx.needs_media_backfill());
    assert!(env.ml.seen().is_empty());
    assert!(!ctx.set_features(configuration(4, fv(true, false, false, false, false))));
}

#[test]
fn a_failed_media_backfill_stays_pending_until_it_succeeds() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    let good = jpeg(32, 32, 9);
    let (path, _) = env.write("a.jpg", &vec![0u8; good.len()]);
    let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
    let sha = fake_sha('c');
    env.seed(&ctx, "a.jpg", &sha, "indexed");
    ctx.set_features(configuration(3, fv(true, false, false, false, false)));
    assert_eq!(scan_once(&ctx).errors, 1);
    assert!(ctx.needs_media_backfill());
    assert_eq!(env.attempts("a.jpg", "thumbnails"), Some(1));

    // The same version (size and mtime) now decodes.
    std::fs::write(&path, &good).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    assert_eq!(scan_once(&ctx).errors, 0);
    assert!(env.has_thumbnails(&sha));
    assert!(!ctx.needs_media_backfill());
    assert!(env.unresolved().is_empty());
}

#[test]
fn backfill_media_needs_a_stored_key() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    let (path, stat) = env.write("a.jpg", &jpeg(8, 8, 1));
    assert!(!backfill_media(&ctx, &path, "a.jpg", stat).unwrap());
    let off = env.ctx(fv(false, true, false, false, false));
    assert!(backfill_media(&off, &path, "a.jpg", stat).unwrap());
}

#[test]
fn enabling_text_reprocesses_unchanged_disabled_rows_with_their_stored_key() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    env.write("a.txt", b"same bytes");
    let sha = fake_sha('d');
    env.seed(&ctx, "a.txt", &sha, "disabled:text");
    ctx.set_features(configuration(3, fv(false, true, false, false, false)));
    assert!(!ctx.needs_media_backfill());
    assert_eq!(scan_once(&ctx).changed, 1);
    let row = env.row(&ctx, "a.txt");
    assert_eq!(
        (row.status.as_str(), row.sha256.as_deref()),
        ("partial", Some(sha.as_str()))
    );
    assert!(env.events().is_empty(), "the same version emits nothing");
}

#[test]
fn a_partial_row_retries_only_its_embeddings() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    env.write("a.txt", b"already indexed");
    let id = env.seed(&ctx, "a.txt", "sha", "partial");
    db::insert_chunks(&mut env.client(), id, &["saved text".into()], &[None]).unwrap();
    let result = scan_once(&ctx);
    assert_eq!((result.changed, result.errors), (1, 0));
    assert_eq!(env.status(&ctx, "a.txt"), "indexed");
    assert_eq!(
        env.ml.requests(TEXT_EMBED)[0].json()["inputs"],
        serde_json::json!(["passage: saved text"])
    );
    let text: String = env
        .client()
        .query_one("SELECT text FROM idx.chunks", &[])
        .unwrap()
        .get(0);
    assert_eq!(text, "saved text");
    let semantic = Env::snapshot(&ctx, "semanticSearch");
    assert_eq!(
        (semantic["state"].as_str(), semantic["processed"].as_u64()),
        (Some("completed"), Some(1))
    );

    // A retry the backend rejects is counted and leaves the row partial.
    env.write("b.txt", b"other");
    let id = env.seed(&ctx, "b.txt", "sha2", "partial");
    db::insert_chunks(&mut env.client(), id, &["more".into()], &[None]).unwrap();
    env.ml.fail(TEXT_EMBED, 500);
    assert_eq!(scan_once(&ctx).errors, 1);
    assert_eq!(env.status(&ctx, "b.txt"), "partial");
}

#[test]
fn a_partial_row_with_missing_media_gets_both() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, true, false));
    let bytes = jpeg(16, 16, 4);
    env.write("a.jpg", &bytes);
    let sha = fake_sha('e');
    let id = env.seed(&ctx, "a.jpg", &sha, "partial");
    db::insert_chunks(&mut env.client(), id, &["ocr text".into()], &[None]).unwrap();
    let result = scan_once(&ctx);
    assert_eq!((result.changed, result.errors), (1, 0));
    assert_eq!(env.status(&ctx, "a.jpg"), "indexed");
    assert!(env.has_thumbnails(&sha));
}

#[test]
fn search_ocr_readmits_image_dir_exclusions() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("a.png", &png(8, 8));
    let id = env.seed(&ctx, "a.png", "sha", "pending");
    db::update_file_status(&mut env.client(), id, "excluded", 0, Some("excluded:image_dir")).unwrap();
    // OCR off: the exclusion still holds and nothing is re-read.
    let result = scan_once(&ctx);
    assert_eq!((result.changed, result.errors), (0, 0));
    assert_eq!(env.status(&ctx, "a.png"), "excluded");
    // OCR on: the image is read again.
    ctx.set_features(configuration(4, fv(false, true, true, false, false)));
    scan_once(&ctx);
    assert_ne!(env.status(&ctx, "a.png"), "excluded");
}

#[test]
fn missing_derivatives_are_rebuilt_after_a_restart_without_a_transition() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    env.write("a.jpg", &jpeg(16, 16, 5));
    let sha = fake_sha('f');
    env.seed(&ctx, "a.jpg", &sha, "indexed");
    assert!(!ctx.needs_media_backfill());
    scan_once(&ctx);
    assert!(env.has_thumbnails(&sha));
    // Present derivatives are left alone on the next scan.
    let thumb = env.thumb_path(&sha, 256);
    let before = std::fs::metadata(&thumb).unwrap().modified().unwrap();
    assert_eq!(scan_once(&ctx).changed, 0);
    assert_eq!(std::fs::metadata(&thumb).unwrap().modified().unwrap(), before);
}

#[test]
fn over_budget_media_without_a_thumbnail_is_never_retried() {
    let env = Env::new();
    let mut cfg = env.config();
    cfg.thumb_max_bytes = 1;
    let ctx = context_with(cfg, fv(true, false, false, false, false), |_| {});
    env.write("large.jpg", &jpeg(16, 16, 6));
    let sha = fake_sha('a');
    env.seed(&ctx, "large.jpg", &sha, "indexed");
    let result = scan_once(&ctx);
    assert_eq!((result.changed, result.errors), (0, 0));
    assert_eq!(env.thumbnail_files(), 0);
    assert_eq!(env.row(&ctx, "large.jpg").sha256.as_deref(), Some(sha.as_str()));
}

#[test]
fn disabled_rows_wait_until_their_feature_is_enabled() {
    for status in ["disabled:search_ocr", "disabled:text"] {
        let env = Env::new();
        let text_on = status == "disabled:search_ocr";
        let ctx = env.ctx(fv(false, text_on, false, false, false));
        env.write("photo.jpg", &jpeg(8, 8, 7));
        let sha = fake_sha('9');
        env.seed(&ctx, "photo.jpg", &sha, status);
        let result = scan_once(&ctx);
        assert_eq!(result.changed, 0, "{status}");
        assert_eq!(env.status(&ctx, "photo.jpg"), status);
        ctx.set_features(configuration(8, fv(false, true, true, false, false)));
        scan_once(&ctx);
        // Re-read with OCR: what it finds depends on tesseract, but it is no longer skipped.
        assert_ne!(env.status(&ctx, "photo.jpg"), status);
        assert_eq!(env.row(&ctx, "photo.jpg").sha256.as_deref(), Some(sha.as_str()));
    }
}

#[test]
fn ocr_off_skips_images_and_text_less_pdfs_and_settles_earlier_failures() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("photo.jpg", &jpeg(8, 8, 8));
    env.write("scan.pdf", &pdf(&[""]));
    env.write(
        "text.pdf",
        &pdf(&["A text layer with enough characters to be indexed here"]),
    );
    env.client()
        .execute(
            "INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id) \
             VALUES ($1::int2, 'scan.pdf', 'textSearch', 'error', 'an earlier version failed', 'op')",
            &[&(ctx.root_id as i16)],
        )
        .unwrap();
    assert_eq!(scan_once(&ctx).changed, 3);
    let statuses = env.statuses(&ctx);
    assert_eq!(statuses["photo.jpg"], "disabled:search_ocr");
    assert_eq!(statuses["scan.pdf"], "disabled:search_ocr");
    assert_eq!(statuses["text.pdf"], "partial");
    assert!(env.unresolved().is_empty());
    assert_eq!(scan_once(&ctx).changed, 0);
}

#[test]
fn ocr_reads_skipped_files_once_and_never_repeats_a_text_less_result() {
    if !tesseract_available() {
        eprintln!("skipped: tesseract is not installed");
        return;
    }
    let env = Env::new();
    let ocr_off = fv(false, true, false, false, false);
    let ocr_on = fv(false, true, true, false, false);
    let ctx = env.ctx(ocr_off);
    env.write("photo.jpg", &jpeg(8, 8, 8));
    env.write("scan.pdf", &pdf(&[""]));
    scan_once(&ctx);
    ctx.set_features(configuration(8, ocr_on));
    assert_eq!(scan_once(&ctx).changed, 2);
    let statuses = env.statuses(&ctx);
    assert_eq!(
        (statuses["photo.jpg"].as_str(), statuses["scan.pdf"].as_str()),
        ("no_text", "no_text")
    );
    assert_eq!(scan_once(&ctx).changed, 0);
    ctx.set_features(configuration(9, ocr_off));
    scan_once(&ctx);
    ctx.set_features(configuration(10, ocr_on));
    assert_eq!(scan_once(&ctx).changed, 0);
}

// -- scans ---------------------------------------------------------------------------------

#[test]
fn a_scan_indexes_new_files_and_sweeps_vanished_rows() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    let mut c = env.client();
    env.write("kept.txt", b"still here");
    env.seed(&ctx, "kept.txt", "sha", "indexed");
    db::upsert_file(
        &mut c,
        &db::NewFile {
            root_id: ctx.root_id,
            path: "gone.txt",
            name: "gone.txt",
            ext: ".txt",
            size: 1,
            mtime_ns: 1,
            sha256: "shagone",
            mime: None,
        },
    )
    .unwrap();
    env.write("a.txt", b"hello");
    env.write("b.txt", b"hello again");
    let result = scan_once(&ctx);
    assert_eq!(
        (result.seen, result.changed, result.deleted, result.errors),
        (3, 2, 1, 0)
    );
    let manifest = db::scan_manifest(&mut c, ctx.root_id).unwrap();
    assert!(manifest["gone.txt"].deleted);
    assert_eq!(manifest["a.txt"].status, "indexed");
    assert_eq!(manifest["kept.txt"].status, "indexed");
    let scan = c
        .query_one(
            "SELECT files_seen, files_changed, files_deleted, errors, finished_at IS NOT NULL FROM idx.scans",
            &[],
        )
        .unwrap();
    assert_eq!(
        (
            scan.get::<_, i32>(0),
            scan.get::<_, i32>(1),
            scan.get::<_, i32>(2),
            scan.get::<_, i32>(3),
            scan.get::<_, bool>(4)
        ),
        (3, 2, 1, 0, true)
    );
    assert_eq!(env.events(), ["created", "created"]);
    let text = Env::snapshot(&ctx, "textSearch");
    assert_eq!(
        (
            text["kind"].as_str(),
            text["state"].as_str(),
            text["processed"].as_u64(),
            text["total"].as_u64(),
            text["phase"].as_str()
        ),
        (Some("scan"), Some("completed"), Some(2), Some(2), Some("processing"))
    );
    // Nothing left to do: the deleted row stays deleted and is not swept twice.
    let again = scan_once(&ctx);
    assert_eq!((again.seen, again.changed, again.deleted), (3, 0, 0));
}

#[test]
fn a_scan_counts_errors_and_keeps_a_failed_operation() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("a.pdf", b"hello");
    let result = scan_once(&ctx);
    // An extraction error still counts as a (re)indexed file, and as a failed one.
    assert_eq!((result.changed, result.errors), (1, 1));
    assert_eq!(env.status(&ctx, "a.pdf"), "error");
    let text = Env::snapshot(&ctx, "textSearch");
    assert_eq!(
        (text["state"].as_str(), text["errors"].as_u64()),
        (Some("failed"), Some(1))
    );
}

#[test]
fn a_scan_with_many_files_uses_every_worker() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    for i in 0..20 {
        env.write(&format!("f{i:02}.txt"), b"hello");
    }
    let result = scan_once(&ctx);
    assert_eq!((result.seen, result.changed), (20, 20));
}

#[test]
fn a_slow_file_does_not_hold_up_the_rest_of_the_tree() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    // Sorted first, so a worker takes it before the text files.
    env.write("a.docx", b"slow document");
    for i in 0..20 {
        env.write(&format!("f{i:02}.txt"), b"hello");
    }
    env.ml.hold(TIKA);
    let scan = {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || scan_once(&ctx))
    };
    let held = env.ml.wait_for(TIKA, 1, SECOND);
    let mut c = env.client();
    let others_done = wait_until(SECOND, || {
        c.query_one("SELECT count(*) FROM idx.files WHERE text_status = 'partial'", &[])
            .unwrap()
            .get::<_, i64>(0)
            == 20
    });
    env.ml.release(TIKA);
    let result = scan.join().unwrap();
    assert!(held && others_done);
    assert_eq!(result.changed, 21);
    assert_eq!(env.status(&ctx, "a.docx"), "partial");
}

#[test]
fn a_scan_reports_its_total_while_every_worker_is_busy() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    for i in 0..40 {
        env.write(&format!("f{i:02}.txt"), b"hello");
    }
    env.ml.hold(TEXT_EMBED);
    let scan = {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || scan_once(&ctx))
    };
    assert!(env.ml.wait_for(TEXT_EMBED, 2, SECOND));
    let total = |ctx: &indexer::RootContext| {
        ctx.activity
            .snapshot()
            .into_iter()
            .find(|op| op["features"][0] == "textSearch")
            .and_then(|op| op["total"].as_u64())
    };
    let reported = wait_until(SECOND, || total(&ctx) == Some(40));
    env.ml.release(TEXT_EMBED);
    assert!(reported);
    assert_eq!(scan.join().unwrap().changed, 40);
}

#[test]
fn a_cancelled_scan_never_sweeps_unseen_rows() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("slow.docx", b"document");
    db::upsert_file(
        &mut env.client(),
        &db::NewFile {
            root_id: ctx.root_id,
            path: "gone.txt",
            name: "gone.txt",
            ext: ".txt",
            size: 1,
            mtime_ns: 1,
            sha256: "sha",
            mime: None,
        },
    )
    .unwrap();
    env.ml.hold(TIKA);
    let scan = {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || scan_once(&ctx))
    };
    assert!(env.ml.wait_for(TIKA, 1, SECOND));
    ctx.set_features(configuration(4, OFF));
    env.ml.release(TIKA);
    let result = scan.join().unwrap();
    assert_eq!(result.deleted, 0);
    assert!(!env.row(&ctx, "gone.txt").deleted);
    assert_eq!(Env::snapshot(&ctx, "textSearch")["state"], "stopped");
}

#[test]
fn a_scan_skips_already_indexed_files() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, true, false));
    env.write("a.txt", b"hello");
    env.seed(&ctx, "a.txt", "sha1", "indexed");
    let result = scan_once(&ctx);
    assert_eq!((result.seen, result.changed, result.errors), (1, 0, 0));
    assert!(env.ml.seen().is_empty());
}

#[test]
fn a_scan_of_a_root_that_vanished_fails() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    std::fs::remove_dir_all(&env.root).unwrap();
    assert_eq!(scan_once(&ctx).errors, 1);
    assert_eq!(Env::snapshot(&ctx, "textSearch")["state"], "failed");
    assert_eq!(env.count("idx.scans"), 0);
}

#[test]
fn feature_refresh_reads_the_persisted_selection() {
    let env = Env::new();
    let ctx = env.ctx_with(OFF, |c| c.refresh_features = Some(Duration::ZERO));
    common::save_features(&env.url, fv(false, true, false, false, false));
    env.write("a.txt", b"hello");
    assert_eq!(scan_once(&ctx).changed, 1);
    assert!(ctx.values().text_search);
    // A long interval keeps the cached selection.
    let cached = env.ctx_with(OFF, |c| c.refresh_features = Some(Duration::from_secs(3600)));
    cached.maybe_refresh_features();
    common::save_features(&env.url, OFF);
    cached.maybe_refresh_features();
    assert!(cached.values().text_search);
}

#[test]
fn unchanged_media_is_classified_from_the_manifest() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    for (name, sha) in [("embedded.jpg", "aa"), ("pending.jpg", "bb")] {
        env.write(name, name.as_bytes());
        env.seed(&ctx, name, &fake_sha(sha.chars().next().unwrap()), "indexed");
        env.fake_thumbnail(&fake_sha(sha.chars().next().unwrap()));
    }
    db::upsert_image_embedding(&mut env.client(), &fake_sha('a'), "model-a", &[0.1; 1024]).unwrap();
    let result = scan_once(&ctx);
    assert_eq!(result.errors, 0);
    // Only the file without an embedding was sent.
    assert_eq!(env.ml.count(IMAGE_EMBED), 1);
    assert_eq!(
        db::image_embedding_model(&mut env.client(), &fake_sha('b'))
            .unwrap()
            .as_deref(),
        Some("model-a")
    );
}

#[test]
fn scan_thumbnails_do_not_wait_for_image_embeddings() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    for (i, name) in ["a.jpg", "b.jpg", "c.jpg"].iter().enumerate() {
        env.write(name, &jpeg(16, 16, i as u8));
    }
    env.ml.hold(IMAGE_EMBED);
    let thumbs = env.thumbs.clone();
    let count_files = move || {
        fn walk(dir: &std::path::Path) -> usize {
            std::fs::read_dir(dir).map_or(0, |e| {
                e.filter_map(Result::ok)
                    .map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 })
                    .sum()
            })
        }
        walk(&thumbs)
    };
    let scan = {
        let ctx = Arc::clone(&ctx);
        std::thread::spawn(move || scan_once(&ctx))
    };
    // A slow model: every file is still thumbnailed while the first embedding waits.
    let all_thumbnailed = wait_until(SECOND, || count_files() == 6);
    let embedding_waiting = env.ml.wait_for(IMAGE_EMBED, 1, SECOND);
    env.ml.release(IMAGE_EMBED);
    let result = scan.join().unwrap();
    assert!(all_thumbnailed && embedding_waiting);
    assert_eq!(result.errors, 0);
    assert_eq!(env.count("app.image_embeddings"), 3);
    let image = Env::snapshot(&ctx, "imageSearch");
    assert_eq!(
        (
            image["state"].as_str(),
            image["processed"].as_u64(),
            image["total"].as_u64()
        ),
        (Some("completed"), Some(3), Some(3))
    );
}

#[test]
fn deferred_image_embedding_failures_count_once_per_file() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.write("broken.jpg", b"cannot decode");
    env.write("rejected.jpg", &jpeg(16, 16, 2));
    env.ml.fail(IMAGE_EMBED, 500);
    let result = scan_once(&ctx);
    // broken.jpg fails both stages but is one failed file; rejected.jpg fails only embedding.
    assert_eq!(result.errors, 2);
    assert_eq!(
        env.unresolved(),
        [
            ("broken.jpg", "imageSearch"),
            ("broken.jpg", "thumbnails"),
            ("rejected.jpg", "imageSearch")
        ]
        .map(|(p, f)| (p.to_owned(), f.to_owned()))
        .into()
    );
    assert_eq!(Env::snapshot(&ctx, "thumbnails")["errors"], 1);
    assert_eq!(Env::snapshot(&ctx, "imageSearch")["errors"], 2);
}

#[test]
fn a_failed_deferred_embedding_keeps_the_media_backfill_pending() {
    let env = Env::new();
    let ctx = env.ctx(OFF);
    env.write("a.jpg", &jpeg(16, 16, 3));
    env.seed(&ctx, "a.jpg", &fake_sha('a'), "indexed");
    ctx.set_features(configuration(3, fv(true, false, false, false, true)));
    env.ml.fail(IMAGE_EMBED, 500);
    scan_once(&ctx);
    assert!(ctx.needs_media_backfill());
    env.ml.reset(IMAGE_EMBED);
    scan_once(&ctx);
    assert!(!ctx.needs_media_backfill());
    assert_eq!(env.count("app.image_embeddings"), 1);
}

#[test]
fn a_failed_thumbnail_is_not_retried_until_the_file_changes() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, false));
    env.write("photo.jpg", b"ciphertext");
    assert_eq!(scan_once(&ctx).errors, 1);
    assert_eq!(scan_once(&ctx).errors, 0);
    assert_eq!(env.attempts("photo.jpg", "thumbnails"), Some(1));
    assert_eq!(
        env.unresolved(),
        [("photo.jpg".to_owned(), "thumbnails".to_owned())].into()
    );
    env.write("photo.jpg", b"a different photo");
    scan_once(&ctx);
    assert_eq!(env.attempts("photo.jpg", "thumbnails"), Some(2));
}

#[test]
fn a_pending_row_is_reprocessed_even_while_its_thumbnail_fails() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, false, false));
    env.write("photo.jpg", b"ciphertext");
    // A worker stopped between writing the row and its status.
    env.seed(&ctx, "photo.jpg", "sha", "pending");
    scan_once(&ctx);
    scan_once(&ctx);
    assert_eq!(env.status(&ctx, "photo.jpg"), "disabled:search_ocr");
    assert_eq!(env.attempts("photo.jpg", "thumbnails"), Some(1));
}

#[test]
fn the_image_stage_drops_queued_work_when_abandoned() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.fake_thumbnail(&fake_sha('a'));
    env.fake_thumbnail(&fake_sha('b'));
    env.ml.hold(IMAGE_EMBED);
    let stage = ImageStage::start(Arc::clone(&ctx), "image-embed-test");
    let first = stage.submit("slow.jpg", &fake_sha('a'), "operation");
    assert!(env.ml.wait_for(IMAGE_EMBED, 1, SECOND));
    let queued = stage.submit("queued.jpg", &fake_sha('b'), "operation");
    let closing = {
        let stage = Arc::clone(&stage);
        std::thread::spawn(move || stage.close(true))
    };
    std::thread::sleep(Duration::from_millis(50));
    env.ml.release(IMAGE_EMBED);
    closing.join().unwrap();
    assert_eq!(first.wait(), (true, false));
    assert_eq!(queued.wait(), (true, true));
    assert_eq!(env.ml.count(IMAGE_EMBED), 1);
    // A closed stage resolves new work as skipped at once.
    assert_eq!(stage.submit("late.jpg", "x", "op").get(), Some((true, true)));
}

#[test]
fn the_image_stage_skips_work_once_image_search_is_off() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.fake_thumbnail(&fake_sha('a'));
    ctx.set_features(configuration(2, fv(true, false, false, false, false)));
    let stage = ImageStage::start(Arc::clone(&ctx), "image-embed-off");
    let promise = stage.submit("a.jpg", &fake_sha('a'), "operation");
    stage.close(false);
    assert_eq!(promise.wait(), (true, true));
    assert!(env.ml.seen().is_empty());
    assert!(Arc::ptr_eq(&ctx.watch_image_stage(), &ctx.watch_image_stage()));
}

// -- events and watcher callbacks ------------------------------------------------------------

#[test]
fn only_a_new_or_changed_version_emits_an_event() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let (path, stat) = env.write("a.txt", b"first");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.events(), ["created"]);
    // A reindex request re-extracts the same version.
    db::mark_pending(&mut env.client(), ctx.root_id, None).unwrap();
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    // So does enabling a feature for a row that was skipped while it was off.
    env.client()
        .execute("UPDATE idx.files SET text_status = 'disabled:text'", &[])
        .unwrap();
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.events(), ["created"]);

    let (path, stat) = env.write("a.txt", b"second version");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    db::mark_deleted(&mut env.client(), ctx.root_id, "a.txt", false).unwrap();
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.events(), ["created", "changed", "changed"]);
}

#[test]
fn a_failing_event_write_is_swallowed() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.client()
        .batch_execute("ALTER TABLE idx.events RENAME TO events_gone")
        .unwrap();
    emit_event(&ctx, EventKind::Created, "a.txt", None);
    let (path, stat) = env.write("a.txt", b"hello");
    assert!(process_file(&ctx, &path, "a.txt", stat).unwrap());
    assert_eq!(env.status(&ctx, "a.txt"), "partial");
}

#[test]
fn watcher_deletes_count_rows_and_emit_once() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    assert_eq!(watch_mark_deleted(&ctx, "missing.txt", false), 0);
    assert!(env.events().is_empty());
    for rel in ["a.txt", "dir/b.txt", "dir/c.txt"] {
        env.write(rel, b"x");
        env.seed(&ctx, rel, "sha", "indexed");
    }
    assert_eq!(watch_mark_deleted(&ctx, "a.txt", false), 1);
    assert_eq!(watch_mark_deleted(&ctx, "dir", true), 2);
    assert_eq!(env.events(), ["deleted", "deleted"]);
    // The database is gone: logged, nothing affected.
    env.client()
        .batch_execute("ALTER TABLE idx.files RENAME TO files_gone")
        .unwrap();
    assert_eq!(watch_mark_deleted(&ctx, "x.txt", false), 0);
    assert_eq!(watch_rename(&ctx, "x.txt", "y.txt", false), 0);
}

#[test]
fn watcher_renames_move_rows_or_delete_on_an_extension_change() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    for rel in ["a.txt", "b.txt", "docs/c.txt"] {
        env.write(rel, b"x");
        env.seed(&ctx, rel, "sha", "indexed");
    }
    assert_eq!(watch_rename(&ctx, "missing.txt", "new.txt", false), 0);
    // A new extension is a different kind of file: delete it and index the new path later.
    assert_eq!(watch_rename(&ctx, "a.txt", "a.pdf", false), 0);
    assert!(env.row(&ctx, "a.txt").deleted);
    assert_eq!(watch_rename(&ctx, "b.txt", "renamed.txt", false), 1);
    assert_eq!(watch_rename(&ctx, "docs", "moved", true), 1);
    assert!(!env.row(&ctx, "renamed.txt").deleted);
    assert!(!env.row(&ctx, "moved/c.txt").deleted);
    let moves: Vec<(String, String, String)> = env
        .client()
        .query("SELECT src, dst, actor FROM idx.moves ORDER BY id", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        moves,
        vec![
            ("b.txt".into(), "renamed.txt".into(), "watcher".into()),
            ("docs".into(), "moved".into(), "watcher".into())
        ]
    );
    let events: Vec<(String, String, Option<String>)> = env
        .client()
        .query("SELECT kind, path, target_path FROM idx.events ORDER BY id", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        events,
        vec![
            ("deleted".into(), "a.txt".into(), None),
            ("moved".into(), "b.txt".into(), Some("renamed.txt".into())),
            ("moved".into(), "docs".into(), Some("moved".into()))
        ]
    );
}

#[test]
fn watcher_parent_mutations_wait_for_an_in_flight_child() {
    for rename in [false, true] {
        let env = Env::new();
        let ctx = env.ctx(fv(false, true, false, false, false));
        env.write("docs/a.txt", b"x");
        env.seed(&ctx, "docs/a.txt", "sha", "indexed");
        let child = ctx.path_locks.get("docs/a.txt");
        let operation = {
            let ctx = Arc::clone(&ctx);
            std::thread::spawn(move || {
                if rename {
                    watch_rename(&ctx, "docs", "moved", true)
                } else {
                    watch_mark_deleted(&ctx, "docs", true)
                }
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!operation.is_finished());
        assert_eq!(
            env.count("idx.events"),
            0,
            "nothing changed while the child is in flight"
        );
        drop(child);
        assert_eq!(operation.join().unwrap(), 1);
        assert!(ctx.path_locks.is_empty());
    }
}

#[test]
fn watch_index_reports_outcomes_and_failures() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let (path, stat) = env.write("a.txt", b"hello");
    let result = watch_index(&ctx, &path, "a.txt", stat);
    assert_eq!(result.status, "indexed");
    assert_eq!(result.outcomes.unwrap()["textSearch"], (true, false));
    // The file vanished after it was queued: an error on the row and for each feature.
    std::fs::remove_file(&path).unwrap();
    let stat = FileStat { size: 99, mtime_ns: 1 };
    assert_eq!(safe_process(&ctx, &path, "a.txt", stat), "error");
    let row = env.row(&ctx, "a.txt");
    assert_eq!(row.status, "error");
    assert!(row.error.unwrap().starts_with("Error: "));
    assert_eq!(env.unresolved(), [("a.txt".to_owned(), "textSearch".to_owned())].into());
}

#[test]
fn watcher_image_changes_are_embedded_off_the_worker() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    env.ml.hold(IMAGE_EMBED);
    let bytes = jpeg(16, 16, 1);
    let (path, stat) = env.write("a.jpg", &bytes);
    let result = watch_index(&ctx, &path, "a.jpg", stat);
    assert_eq!(result.status, "indexed");
    assert_eq!(result.outcomes.as_ref().unwrap()["thumbnails"], (true, false));
    let promise = result.deferred["imageSearch"].clone();
    assert_eq!(promise.get(), None);
    env.ml.release(IMAGE_EMBED);
    assert_eq!(promise.wait(), (true, false));
    assert_eq!(
        db::image_embedding_model(&mut env.client(), &hex_sha(&bytes))
            .unwrap()
            .as_deref(),
        Some("model-a")
    );
}

#[test]
fn paths_with_spaces_and_unicode_are_row_keys_as_they_are() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("dir with space/ü.txt", b"unicode");
    assert_eq!(scan_once(&ctx).changed, 1);
    assert_eq!(env.status(&ctx, "dir with space/ü.txt"), "partial");
}

#[test]
fn an_unreadable_directory_stops_the_sweep_but_is_not_a_file_failure() {
    use std::os::unix::fs::PermissionsExt;
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    env.write("locked/inside.txt", b"x");
    env.seed(&ctx, "locked/inside.txt", "sha", "indexed");
    env.write("a.txt", b"hello");
    std::fs::set_permissions(env.path("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let result = scan_once(&ctx);
    std::fs::set_permissions(env.path("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
    if result.seen == 2 {
        return; // Running as root: permissions do not apply.
    }
    assert_eq!(
        (result.seen, result.changed, result.deleted, result.errors),
        (1, 1, 0, 0)
    );
    assert!(!env.row(&ctx, "locked/inside.txt").deleted);
    // The scan never finished discovery, so it reports no total.
    assert!(Env::snapshot(&ctx, "textSearch")["total"].is_null());
}
