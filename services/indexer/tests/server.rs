//! The internal HTTP API end to end: each route driven through the axum router against a
//! migrated database, a temporary root and the fake `ml` server.

mod common;

use std::collections::BTreeSet;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request};
use common::fake_ml::{self, FakeMl};
use fdrive_indexer::config::Config;
use fdrive_indexer::db::{self, Db, NewFile};
use fdrive_indexer::extract::{ContentExtractor, MAX_CONTENT_BYTES};
use fdrive_indexer::failures;
use fdrive_indexer::features::FeatureValues;
use fdrive_indexer::indexer::RootContext;
use fdrive_indexer::jobs::Job;
use fdrive_indexer::paths::{basename, ext_of};
use fdrive_indexer::server::{AppState, Jobs, Wake, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    })
}

fn send(state: &Arc<AppState>, method: Method, uri: &str, body: impl Into<Body>) -> (u16, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(body.into())
        .unwrap();
    runtime().block_on(async {
        let response = router(Arc::clone(state)).oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    })
}

fn get(state: &Arc<AppState>, uri: &str) -> (u16, Value) {
    send(state, Method::GET, uri, Body::empty())
}

fn post(state: &Arc<AppState>, uri: &str, body: &str) -> (u16, Value) {
    send(state, Method::POST, uri, body.to_owned())
}

fn post_json(state: &Arc<AppState>, uri: &str, body: &Value) -> (u16, Value) {
    post(state, uri, &body.to_string())
}

/// Percent-encode everything but unreserved characters.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

fn app_state(contexts: Vec<Arc<RootContext>>, db_url: &str, content: Option<Arc<ContentExtractor>>) -> Arc<AppState> {
    let wakes = contexts
        .iter()
        .map(|c| (c.name.clone(), Arc::new(Wake::default())))
        .collect();
    Arc::new(AppState {
        contexts,
        watchers: Arc::default(),
        wakes,
        db: Db {
            url: db_url.to_owned(),
            retries: 1,
        },
        content,
        jobs: Jobs::default(),
        failure_retry_feature: Mutex::new("thumbnails".to_owned()),
        instance_id: uuid::Uuid::new_v4().to_string(),
    })
}

/// A Postgres address nothing listens on.
fn closed_database() -> String {
    format!(
        "postgres://fdrive:fdrive@{}/fdrive",
        fake_ml::closed_url().trim_start_matches("http://")
    )
}

fn values(thumbnails: bool, text: bool, semantic: bool, image: bool) -> FeatureValues {
    FeatureValues {
        thumbnails,
        text_search: text,
        search_ocr: false,
        semantic_search: semantic,
        image_search: image,
        pdf_ocr: false,
    }
}

struct Env {
    url: String,
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    ml: FakeMl,
    cfg: Arc<Config>,
    ctx: Arc<RootContext>,
    state: Arc<AppState>,
}

fn setup(features: FeatureValues) -> Env {
    let url = common::database();
    let dir = tempfile::tempdir().unwrap();
    // macOS keeps temporary directories behind the /var symlink.
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("root");
    std::fs::create_dir(&root).unwrap();
    let ml = FakeMl::start();
    let cfg = common::config(&url, &root, &base.join("thumbs"), &ml.url);
    let ctx = common::context(&cfg, features);
    let state = app_state(vec![Arc::clone(&ctx)], &url, None);
    Env {
        url,
        _dir: dir,
        base,
        root,
        ml,
        cfg,
        ctx,
        state,
    }
}

impl Env {
    fn count(&self, sql: &str) -> i64 {
        common::connect(&self.url).query_one(sql, &[]).unwrap().get(0)
    }

    fn thumbnails(&self) -> i64 {
        self.count("SELECT count(*) FROM app.thumbnails")
    }

    /// A context on the same root with a changed config and its own database settings.
    fn context_with(&self, change: impl FnOnce(&mut Config), features: FeatureValues) -> Arc<RootContext> {
        let mut cfg = (*self.cfg).clone();
        change(&mut cfg);
        let mut ctx = RootContext::new(
            "r",
            self.ctx.root_id,
            cfg.roots[0].1.clone(),
            Arc::new(cfg),
            common::features(features),
        );
        ctx.db.retries = 1;
        Arc::new(ctx)
    }
}

fn upsert(ctx: &RootContext, path: &str, sha: &str, size: i64) -> i64 {
    let name = basename(path);
    let ext = ext_of(name);
    ctx.db
        .with(|c| {
            db::upsert_file(
                c,
                &NewFile {
                    root_id: ctx.root_id,
                    path,
                    name,
                    ext: &ext,
                    size,
                    mtime_ns: 1,
                    sha256: sha,
                    mime: None,
                },
            )
        })
        .unwrap()
}

fn indexed(ctx: &RootContext, path: &str, sha: &str) -> i64 {
    let id = upsert(ctx, path, sha, 1);
    ctx.db
        .with(|c| db::update_file_status(c, id, "indexed", 5, None))
        .unwrap();
    id
}

fn write_png(path: &Path) {
    image::RgbImage::from_pixel(200, 100, image::Rgb([255, 0, 0]))
        .save(path)
        .unwrap();
}

/// A media row for a real PNG at `rel` below the root.
fn png_file(env: &Env, rel: &str, sha: &str) {
    let path = env.root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    write_png(&path);
    let size = std::fs::metadata(&path).unwrap().len() as i64;
    upsert(&env.ctx, rel, sha, size);
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn wait(job: &Job) -> Value {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let snapshot = job.snapshot();
        if snapshot["running"] == false {
            return snapshot;
        }
        assert!(Instant::now() < deadline, "job still running: {snapshot}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// A minimal PDF whose pages show the given text in Helvetica.
fn pdf_bytes(pages: &[&str]) -> Vec<u8> {
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        String::new(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut kids = Vec::new();
    for text in pages {
        let content = format!("BT /F1 12 Tf 50 700 Td ({text}) Tj ET");
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
        let content_id = objects.len();
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
        ));
        kids.push(format!("{} 0 R", objects.len()));
    }
    objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len());
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

const LONG_TEXT: &str = "Provider-only document with enough text to extract for this test.";

// ---------------------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------------------

#[test]
fn health_reports_schema_roots_watchers_embeddings_and_storage() {
    let env = setup(common::all_features());
    env.state.watchers.lock().unwrap().insert("r".to_owned(), true);
    let (status, body) = get(&env.state, "/health");
    assert_eq!(status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(body["roots"], json!(["r"]));
    assert_eq!(body["watcher"], json!({"r": true}));
    assert_eq!(body["embed_ok"], true);
    assert_eq!(body["schema_version"], 1);
    assert_eq!(body["features"], env.ctx.features().as_json());
    assert_eq!(body["storage"], json!({"r": {"readable": true, "writable": true}}));
    assert_eq!(env.ml.count(fake_ml::TEXT_HEALTH), 1);

    // No watcher registered reads as false; an unreachable embedding backend is not ok.
    let unreachable = env.context_with(
        |c| c.embed_url = format!("{}/text", fake_ml::closed_url()),
        common::all_features(),
    );
    let state = app_state(vec![unreachable], &env.url, None);
    let (status, body) = get(&state, "/health");
    assert_eq!(status, 200);
    assert_eq!(body["watcher"], json!({"r": false}));
    assert_eq!(body["embed_ok"], false);

    // Semantic search off never probes the backend.
    let before = env.ml.count(fake_ml::TEXT_HEALTH);
    let off = env.context_with(|_| {}, values(true, true, false, true));
    let (_, body) = get(&app_state(vec![off], &env.url, None), "/health");
    assert_eq!(body["embed_ok"], false);
    assert_eq!(env.ml.count(fake_ml::TEXT_HEALTH), before);
}

#[test]
fn health_is_not_ok_without_the_schema() {
    let url = common::database();
    let admin = format!("{}/postgres", url.rsplit_once('/').unwrap().0);
    let state = app_state(Vec::new(), &admin, None);
    let (status, body) = get(&state, "/health");
    assert_eq!(status, 200);
    assert_eq!(body["ok"], false);
    assert_eq!(body["embed_ok"], false);
    assert_eq!(body["schema_version"], Value::Null);
    assert_eq!(body["roots"], json!([]));
    assert_eq!(body["watcher"], json!({}));
    assert_eq!(body["storage"], json!({}));
    assert_eq!(body["features"]["values"]["thumbnails"], false);
}

#[test]
fn health_reports_a_missing_root_and_fails_without_a_database() {
    let env = setup(common::all_features());
    let missing = env.context_with(|c| c.roots[0].1 = env.base.join("missing"), common::all_features());
    let (status, body) = get(&app_state(vec![missing], &env.url, None), "/health");
    assert_eq!(status, 200);
    assert_eq!(body["storage"], json!({"r": {"readable": false, "writable": false}}));

    let (status, body) = get(&app_state(Vec::new(), &closed_database(), None), "/health");
    assert_eq!(status, 500);
    assert_eq!(body, json!({"error": "database unavailable"}));
}

// ---------------------------------------------------------------------------------------
// /stats
// ---------------------------------------------------------------------------------------

#[test]
fn stats_report_counts_and_idle_job_snapshots() {
    let env = setup(common::all_features());
    let id = indexed(&env.ctx, "a.txt", "sha1");
    env.ctx
        .db
        .with(|c| {
            db::insert_chunks(c, id, &["hello".to_owned()], &[Some(vec![0.1; 384])])?;
            db::upsert_thumbnail(c, "sha1", 256, "sh/sha1.256.webp", 100, 50)?;
            db::upsert_image_embedding(c, "sha1", "model-a", &[0.1; 1024])
        })
        .unwrap();
    let (status, body) = get(&env.state, "/stats");
    assert_eq!(status, 200);
    let keys: BTreeSet<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "errors_sample",
            "features",
            "image_embedding_clear",
            "image_embedding_rebuild",
            "image_embeddings",
            "index_clear",
            "queue_depth",
            "roots",
            "thumbnail_clear",
            "thumbnail_rebuild",
            "thumbnails",
        ])
    );
    assert_eq!(
        body["roots"],
        json!([{"root": "r", "counts_by_status": {"indexed": 1}, "chunks": 1, "chunks_embedded": 1, "last_scan": null}])
    );
    assert_eq!(
        (body["thumbnails"].as_i64(), body["image_embeddings"].as_i64()),
        (Some(1), Some(1))
    );
    assert_eq!(body["queue_depth"], 0);
    assert_eq!(body["errors_sample"], json!([]));
    assert_eq!(body["features"], env.ctx.features().as_json());
    let idle = json!({
        "running": false, "processed": 0, "total": 0, "total_known": false,
        "started_at": null, "finished_at": null, "errors": 0, "outcome": null,
    });
    for key in [
        "thumbnail_rebuild",
        "image_embedding_rebuild",
        "index_clear",
        "thumbnail_clear",
        "image_embedding_clear",
    ] {
        assert_eq!(body[key], idle, "{key}");
    }

    // A scan, an error, a pending row and running jobs all show up.
    upsert(&env.ctx, "b.txt", "sha2", 1);
    env.ctx
        .db
        .with(|c| {
            let (scan, _) = db::start_scan(c, env.ctx.root_id)?;
            db::finish_scan(c, scan, 3, 2, 1, 0)?;
            db::mark_file_error(c, env.ctx.root_id, "a.txt", "DecodeError: boom")
        })
        .unwrap();
    assert!(env.state.jobs.image_rebuild.try_start(1));
    let (_, body) = get(&env.state, "/stats");
    assert_eq!(body["queue_depth"], 1);
    assert_eq!(
        body["errors_sample"],
        json!([{"path": "a.txt", "error": "DecodeError: boom"}])
    );
    let scan = &body["roots"][0]["last_scan"];
    assert_eq!(
        (scan["files_seen"].as_i64(), scan["errors"].as_i64()),
        (Some(3), Some(0))
    );
    assert!(scan["finished_at"].is_string());
    assert_eq!(body["image_embedding_rebuild"]["running"], true);
    assert_eq!(body["thumbnail_rebuild"]["running"], false);
    env.state.jobs.image_rebuild.finish();

    let (status, body) = get(&app_state(Vec::new(), &closed_database(), None), "/stats");
    assert_eq!((status, body), (500, json!({"error": "database unavailable"})));
}

// ---------------------------------------------------------------------------------------
// /extract
// ---------------------------------------------------------------------------------------

fn extract(env: &Env, path: &str) -> (u16, Value) {
    post_json(&env.state, "/extract", &json!({"root": "r", "path": path}))
}

#[test]
fn extract_returns_text_slices() {
    let env = setup(common::all_features());
    std::fs::write(env.root.join("readme.md"), "0123456789abcdefghij").unwrap();
    let (status, body) = extract(&env, "readme.md");
    assert_eq!(status, 200);
    assert_eq!(
        body,
        json!({"text": "0123456789abcdefghij", "status": "indexed", "total_chars": 20})
    );
    let (_, body) = post_json(
        &env.state,
        "/extract",
        &json!({"root": "r", "path": "/readme.md", "offset": 2, "max_chars": 5}),
    );
    assert_eq!(body, json!({"text": "23456", "status": "indexed", "total_chars": 20}));
    let (_, body) = post_json(
        &env.state,
        "/extract",
        &json!({"root": "r", "path": "readme.md", "offset": 30}),
    );
    assert_eq!(body["text"], "");
}

#[test]
fn extract_validates_requests() {
    let env = setup(common::all_features());
    for body in [
        r#"{"root":"r"}"#,
        r#"{"path":"a.txt"}"#,
        "{}",
        "",
        r#"{"root":1,"path":"a"}"#,
    ] {
        let (status, response) = post(&env.state, "/extract", body);
        assert_eq!(
            (status, response),
            (400, json!({"error": "root and path are required"})),
            "{body}"
        );
    }
    assert_eq!(
        post(&env.state, "/extract", "[]"),
        (400, json!({"error": "body must be an object"}))
    );
    assert_eq!(
        post(&env.state, "/extract", "{"),
        (400, json!({"error": "invalid JSON"}))
    );
    assert_eq!(
        post_json(&env.state, "/extract", &json!({"root": "unknown", "path": "a.txt"})),
        (404, json!({"error": "unknown root: unknown"}))
    );
    for path in ["../../etc/passwd", "", "/", "a//b", "a\\b", "a/./b"] {
        assert_eq!(extract(&env, path), (400, json!({"error": "invalid path"})), "{path:?}");
    }
    assert_eq!(extract(&env, "missing.txt"), (404, json!({"error": "not found"})));
    std::fs::create_dir(env.root.join("docs")).unwrap();
    assert_eq!(extract(&env, "docs").0, 404, "a directory is not a file");
    assert_eq!(extract(&env, "missing/a.txt").0, 404);
}

#[test]
fn extract_never_follows_symlinks() {
    let env = setup(common::all_features());
    std::fs::write(env.base.join("outside.txt"), "outside secret").unwrap();
    symlink(env.base.join("outside.txt"), env.root.join("leak.txt")).unwrap();
    std::fs::create_dir(env.base.join("outside")).unwrap();
    std::fs::write(env.base.join("outside/secret.txt"), "outside secret").unwrap();
    symlink(env.base.join("outside"), env.root.join("linked")).unwrap();
    for path in ["leak.txt", "linked/secret.txt"] {
        assert_eq!(
            extract(&env, path),
            (400, json!({"error": "path unavailable"})),
            "{path}"
        );
    }
}

#[test]
fn extract_statuses_for_non_text_empty_and_disabled() {
    let env = setup(common::all_features());
    std::fs::write(env.root.join("app.bin"), b"x").unwrap();
    std::fs::write(env.root.join("empty.txt"), b"").unwrap();
    write_png(&env.root.join("a.png"));
    assert_eq!(extract(&env, "app.bin"), (200, json!({"text": null, "status": "none"})));
    assert_eq!(
        extract(&env, "empty.txt"),
        (200, json!({"text": null, "status": "empty"}))
    );
    assert_eq!(
        extract(&env, "a.png"),
        (200, json!({"text": null, "status": "disabled"})),
        "an image without search OCR"
    );
    env.ctx.set_features(common::features(values(true, false, false, true)));
    assert_eq!(
        extract(&env, "missing.txt"),
        (200, json!({"text": null, "status": "disabled"})),
        "text search off answers before touching storage"
    );
}

#[test]
fn extract_reads_pdfs_and_office_documents_through_the_descriptor() {
    let env = setup(common::all_features());
    std::fs::write(env.root.join("document.pdf"), pdf_bytes(&[LONG_TEXT])).unwrap();
    let (status, body) = extract(&env, "document.pdf");
    assert_eq!((status, body["status"].as_str()), (200, Some("indexed")));
    assert!(body["text"].as_str().unwrap().contains("Provider-only document"));

    std::fs::write(env.root.join("document.docx"), b"office descriptor bytes").unwrap();
    env.ml
        .set_tika_text("Office descriptor text long enough for successful extraction");
    let (_, body) = extract(&env, "document.docx");
    assert_eq!(body["status"], "indexed");
    assert!(body["text"].as_str().unwrap().contains("Office descriptor text"));
    let seen = env.ml.requests(fake_ml::TIKA);
    assert_eq!(seen.last().unwrap().body, b"office descriptor bytes");
}

// Only Linux has `/proc/self/fd`, which reopens the opened inode; macOS development builds
// reopen the plain path (see `fsx::OpenedFile::path`).
#[cfg(target_os = "linux")]
#[test]
fn an_open_file_stays_bound_after_its_entry_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    std::fs::create_dir(base.join("root")).unwrap();
    let requested = base.join("root/readme.txt");
    std::fs::write(&requested, "inside data").unwrap();
    std::fs::write(base.join("outside.txt"), "outside secret").unwrap();
    let opened = fdrive_indexer::fsx::open_file(&base.join("root"), &["readme.txt".to_owned()]).unwrap();
    std::fs::remove_file(&requested).unwrap();
    symlink(base.join("outside.txt"), &requested).unwrap();
    assert_eq!(std::fs::read(opened.path()).unwrap(), b"inside data");
    assert_eq!(opened.size, 11);
}

// ---------------------------------------------------------------------------------------
// /extract-content
// ---------------------------------------------------------------------------------------

fn content_state(ml: &FakeMl) -> (Arc<AppState>, Arc<ContentExtractor>) {
    let extractor = Arc::new(ContentExtractor::new(
        600,
        300_000,
        "eng",
        &format!("{}/extract", ml.url),
    ));
    let state = app_state(Vec::new(), &closed_database(), Some(Arc::clone(&extractor)));
    (state, extractor)
}

fn extract_content(state: &Arc<AppState>, name: &str, content: Vec<u8>) -> (u16, Value) {
    send(
        state,
        Method::POST,
        &format!("/extract-content?name={}", encode(name)),
        content,
    )
}

#[test]
fn content_extraction_round_trips_documents() {
    let ml = FakeMl::start();
    let (state, _) = content_state(&ml);
    let (status, body) = extract_content(&state, "report.pdf", pdf_bytes(&[LONG_TEXT]));
    assert_eq!((status, body["status"].as_str()), (200, Some("indexed")));
    assert!(body["text"].as_str().unwrap().contains("Provider-only document"));
    assert_eq!(
        extract_content(&state, "readme.txt", b"plain text".to_vec()),
        (200, json!({"text": "plain text", "status": "indexed"}))
    );
    assert_eq!(
        extract_content(&state, "image.png", b"image".to_vec()).1,
        json!({"text": null, "status": "disabled"})
    );
    assert_eq!(
        extract_content(&state, "unknown.binary", b"x".to_vec()).1,
        json!({"text": null, "status": "none"})
    );
    let (_, body) = extract_content(&state, "a.docx", b"office".to_vec());
    assert_eq!(body["status"], "indexed");
    assert_eq!(ml.requests(fake_ml::TIKA)[0].body, b"office");
}

#[test]
fn content_extraction_bounds_and_admission() {
    let ml = FakeMl::start();
    let (state, extractor) = content_state(&ml);
    let unavailable = app_state(Vec::new(), &closed_database(), None);
    assert_eq!(
        extract_content(&unavailable, "a.txt", b"a".to_vec()),
        (503, json!({"error": "extraction unavailable"}))
    );
    let long = "a".repeat(256);
    for name in ["", "../secret.txt", "a\\b", "a\0", long.as_str()] {
        assert_eq!(
            extract_content(&state, name, b"a".to_vec()),
            (400, json!({"error": "invalid name"})),
            "{name:?}"
        );
    }
    assert_eq!(send(&state, Method::POST, "/extract-content", b"a".to_vec()).0, 400);
    let longest = format!("{}.txt", "a".repeat(251));
    assert_eq!(extract_content(&state, &longest, b"a".to_vec()).0, 200);
    assert_eq!(
        extract_content(&state, "a.txt", vec![b'x'; MAX_CONTENT_BYTES + 1]),
        (413, json!({"error": "content too large"}))
    );
    assert_eq!(extract_content(&state, "a.txt", vec![b'x'; MAX_CONTENT_BYTES]).0, 200);
    let held = Arc::clone(&extractor.admission).try_acquire_many_owned(2).unwrap();
    assert_eq!(
        extract_content(&state, "a.txt", b"a".to_vec()),
        (429, json!({"error": "extraction busy"}))
    );
    drop(held);
    assert_eq!(extract_content(&state, "a.txt", b"a".to_vec()).0, 200);
}

#[test]
fn content_extraction_errors_never_reveal_the_temporary_file() {
    let ml = FakeMl::start();
    let (state, _) = content_state(&ml);
    ml.fail(fake_ml::TIKA, 500);
    let (status, body) = extract_content(&state, "a.docx", b"office".to_vec());
    assert_eq!((status, body), (200, json!({"text": null, "status": "error"})));
    let (_, body) = extract_content(&state, "broken.pdf", b"%PDF-1.4 not really".to_vec());
    assert_eq!(body, json!({"text": null, "status": "error"}));
}

// ---------------------------------------------------------------------------------------
// /reindex
// ---------------------------------------------------------------------------------------

#[test]
fn reindex_marks_rows_pending_and_wakes_the_root() {
    let env = setup(common::all_features());
    indexed(&env.ctx, "a.txt", "sha1");
    let (status, body) = post_json(&env.state, "/reindex", &json!({"root": "r"}));
    assert_eq!((status, body), (200, json!({"count": 1})));
    assert!(env.state.wakes["r"].is_set());
    let queued = env.ctx.activity.snapshot();
    assert_eq!(queued.len(), 1);
    assert_eq!(
        (queued[0]["kind"].as_str(), queued[0]["phase"].as_str()),
        (Some("reindex"), Some("queued"))
    );

    indexed(&env.ctx, "dir/a.txt", "sha2");
    indexed(&env.ctx, "dir2/a.txt", "sha3");
    for path in ["dir", "/dir/"] {
        let (_, body) = post_json(&env.state, "/reindex", &json!({"root": "r", "path": path}));
        assert_eq!(body, json!({"count": 1}), "{path}");
    }
    // Nothing thumbnails-related was asked for.
    assert_eq!(env.state.jobs.thumbnail.snapshot()["started_at"], Value::Null);
}

#[test]
fn reindex_validation_disabled_and_unavailable() {
    let env = setup(common::all_features());
    assert_eq!(
        post(&env.state, "/reindex", "{}"),
        (400, json!({"error": "root is required"}))
    );
    assert_eq!(post(&env.state, "/reindex", "[1]").0, 400);
    assert_eq!(
        post_json(&env.state, "/reindex", &json!({"root": "unknown"})),
        (404, json!({"error": "unknown root: unknown"}))
    );
    // A root without a wake event still reindexes.
    let unwoken = Arc::new(AppState {
        contexts: vec![Arc::clone(&env.ctx)],
        watchers: Arc::default(),
        wakes: std::collections::HashMap::new(),
        db: Db::new(&env.url),
        content: None,
        jobs: Jobs::default(),
        failure_retry_feature: Mutex::new("thumbnails".to_owned()),
        instance_id: "instance".to_owned(),
    });
    assert_eq!(post_json(&unwoken, "/reindex", &json!({"root": "r"})).0, 200);

    let offline = env.context_with(|c| c.database_url = closed_database(), common::all_features());
    let state = app_state(vec![offline], &env.url, None);
    assert_eq!(
        post_json(&state, "/reindex", &json!({"root": "r"})),
        (503, json!({"error": "database unavailable"}))
    );

    env.ctx.set_features(common::features(FeatureValues::default()));
    assert_eq!(
        post_json(&env.state, "/reindex", &json!({"root": "r"})),
        (409, json!({"error": "feature processing disabled"}))
    );
}

#[test]
fn reindex_with_thumbnails_starts_a_rebuild_unless_busy() {
    let env = setup(common::all_features());
    png_file(&env, "a.png", "sha1");
    assert!(env.state.jobs.index_clear.try_start(0));
    let (status, body) = post_json(&env.state, "/reindex", &json!({"root": "r", "thumbnails": true}));
    assert_eq!((status, body), (200, json!({"count": 1})));
    assert_eq!(env.state.jobs.thumbnail.snapshot()["started_at"], Value::Null);
    env.state.jobs.index_clear.finish();

    let (status, _) = post_json(&env.state, "/reindex", &json!({"root": "r", "thumbnails": true}));
    assert_eq!(status, 200);
    let snapshot = wait(&env.state.jobs.thumbnail);
    assert_eq!(snapshot["outcome"], "completed");
    assert_eq!(env.thumbnails(), 2);

    // Without thumbnails or image search there is nothing to rebuild.
    let text_only = env.context_with(|_| {}, values(false, true, false, false));
    let state = app_state(vec![text_only], &env.url, None);
    assert_eq!(
        post_json(&state, "/reindex", &json!({"root": "r", "thumbnails": true})).0,
        200
    );
    assert_eq!(state.jobs.thumbnail.snapshot()["started_at"], Value::Null);
}

// ---------------------------------------------------------------------------------------
// /thumbnails/rebuild and /image-embeddings/rebuild
// ---------------------------------------------------------------------------------------

const STARTED: (u16, &str) = (202, r#"{"started":true,"total":null}"#);

fn started(response: (u16, Value)) -> bool {
    response == (STARTED.0, serde_json::from_str(STARTED.1).unwrap())
}

#[test]
fn thumbnail_rebuild_runs_for_a_root_all_roots_or_a_scope() {
    let env = setup(common::all_features());
    png_file(&env, "keep/a.png", "keep-sha");
    png_file(&env, "skip/b.png", "skip-sha");
    assert!(started(post_json(
        &env.state,
        "/thumbnails/rebuild",
        &json!({"root": "r", "path": "keep", "force": true})
    )));
    let snapshot = wait(&env.state.jobs.thumbnail);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["total"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(env.thumbnails(), 2);

    assert!(started(post(&env.state, "/thumbnails/rebuild", "")));
    assert_eq!(wait(&env.state.jobs.thumbnail)["processed"], 2);
    assert_eq!(env.thumbnails(), 4);

    assert!(started(post_json(
        &env.state,
        "/thumbnails/rebuild",
        &json!({"root": null, "path": null})
    )));
    wait(&env.state.jobs.thumbnail);

    // An unknown root is ignored: the run has nothing to do.
    assert!(started(post_json(
        &env.state,
        "/thumbnails/rebuild",
        &json!({"root": "unknown"})
    )));
    let snapshot = wait(&env.state.jobs.thumbnail);
    assert_eq!(
        (snapshot["total"].as_u64(), snapshot["outcome"].as_str()),
        (Some(0), Some("completed"))
    );
}

#[test]
fn rebuild_requests_are_validated() {
    let env = setup(common::all_features());
    for endpoint in ["/thumbnails/rebuild", "/image-embeddings/rebuild"] {
        assert_eq!(
            post_json(&env.state, endpoint, &json!({"root": 123})),
            (400, json!({"error": "root must be a string"}))
        );
        assert_eq!(
            post_json(&env.state, endpoint, &json!({"root": "r", "path": 123})),
            (400, json!({"error": "path must be a string"}))
        );
        assert_eq!(post(&env.state, endpoint, "[]").0, 400);
        assert_eq!(post(&env.state, endpoint, "{").0, 400);
    }
    assert!(env.state.jobs.thumbnail.try_start(0));
    assert_eq!(
        post_json(&env.state, "/thumbnails/rebuild", &json!({"root": "r"})),
        (409, json!({"error": "a thumbnail rebuild is already running"}))
    );
    assert_eq!(
        post_json(&env.state, "/image-embeddings/rebuild", &json!({"root": "r"})),
        (409, json!({"error": "an image-embedding rebuild is already running"}))
    );
    env.state.jobs.thumbnail.finish();

    env.ctx.set_features(common::features(values(false, true, true, false)));
    assert_eq!(
        post_json(&env.state, "/thumbnails/rebuild", &json!({"root": "r"})),
        (409, json!({"error": "thumbnail processing disabled"}))
    );
    assert_eq!(
        post_json(&env.state, "/image-embeddings/rebuild", &json!({"root": "r"})),
        (409, json!({"error": "image search disabled"}))
    );
}

#[test]
fn image_embedding_rebuild_runs_end_to_end() {
    let env = setup(common::all_features());
    png_file(&env, "a.png", "sha1");
    let thumb = env.cfg.thumbs_dir.join("sh/sha1.256.webp");
    std::fs::create_dir_all(thumb.parent().unwrap()).unwrap();
    std::fs::write(&thumb, b"fake webp").unwrap();
    assert!(started(post_json(
        &env.state,
        "/image-embeddings/rebuild",
        &json!({"root": "r"})
    )));
    let snapshot = wait(&env.state.jobs.image_rebuild);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(1), Some(0))
    );
    let model: String = common::connect(&env.url)
        .query_one("SELECT model FROM app.image_embeddings WHERE content_key = 'sha1'", &[])
        .unwrap()
        .get(0);
    assert_eq!(model, "model-a");

    // Without a configured image unit nothing is attempted.
    let unconfigured = env.context_with(|c| c.image_embed_url.clear(), common::all_features());
    let state = app_state(vec![unconfigured], &env.url, None);
    assert!(started(post_json(
        &state,
        "/image-embeddings/rebuild",
        &json!({"root": "r"})
    )));
    let snapshot = wait(&state.jobs.image_rebuild);
    assert_eq!(
        (snapshot["total"].as_u64(), snapshot["outcome"].as_str()),
        (Some(0), Some("completed"))
    );
    assert!(started(post_json(
        &state,
        "/image-embeddings/rebuild",
        &json!({"root": "unknown"})
    )));
    wait(&state.jobs.image_rebuild);
}

#[test]
fn rebuilds_acknowledge_before_discovery() {
    for (endpoint, kind) in [
        ("/thumbnails/rebuild", "thumbnail"),
        ("/image-embeddings/rebuild", "image"),
    ] {
        let env = setup(common::all_features());
        let job = if kind == "thumbnail" {
            &env.state.jobs.thumbnail
        } else {
            &env.state.jobs.image_rebuild
        };
        // Discovery reads idx.files; hold it so the run cannot get past discovery.
        let mut locker = common::connect(&env.url);
        let mut tx = locker.transaction().unwrap();
        tx.batch_execute("LOCK TABLE idx.files IN ACCESS EXCLUSIVE MODE")
            .unwrap();
        assert!(started(post_json(&env.state, endpoint, &json!({"root": "r"}))));
        let activity = job.activity_snapshot("thumbnailRebuild", &["thumbnails"]).unwrap();
        assert_eq!(activity["total"], Value::Null);
        assert_eq!(activity["phase"], "discovering");
        assert_eq!(post_json(&env.state, endpoint, &json!({"root": "r"})).0, 409);
        tx.commit().unwrap();
        assert_eq!(wait(job)["outcome"], "completed");
    }
}

// ---------------------------------------------------------------------------------------
// /directory
// ---------------------------------------------------------------------------------------

fn directory(env: &Env, path: &str) -> (u16, Value) {
    get(&env.state, &format!("/directory?root=r&path={}", encode(path)))
}

#[test]
fn directory_lists_and_validates() {
    let env = setup(common::all_features());
    let target = env.root.join("文 space%20");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("a.txt"), "").unwrap();
    assert_eq!(
        directory(&env, "/文 space%20"),
        (
            200,
            json!({"items": [{"name": "a.txt", "kind": "file"}], "overflow": false})
        )
    );
    for query in [
        "",
        "?",
        "?root=r",
        "?root=r&path=/&extra=a",
        "?root=r&path=/&path=/",
        "?root=r&root=r&path=/",
        "?root=&path=/",
        "?root=r%0A&path=/",
        "?root=r&path=%2F..%2F",
        "?root=r&path=%2F%2e%2e",
        "?root=r&path=%2Fa%2F%2Fb",
        "?root=r&path=%2Fa%5Cb",
        "?root=r&path=%2F%00",
        "?root=r&path=relative",
    ] {
        assert_eq!(
            get(&env.state, &format!("/directory{query}")),
            (400, json!({"error": "invalid directory query"})),
            "{query}"
        );
    }
    assert_eq!(
        get(&env.state, "/directory?root=missing&path=/"),
        (404, json!({"error": "unknown root"}))
    );
    assert_eq!(
        directory(&env, "/missing"),
        (404, json!({"error": "directory unavailable"}))
    );
    assert_eq!(
        directory(&env, "/文 space%20/a.txt").0,
        400,
        "a file is not a directory"
    );
    symlink(&target, env.root.join("link")).unwrap();
    assert_eq!(
        directory(&env, "/link"),
        (400, json!({"error": "directory unavailable"}))
    );
    std::fs::create_dir(env.root.join("%2e%2e")).unwrap();
    assert_eq!(
        get(&env.state, "/directory?root=r&path=/%252e%252e"),
        (200, json!({"items": [], "overflow": false})),
        "a double-encoded dot-dot is a literal name"
    );
    let (status, body) = directory(&env, "/");
    assert_eq!(status, 200);
    let kinds: Vec<(&str, &str)> = body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (e["name"].as_str().unwrap(), e["kind"].as_str().unwrap()))
        .collect();
    assert_eq!(
        kinds,
        vec![("%2e%2e", "dir"), ("link", "symlink"), ("文 space%20", "dir")]
    );
}

#[test]
fn directory_permission_denied_is_403() {
    let env = setup(common::all_features());
    let locked = env.root.join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let readable = std::fs::read_dir(&locked).is_ok();
    let response = directory(&env, "/locked");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
    if readable {
        eprintln!("skipped: running as root bypasses directory permissions");
        return;
    }
    assert_eq!(response, (403, json!({"error": "directory unavailable"})));
}

// ---------------------------------------------------------------------------------------
// /activity
// ---------------------------------------------------------------------------------------

#[test]
fn activity_reads_no_storage_and_reports_waits_and_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let offline = closed_database();
    let cfg = common::config(&offline, dir.path(), dir.path(), &fake_ml::closed_url());
    let mut ctx = RootContext::new(
        "private-root",
        1,
        dir.path().to_path_buf(),
        Arc::clone(&cfg),
        common::features(values(false, true, true, true)),
    );
    ctx.db.retries = 1;
    let ctx = Arc::new(ctx);
    let features: Vec<String> = ["textSearch", "semanticSearch", "imageSearch"]
        .map(str::to_owned)
        .to_vec();
    ctx.activity.start_scan(&features, 2);
    let state = app_state(vec![Arc::clone(&ctx)], &offline, None);

    let (status, body) = get(&state, "/activity");
    assert_eq!(status, 200);
    assert_eq!(body["instanceId"], state.instance_id.as_str());
    assert!(body["observedAt"].is_string());
    assert!(!body.to_string().contains("private-root"));
    let states = |body: &Value| -> Vec<String> {
        body["operations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| op["state"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(states(&body), ["running", "running", "running"]);

    ctx.embed_backoff.note_failure();
    ctx.image_embed_backoff.note_failure();
    let (_, body) = get(&state, "/activity");
    assert_eq!(states(&body), ["running", "waiting", "waiting"]);
    let waiting = &body["operations"][1];
    assert_eq!(waiting["phase"], "waiting");
    assert_eq!(
        (waiting["total"].clone(), waiting["finishedAt"].clone()),
        (Value::Null, Value::Null)
    );

    // A wait only shows while its feature is on.
    ctx.set_features(common::features(values(false, true, false, false)));
    assert_eq!(states(&get(&state, "/activity").1), ["running", "running", "running"]);
    ctx.set_features(common::features(values(false, true, true, true)));
    ctx.embed_backoff.note_success();
    ctx.image_embed_backoff.note_success();
    assert_eq!(states(&get(&state, "/activity").1), ["running", "running", "running"]);

    // Maintenance jobs appear once started, with their progress.
    let job = &state.jobs.thumbnail;
    assert!(job.try_start(4));
    job.discover(100);
    job.discovered();
    for _ in 0..63 {
        job.advance(true, false);
    }
    let (_, body) = get(&state, "/activity");
    let operation = body["operations"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(operation["kind"], "thumbnailRebuild");
    assert_eq!(operation["features"], json!(["thumbnails"]));
    assert_eq!(
        (operation["processed"].as_u64(), operation["total"].as_u64()),
        (Some(63), Some(100))
    );
    assert_eq!(
        (operation["state"].as_str(), operation["revision"].as_i64()),
        (Some("running"), Some(4))
    );
    assert_eq!(operation["unit"], "files");
    job.finish();
    let (_, body) = get(&state, "/activity");
    assert_eq!(
        body["operations"].as_array().unwrap().last().unwrap()["state"],
        "stopped"
    );

    *state.failure_retry_feature.lock().unwrap() = "imageSearch".to_owned();
    assert!(state.jobs.failure_retry.try_start(4));
    assert!(state.jobs.failure_retry.run_id().len() > 10);
    state.jobs.failure_retry.finish();
    assert!(state.jobs.index_clear.try_start(0));
    state.jobs.index_clear.finish();
    let (_, body) = get(&state, "/activity");
    let kinds: Vec<(&str, Value, &str)> = body["operations"]
        .as_array()
        .unwrap()
        .iter()
        .skip(3)
        .map(|op| {
            (
                op["kind"].as_str().unwrap(),
                op["features"].clone(),
                op["unit"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("reindex", json!(["imageSearch"]), "files"),
            ("thumbnailRebuild", json!(["thumbnails"]), "files"),
            ("indexClear", json!(["textSearch", "semanticSearch"]), "entries"),
        ]
    );
    let other = app_state(Vec::new(), &offline, None);
    assert_ne!(other.instance_id, state.instance_id);
}

// ---------------------------------------------------------------------------------------
// /failures/retry
// ---------------------------------------------------------------------------------------

fn failure_id(env: &Env, path: &str) -> i64 {
    common::connect(&env.url)
        .query_one(
            "SELECT id::bigint FROM idx.processing_failures WHERE path = $1",
            &[&path],
        )
        .unwrap()
        .get(0)
}

fn resolved(env: &Env, path: &str) -> bool {
    common::connect(&env.url)
        .query_one(
            "SELECT resolved_at IS NOT NULL FROM idx.processing_failures WHERE path = $1",
            &[&path],
        )
        .unwrap()
        .get(0)
}

#[test]
fn failure_retry_validation_disabled_missing_busy_and_started() {
    let env = setup(values(true, false, false, true));
    for body in [
        "{}",
        r#"{"feature":"unknown"}"#,
        r#"{"feature":"searchOcr"}"#,
        r#"{"feature":"thumbnails","id":true}"#,
        r#"{"feature":"thumbnails","id":0}"#,
        r#"{"feature":"thumbnails","id":-1}"#,
        r#"{"feature":"thumbnails","id":1.5}"#,
        r#"{"feature":"thumbnails","id":"1"}"#,
        "{",
        "[]",
        "",
    ] {
        assert_eq!(post(&env.state, "/failures/retry", body).0, 400, "{body}");
    }
    assert_eq!(
        post_json(&env.state, "/failures/retry", &json!({"feature": "semanticSearch"})),
        (409, json!({"error": "feature disabled"}))
    );
    assert_eq!(
        post_json(
            &env.state,
            "/failures/retry",
            &json!({"feature": "thumbnails", "id": 9999})
        ),
        (404, json!({"error": "no unresolved failure found"}))
    );

    // Image search retries read only the preview, so this holds on every platform.
    write_png(&env.root.join("fixed.png"));
    let sha = sha256(&std::fs::read(env.root.join("fixed.png")).unwrap());
    let preview = env.cfg.thumbs_dir.join(fdrive_indexer::thumbs::storage_path(&sha, 256));
    std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
    std::fs::write(&preview, b"fake webp").unwrap();
    failures::report(
        &env.ctx.db,
        env.ctx.root_id,
        "fixed.png",
        "imageSearch",
        failures::failed("Error: previously broken"),
    );
    let id = failure_id(&env, "fixed.png");
    assert!(env.state.jobs.thumbnail.try_start(0));
    assert_eq!(
        post_json(&env.state, "/failures/retry", &json!({"feature": "imageSearch"})),
        (409, json!({"error": "maintenance busy"}))
    );
    env.state.jobs.thumbnail.finish();
    assert_eq!(
        post_json(
            &env.state,
            "/failures/retry",
            &json!({"feature": "thumbnails", "id": id})
        )
        .0,
        404,
        "the id belongs to another feature"
    );

    let (status, body) = post_json(
        &env.state,
        "/failures/retry",
        &json!({"feature": "imageSearch", "id": id}),
    );
    assert_eq!(status, 202);
    assert_eq!(body["started"], true);
    assert_eq!(body["operationId"], env.state.jobs.failure_retry.run_id().as_str());
    let snapshot = wait(&env.state.jobs.failure_retry);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["outcome"].as_str()),
        (Some(1), Some("completed"))
    );
    assert!(resolved(&env, "fixed.png"));
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 1);

    // A resolved failure can no longer be retried by id; a feature-wide retry still starts.
    assert_eq!(
        post_json(
            &env.state,
            "/failures/retry",
            &json!({"feature": "imageSearch", "id": id})
        )
        .0,
        404
    );
    let (status, body) = post_json(
        &env.state,
        "/failures/retry",
        &json!({"feature": "imageSearch", "id": null}),
    );
    assert_eq!(status, 202);
    assert!(!body["operationId"].as_str().unwrap().is_empty());
    assert_eq!(wait(&env.state.jobs.failure_retry)["total"], 0);
    let (_, activity) = get(&env.state, "/activity");
    let retry = activity["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["kind"] == "reindex")
        .unwrap()
        .clone();
    assert_eq!(
        (retry["kind"].as_str(), retry["features"].clone()),
        (Some("reindex"), json!(["imageSearch"]))
    );
}

// ---------------------------------------------------------------------------------------
// /index/clear, /thumbnails/clear, /image-embeddings/clear
// ---------------------------------------------------------------------------------------

#[test]
fn clear_requests_are_validated() {
    let env = setup(common::all_features());
    for (url, payload, status) in [
        ("/index/clear", "{", 400),
        ("/index/clear", "null", 400),
        ("/index/clear", "[]", 400),
        ("/index/clear", r#"{"root":null}"#, 400),
        ("/index/clear", r#"{"root":1}"#, 400),
        ("/index/clear", r#"{"root":" "}"#, 400),
        ("/index/clear", r#"{"path":"a"}"#, 400),
        ("/index/clear", r#"{"root":"r","path":""}"#, 400),
        ("/index/clear", r#"{"root":"r","path":"../a"}"#, 400),
        ("/index/clear", r#"{"root":"r","path":"a/../b"}"#, 400),
        ("/index/clear", r#"{"root":"r","path":"a\\b"}"#, 400),
        ("/index/clear", r#"{"root":"r","path":"a\u0000b"}"#, 400),
        ("/index/clear", r#"{"root":"missing"}"#, 404),
        ("/index/clear", r#"{"extra":true}"#, 400),
        ("/thumbnails/clear", r#"{"root":"r"}"#, 400),
        ("/image-embeddings/clear", r#"{"root":"r"}"#, 400),
    ] {
        assert_eq!(post(&env.state, url, payload).0, status, "{url} {payload}");
    }
    assert_eq!(env.state.jobs.index_clear.snapshot()["started_at"], Value::Null);
}

#[test]
fn clear_routes_run_and_report() {
    for (url, payload, key) in [
        ("/index/clear", "", "index_clear"),
        ("/index/clear", r#"{"root":"r","path":"/"}"#, "index_clear"),
        ("/index/clear", r#"{"root":"r","path":"/a"}"#, "index_clear"),
        ("/index/clear", r#"{"root":"r","path":"./a/"}"#, "index_clear"),
        ("/thumbnails/clear", "{}", "thumbnail_clear"),
        ("/image-embeddings/clear", "{}", "image_embedding_clear"),
    ] {
        let env = setup(common::all_features());
        upsert(&env.ctx, "a", "sha", 1);
        env.ctx
            .db
            .with(|c| {
                db::upsert_thumbnail(c, "sha", 256, "sh/sha.256.webp", 1, 1)?;
                db::upsert_image_embedding(c, "sha", "model-a", &[0.1; 1024])
            })
            .unwrap();
        assert_eq!(
            post(&env.state, url, payload),
            (202, json!({"started": true})),
            "{url} {payload}"
        );
        let job = match key {
            "index_clear" => &env.state.jobs.index_clear,
            "thumbnail_clear" => &env.state.jobs.thumbnail_clear,
            _ => &env.state.jobs.image_clear,
        };
        wait(job);
        let snapshot = get(&env.state, "/stats").1[key].clone();
        assert!(snapshot["finished_at"].is_string());
        assert_eq!(
            (snapshot["running"].as_bool(), snapshot["errors"].as_u64()),
            (Some(false), Some(0))
        );
        assert_eq!(snapshot["processed"], 1, "{url} {payload}");
        assert!(!env.state.wakes["r"].is_set());
        let (files, thumbnails, embeddings) = (
            env.count("SELECT count(*) FROM idx.files"),
            env.thumbnails(),
            env.count("SELECT count(*) FROM app.image_embeddings"),
        );
        match key {
            "index_clear" => assert_eq!((files, thumbnails, embeddings), (0, 1, 1)),
            "thumbnail_clear" => assert_eq!((files, thumbnails, embeddings), (1, 0, 1)),
            _ => assert_eq!((files, thumbnails, embeddings), (1, 1, 0)),
        }
    }
}

#[test]
fn maintenance_shares_one_admission() {
    let env = setup(common::all_features());
    let jobs = &env.state.jobs;
    for active in [
        &jobs.thumbnail,
        &jobs.index_clear,
        &jobs.thumbnail_clear,
        &jobs.image_rebuild,
        &jobs.image_clear,
        &jobs.failure_retry,
    ] {
        assert!(active.try_start(0));
        for url in [
            "/index/clear",
            "/thumbnails/clear",
            "/thumbnails/rebuild",
            "/image-embeddings/clear",
            "/image-embeddings/rebuild",
        ] {
            assert_eq!(post(&env.state, url, "{}").0, 409, "{url}");
        }
        assert_eq!(
            post_json(&env.state, "/failures/retry", &json!({"feature": "thumbnails"})).0,
            409
        );
        active.finish();
    }
    assert_eq!(post(&env.state, "/index/clear", "{}"), (202, json!({"started": true})));
    wait(&jobs.index_clear);
}

#[test]
fn clear_acknowledges_before_its_work() {
    let env = setup(common::all_features());
    upsert(&env.ctx, "a", "sha", 1);
    let mut locker = common::connect(&env.url);
    let mut tx = locker.transaction().unwrap();
    tx.batch_execute("LOCK TABLE idx.files IN ACCESS EXCLUSIVE MODE")
        .unwrap();
    assert_eq!(post(&env.state, "/index/clear", ""), (202, json!({"started": true})));
    assert_eq!(
        post(&env.state, "/thumbnails/clear", ""),
        (409, json!({"error": "a clear or thumbnail rebuild is already running"}))
    );
    tx.commit().unwrap();
    assert_eq!(wait(&env.state.jobs.index_clear)["outcome"], "completed");
    assert_eq!(env.count("SELECT count(*) FROM idx.files"), 0);
}

#[test]
fn a_wake_times_out_or_returns_once_set_and_clears_itself() {
    let wake = Arc::new(Wake::default());
    assert!(!wake.wait(Duration::from_millis(10)));
    wake.set();
    assert!(wake.is_set());
    assert!(wake.wait(Duration::from_secs(1)));
    assert!(!wake.is_set());
    let setter = {
        let wake = Arc::clone(&wake);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            wake.set();
        })
    };
    assert!(wake.wait(Duration::from_secs(10)));
    setter.join().unwrap();
}
