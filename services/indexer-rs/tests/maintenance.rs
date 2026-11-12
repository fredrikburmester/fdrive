//! Maintenance passes against a migrated database: the three clears, thumbnail and
//! image-embedding rebuilds, and failure retries.

mod common;

use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use common::fake_ml::{self, FakeMl};
use fdrive_indexer::config::Config;
use fdrive_indexer::db::{self, NewFile};
use fdrive_indexer::events::EventKind;
use fdrive_indexer::failures;
use fdrive_indexer::features::FeatureValues;
use fdrive_indexer::indexer::{RootContext, emit_event};
use fdrive_indexer::jobs::Job;
use fdrive_indexer::maintenance::{
    clear_image_embeddings, clear_index, clear_thumbnails, retry_file, start_clear, start_image_rebuild, start_retry,
    start_thumbnail_rebuild,
};
use fdrive_indexer::paths::{basename, ext_of};
use fdrive_indexer::thumbs::storage_path;
use postgres::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

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
    thumbs: PathBuf,
    ml: FakeMl,
    cfg: Arc<Config>,
    ctx: Arc<RootContext>,
}

fn setup(features: FeatureValues) -> Env {
    setup_with(features, |_| {})
}

fn setup_with(features: FeatureValues, change: impl FnOnce(&mut Config)) -> Env {
    let url = common::database();
    let dir = tempfile::tempdir().unwrap();
    // macOS keeps temporary directories behind the /var symlink, and the thumbnail cache is
    // opened without following any symlink.
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("root");
    std::fs::create_dir(&root).unwrap();
    let thumbs = base.join("thumbs");
    let ml = FakeMl::start();
    let mut cfg = (*common::config(&url, &root, &thumbs, &ml.url)).clone();
    change(&mut cfg);
    let cfg = Arc::new(cfg);
    let ctx = common::context(&cfg, features);
    Env {
        url,
        _dir: dir,
        base,
        root,
        thumbs,
        ml,
        cfg,
        ctx,
    }
}

impl Env {
    fn client(&self) -> Client {
        common::connect(&self.url)
    }

    fn count(&self, sql: &str) -> i64 {
        self.client().query_one(sql, &[]).unwrap().get(0)
    }

    fn thumbnails(&self) -> i64 {
        self.count("SELECT count(*) FROM app.thumbnails")
    }

    fn paths(&self, ctx: &RootContext) -> Vec<String> {
        self.client()
            .query(
                "SELECT path FROM idx.files WHERE root_id = $1::bigint ORDER BY path",
                &[&ctx.root_id],
            )
            .unwrap()
            .into_iter()
            .map(|r| r.get(0))
            .collect()
    }

    fn model(&self, key: &str) -> Option<String> {
        self.client()
            .query_opt("SELECT model FROM app.image_embeddings WHERE content_key = $1", &[&key])
            .unwrap()
            .map(|r| r.get(0))
    }

    /// `(feature, path, attempts, resolved, operation_id)` of every failure record.
    fn failures(&self) -> Vec<(String, String, i32, bool, String)> {
        self.client()
            .query(
                "SELECT feature, path, attempts, resolved_at IS NOT NULL, operation_id \
                 FROM idx.processing_failures ORDER BY id",
                &[],
            )
            .unwrap()
            .into_iter()
            .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4)))
            .collect()
    }

    /// A second root, sharing this database and config.
    fn other_root(&self, name: &str) -> Arc<RootContext> {
        let root_id = db::upsert_root(&mut self.client(), name).unwrap();
        Arc::new(RootContext::new(
            name,
            root_id,
            self.root.clone(),
            Arc::clone(&self.cfg),
            common::features(common::all_features()),
        ))
    }

    /// A context on this root that cannot reach any database.
    fn offline(&self) -> Arc<RootContext> {
        let mut cfg = (*self.cfg).clone();
        cfg.database_url = format!(
            "postgres://fdrive:fdrive@{}/fdrive",
            fake_ml::closed_url().trim_start_matches("http://")
        );
        let mut ctx = RootContext::new(
            "r",
            1,
            self.root.clone(),
            Arc::new(cfg),
            common::features(common::all_features()),
        );
        ctx.db.retries = 1;
        Arc::new(ctx)
    }

    fn thumb(&self, sha: &str) {
        let path = self.thumbs.join(storage_path(sha, 256));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"fake webp bytes").unwrap();
    }
}

fn job() -> Arc<Job> {
    Job::new(Arc::new(AtomicBool::new(false)))
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

/// `(processed, total, errors)`.
fn counts(job: &Job) -> (u64, u64, u64) {
    let s = job.snapshot();
    (
        s["processed"].as_u64().unwrap(),
        s["total"].as_u64().unwrap(),
        s["errors"].as_u64().unwrap(),
    )
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

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn write_png(path: &Path) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    image::RgbImage::from_pixel(400, 200, image::Rgb([255, 0, 0]))
        .save(path)
        .unwrap();
}

/// A real PNG at `rel` below the root, registered under the content key `sha`.
fn media(env: &Env, rel: &str, sha: &str) {
    let path = env.root.join(rel);
    write_png(&path);
    let size = std::fs::metadata(&path).unwrap().len() as i64;
    upsert(&env.ctx, rel, sha, size);
}

fn report_failure(ctx: &RootContext, path: &str, feature: &str, message: &str) {
    failures::report(&ctx.db, ctx.root_id, path, feature, failures::failed(message));
}

/// A minimal one-page PDF showing `text` in Helvetica.
fn pdf_bytes(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 12 Tf 50 700 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [5 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 800] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>"
            .to_owned(),
    ];
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

/// A 32x24 AVIF encoded with libheif: the `image` crate here only decodes AVIF.
const AVIF_HEX: &str = "0000001c6674797061766966000000006d696631617669666d696166000000ea6d657461000000000000002168646c720000000000000000706963740000000000000000000000000000000022696c6f630000000044400001000100000000010e000100000000000000270000002369696e6600000000000100000015696e6665020000000001000061763031000000000e7069746d0000000000010000006a697072700000004b6970636f0000000c6176314381000c0000000013636f6c726e636c780001000d0006800000001469737065000000000000002000000018000000107069786900000000030808080000001769706d610000000000000001000104810203040000002f6d64617412000a0918113f76880868342032181947878621879e79e68000008b3cbd6a87c3a7618db73c80";

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// Whether file permissions apply to the current user (root bypasses them).
fn permissions_apply(dir: &Path) -> bool {
    let probe = dir.join("probe");
    std::fs::create_dir(&probe).unwrap();
    chmod(&probe, 0o000);
    let applies = std::fs::read_dir(&probe).is_err();
    chmod(&probe, 0o755);
    std::fs::remove_dir(&probe).unwrap();
    applies
}

fn chmod(path: &Path, mode: u32) {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
}

// ---------------------------------------------------------------------------------------
// Index clear
// ---------------------------------------------------------------------------------------

#[test]
fn index_clear_scope_is_literal_and_keeps_everything_else() {
    let env = setup(common::all_features());
    let other = env.other_root("two");
    for path in ["dir_%", "dir_%/a", "dir_Z/a", "dir_%extra/a", "keep"] {
        let id = upsert(&env.ctx, path, "sha", 1);
        env.ctx
            .db
            .with(|c| db::insert_chunks(c, id, &["hello".to_owned()], &[Some(vec![0.1; 384])]))
            .unwrap();
    }
    upsert(&other, "dir_%/a", "sha", 1);
    env.ctx
        .db
        .with(|c| {
            db::upsert_thumbnail(c, "sha", 256, "sh/sha.webp", 1, 1)?;
            db::start_scan(c, env.ctx.root_id)?;
            db::insert_move(c, env.ctx.root_id, "old", "new", "test")
        })
        .unwrap();
    emit_event(&env.ctx, EventKind::Created, "keep", None);
    std::fs::write(env.root.join("original"), "safe").unwrap();
    env.client()
        .batch_execute(
            "WITH a AS (INSERT INTO app.accounts DEFAULT VALUES RETURNING id), \
             p AS (INSERT INTO app.providers(type, base_url) VALUES ('sftpgo', 'http://clear.test') RETURNING id), \
             i AS (INSERT INTO app.identities(account_id, provider_id, external_username) \
                   SELECT a.id, p.id, 'one' FROM a, p RETURNING id), \
             t AS (INSERT INTO app.tags(account_id, name, color) SELECT id, 'Keep', 'blue' FROM a RETURNING id), \
             ft AS (INSERT INTO app.file_tags(identity_id, path, tag_id) SELECT i.id, 'dir_%/a', t.id FROM i, t), \
             f AS (INSERT INTO app.favorites(identity_id, path) SELECT id, 'dir_%/a' FROM i) \
             INSERT INTO app.recents(identity_id, path) SELECT id, 'dir_%/a' FROM i",
        )
        .unwrap();

    let job = job();
    clear_index(&[Arc::clone(&env.ctx)], Some("dir_%"), &job).unwrap();
    assert_eq!(env.paths(&env.ctx), ["dir_%extra/a", "dir_Z/a", "keep"]);
    assert_eq!(env.paths(&other), ["dir_%/a"]);
    assert_eq!(counts(&job), (2, 2, 0));
    for (table, expected) in [
        ("idx.chunks", 3),
        ("idx.roots", 2),
        ("idx.scans", 1),
        ("idx.moves", 1),
        ("idx.events", 1),
        ("app.thumbnails", 1),
        ("app.file_tags", 1),
        ("app.favorites", 1),
        ("app.recents", 1),
    ] {
        assert_eq!(env.count(&format!("SELECT count(*) FROM {table}")), expected, "{table}");
    }
    let tag: (String, String) = env
        .client()
        .query_one("SELECT name, color FROM app.tags", &[])
        .map(|r| (r.get(0), r.get(1)))
        .unwrap();
    assert_eq!(tag, ("Keep".to_owned(), "blue".to_owned()));
    assert_eq!(std::fs::read_to_string(env.root.join("original")).unwrap(), "safe");

    // An exact file scope clears that file only.
    clear_index(&[Arc::clone(&env.ctx)], Some("keep"), &job).unwrap();
    assert_eq!(env.paths(&env.ctx), ["dir_%extra/a", "dir_Z/a"]);
}

#[test]
fn index_clear_batches_counts_failures_and_keeps_a_fixed_inventory() {
    let env = setup(common::all_features());
    // More than one batch of 250.
    for i in 0..260 {
        upsert(&env.ctx, &format!("p-{i:04}"), "sha", 1);
    }
    env.client()
        .batch_execute(
            "CREATE FUNCTION public.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               RAISE EXCEPTION 'locked'; END $$; \
             CREATE TRIGGER refuse BEFORE DELETE ON idx.files FOR EACH ROW WHEN (OLD.path = 'p-0003') \
               EXECUTE FUNCTION public.refuse_delete(); \
             CREATE FUNCTION public.add_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               INSERT INTO idx.files (root_id, path, name, size, mtime_ns) VALUES (OLD.root_id, 'late', 'late', 1, 1); \
               RETURN OLD; END $$; \
             CREATE TRIGGER late AFTER DELETE ON idx.files FOR EACH ROW WHEN (OLD.path = 'p-0001') \
               EXECUTE FUNCTION public.add_late();",
        )
        .unwrap();
    let job = job();
    clear_index(&[Arc::clone(&env.ctx)], None, &job).unwrap();
    assert_eq!(counts(&job), (260, 260, 1));
    assert_eq!(
        env.paths(&env.ctx),
        ["late", "p-0003"],
        "rows written meanwhile are not visited"
    );
}

#[test]
fn index_clear_waits_for_the_path_lock() {
    let env = setup(common::all_features());
    upsert(&env.ctx, "file.txt", "sha", 1);
    let job = job();
    let guard = env.ctx.path_locks.get("file.txt");
    let clearer = {
        let (ctx, job) = (Arc::clone(&env.ctx), Arc::clone(&job));
        std::thread::spawn(move || clear_index(&[ctx], None, &job).unwrap())
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while job.snapshot()["total"] != 1 {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(50));
    assert!(!clearer.is_finished());
    assert_eq!(env.paths(&env.ctx), ["file.txt"]);
    drop(guard);
    clearer.join().unwrap();
    assert!(env.paths(&env.ctx).is_empty());
    assert_eq!(counts(&job), (1, 1, 0));
}

#[test]
fn clears_report_an_unreachable_database_or_a_linked_cache() {
    let env = setup(common::all_features());
    let offline = [env.offline()];
    let job = job();
    assert!(clear_index(&offline, None, &job).is_err());
    assert!(clear_image_embeddings(&offline, &job).is_err());
    std::fs::create_dir_all(&env.thumbs).unwrap();
    assert!(clear_thumbnails(&offline, &job).is_err());
    // The cache itself must not be behind a symlink.
    let mut cfg = (*env.cfg).clone();
    symlink(&env.thumbs, env.base.join("linked")).unwrap();
    cfg.thumbs_dir = env.base.join("linked");
    let linked = RootContext::new(
        "r",
        env.ctx.root_id,
        env.root.clone(),
        Arc::new(cfg),
        common::features(common::all_features()),
    );
    assert!(clear_thumbnails(&[Arc::new(linked)], &job).is_err());
}

// ---------------------------------------------------------------------------------------
// Thumbnail clear
// ---------------------------------------------------------------------------------------

fn add_thumbnail(env: &Env, key: &str, path: &str) {
    env.ctx
        .db
        .with(|c| db::upsert_thumbnail(c, key, 256, path, 1, 1))
        .unwrap();
}

fn thumbnail_keys(env: &Env) -> Vec<String> {
    env.client()
        .query("SELECT content_key FROM app.thumbnails ORDER BY content_key", &[])
        .unwrap()
        .into_iter()
        .map(|r| r.get(0))
        .collect()
}

#[test]
fn thumbnail_clear_removes_manifest_previews_and_orphans_only() {
    let env = setup(common::all_features());
    let cache = &env.thumbs;
    std::fs::create_dir_all(cache.join("ab")).unwrap();
    let recognised = format!("ab/{}.256.webp", "ab".repeat(32));
    let orphan = format!("ab/{}.1024.webp", "ab".repeat(32));
    let wrong_shard = format!("ab/{}.256.webp", "cd".repeat(32));
    let kept = ["ab/keep.txt", "ab/not-a-hash.256.webp", wrong_shard.as_str()];
    for rel in [recognised.as_str(), orphan.as_str()].into_iter().chain(kept) {
        std::fs::write(cache.join(rel), "preview").unwrap();
    }
    std::fs::write(env.base.join("original"), "safe").unwrap();
    symlink(env.base.join("original"), cache.join("symlink")).unwrap();
    add_thumbnail(&env, "live", &recognised);
    add_thumbnail(&env, "gone", "missing/file.webp");
    add_thumbnail(&env, "bad", "symlink");
    upsert(&env.ctx, "original", "sha", 1);

    let job = job();
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(
        counts(&job),
        (4, 4, 1),
        "three manifest rows and one orphan; the symlink failed"
    );
    assert_eq!(thumbnail_keys(&env), ["bad"], "a failed removal keeps its row");
    assert!(!cache.join(&recognised).exists() && !cache.join(&orphan).exists());
    for rel in kept {
        assert!(cache.join(rel).exists(), "{rel}");
    }
    assert_eq!(std::fs::read_to_string(env.base.join("original")).unwrap(), "safe");
    assert_eq!(env.paths(&env.ctx), ["original"]);

    std::fs::remove_file(cache.join("symlink")).unwrap();
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert!(thumbnail_keys(&env).is_empty());
}

#[test]
fn a_failed_manifest_removal_is_not_counted_again_as_an_orphan() {
    let env = setup(common::all_features());
    let shard = env.thumbs.join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    if !permissions_apply(&env.base) {
        eprintln!("skipped: running as root bypasses permissions");
        return;
    }
    let rel = format!("ab/{}.256.webp", "ab".repeat(32));
    std::fs::write(env.thumbs.join(&rel), "preview").unwrap();
    add_thumbnail(&env, "fail", &rel);
    chmod(&shard, 0o555);
    let job = job();
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(counts(&job), (1, 1, 1));
    assert_eq!(env.thumbnails(), 1);

    env.client().batch_execute("DELETE FROM app.thumbnails").unwrap();
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(counts(&job), (2, 2, 2), "now an unlisted orphan, still read-only");
    chmod(&shard, 0o755);
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert!(!env.thumbs.join(&rel).exists());
    assert_eq!(counts(&job), (3, 3, 2));
}

#[test]
fn an_unreadable_shard_is_counted_once() {
    let env = setup(common::all_features());
    std::fs::create_dir_all(env.thumbs.join("ab")).unwrap();
    std::fs::create_dir_all(env.thumbs.join("cd")).unwrap();
    let orphan = format!("cd/{}.256.webp", "cd".repeat(32));
    std::fs::write(env.thumbs.join(&orphan), "preview").unwrap();
    if !permissions_apply(&env.base) {
        eprintln!("skipped: running as root bypasses permissions");
        return;
    }
    chmod(&env.thumbs.join("ab"), 0o000);
    let job = job();
    let result = clear_thumbnails(&[Arc::clone(&env.ctx)], &job);
    chmod(&env.thumbs.join("ab"), 0o755);
    result.unwrap();
    assert_eq!(counts(&job), (2, 2, 1));
    assert!(!env.thumbs.join(&orphan).exists());
}

#[test]
fn thumbnail_clear_without_a_cache_or_contexts() {
    let env = setup(common::all_features());
    add_thumbnail(&env, "gone", "aa/gone.webp");
    let job = job();
    clear_thumbnails(&[], &job).unwrap();
    assert_eq!(env.thumbnails(), 1);
    assert!(!env.thumbs.exists());
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(env.thumbnails(), 0);
    assert_eq!(counts(&job), (1, 1, 0));
}

#[test]
fn thumbnail_clear_batches_over_a_fixed_inventory() {
    let env = setup(common::all_features());
    env.client()
        .batch_execute(
            "INSERT INTO app.thumbnails (content_key, size, storage_path, width, height) \
               SELECT 'k' || lpad(n::text, 4, '0'), 256, 'kk/' || n || '.webp', 1, 1 FROM generate_series(1, 260) n; \
             CREATE FUNCTION public.generate_preview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               INSERT INTO app.thumbnails (content_key, size, storage_path) VALUES ('z', 256, 'zz/z.webp'); \
               RETURN OLD; END $$; \
             CREATE TRIGGER generate AFTER DELETE ON app.thumbnails FOR EACH ROW WHEN (OLD.content_key = 'k0001') \
               EXECUTE FUNCTION public.generate_preview();",
        )
        .unwrap();
    let job = job();
    clear_thumbnails(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(counts(&job), (260, 260, 0));
    assert_eq!(
        thumbnail_keys(&env),
        ["z"],
        "a preview generated meanwhile is not visited"
    );
}

// ---------------------------------------------------------------------------------------
// Image-embedding clear
// ---------------------------------------------------------------------------------------

#[test]
fn image_embedding_clear_batches_counts_failures_and_keeps_a_fixed_inventory() {
    let env = setup(common::all_features());
    let job = job();
    clear_image_embeddings(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(counts(&job), (0, 0, 0), "an empty table is a no-op");
    env.client()
        .batch_execute(
            "INSERT INTO app.image_embeddings (content_key, model, embedding) \
               SELECT 'k' || lpad(n::text, 4, '0'), 'model-a', array_fill(0.1::real, ARRAY[1024])::vector \
               FROM generate_series(1, 260) n; \
             CREATE FUNCTION public.refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               RAISE EXCEPTION 'delete failed'; END $$; \
             CREATE TRIGGER refuse BEFORE DELETE ON app.image_embeddings FOR EACH ROW \
               WHEN (OLD.content_key = 'k0002') EXECUTE FUNCTION public.refuse_delete(); \
             CREATE FUNCTION public.add_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               INSERT INTO app.image_embeddings (content_key, model, embedding) \
               VALUES ('zz', 'model-a', array_fill(0.1::real, ARRAY[1024])::vector); RETURN OLD; END $$; \
             CREATE TRIGGER late AFTER DELETE ON app.image_embeddings FOR EACH ROW \
               WHEN (OLD.content_key = 'k0001') EXECUTE FUNCTION public.add_late();",
        )
        .unwrap();
    clear_image_embeddings(&[], &job).unwrap();
    assert_eq!(env.count("SELECT count(*) FROM app.image_embeddings"), 260);
    clear_image_embeddings(&[Arc::clone(&env.ctx)], &job).unwrap();
    assert_eq!(counts(&job), (260, 260, 1));
    let keys: Vec<String> = env
        .client()
        .query("SELECT content_key FROM app.image_embeddings ORDER BY content_key", &[])
        .unwrap()
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(keys, ["k0002", "zz"]);
}

// ---------------------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------------------

#[test]
fn clear_failures_and_crashes_release_the_shared_admission() {
    let admission = Arc::new(AtomicBool::new(false));
    let (a, b) = (Job::new(Arc::clone(&admission)), Job::new(Arc::clone(&admission)));
    assert!(start_clear(&a, "index", |_| Err(anyhow::anyhow!("failed"))));
    let snapshot = wait(&a);
    assert_eq!(
        (snapshot["errors"].as_u64(), snapshot["outcome"].as_str()),
        (Some(1), Some("failed"))
    );
    assert!(snapshot["finished_at"].is_string());
    assert!(start_clear(&b, "thumbnails", |_| panic!("crashed")));
    assert_eq!(wait(&b)["outcome"], "failed");
    assert!(b.try_start(0));
    assert!(!start_clear(&a, "index", |_| Ok(())), "the admission is shared");
    b.finish();
    assert!(start_clear(&a, "index", |job| {
        job.discover(1);
        job.advance(true, false);
        Ok(())
    }));
    assert_eq!(wait(&a)["outcome"], "completed");
}

#[test]
fn discovery_failures_finish_every_job_as_failed() {
    let env = setup(common::all_features());
    let offline = env.offline();
    let job = job();
    assert!(start_thumbnail_rebuild(&job, vec![Arc::clone(&offline)], None, false));
    assert_eq!(wait(&job)["outcome"], "failed");
    assert!(start_image_rebuild(&job, vec![Arc::clone(&offline)], None, false));
    assert_eq!(wait(&job)["outcome"], "failed");
    assert!(start_retry(&job, vec![offline], "thumbnails".to_owned(), None));
    let snapshot = wait(&job);
    assert_eq!(
        (snapshot["outcome"].as_str(), snapshot["errors"].as_u64()),
        (Some("failed"), Some(1))
    );
}

// ---------------------------------------------------------------------------------------
// Thumbnail rebuild
// ---------------------------------------------------------------------------------------

fn rebuild(env: &Env, path: Option<&str>, force: bool) -> (Arc<Job>, Value) {
    let job = job();
    assert!(start_thumbnail_rebuild(
        &job,
        vec![Arc::clone(&env.ctx)],
        path.map(str::to_owned),
        force
    ));
    let snapshot = wait(&job);
    (job, snapshot)
}

#[test]
fn thumbnail_rebuild_writes_both_sizes_for_media_and_leaves_text_alone() {
    let env = setup(common::all_features());
    media(&env, "a.png", "sha-a");
    let pdf = pdf_bytes("hello");
    std::fs::write(env.root.join("doc.pdf"), &pdf).unwrap();
    upsert(&env.ctx, "doc.pdf", "sha-pdf", pdf.len() as i64);
    std::fs::write(env.root.join("notes.txt"), "hello").unwrap();
    let notes = upsert(&env.ctx, "notes.txt", "sha-t", 5);
    env.ctx
        .db
        .with(|c| db::update_file_status(c, notes, "indexed", 5, None))
        .unwrap();

    let (_, snapshot) = rebuild(&env, None, false);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["total"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(2), Some(2), Some("completed"))
    );
    assert_eq!(env.thumbnails(), 4);
    let sizes: Vec<(i32, i32, i32)> = env
        .client()
        .query(
            "SELECT size, width, height FROM app.thumbnails WHERE content_key = 'sha-a' ORDER BY size",
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(sizes, [(256, 256, 128), (1024, 400, 200)]);
    let status: String = env
        .client()
        .query_one("SELECT text_status FROM idx.files WHERE path = 'notes.txt'", &[])
        .unwrap()
        .get(0);
    assert_eq!(status, "indexed");
}

#[test]
fn thumbnail_rebuild_follows_its_scope_and_force() {
    let env = setup(common::all_features());
    media(&env, "keep/a.png", "sha-keep");
    media(&env, "skip/b.png", "sha-skip");
    let (_, snapshot) = rebuild(&env, Some("/keep/"), false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["total"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(env.thumbnails(), 2);

    let preview = env.thumbs.join(storage_path("sha-keep", 256));
    let inode = std::fs::metadata(&preview).unwrap().ino();
    rebuild(&env, Some("keep"), false);
    assert_eq!(
        std::fs::metadata(&preview).unwrap().ino(),
        inode,
        "existing previews are kept"
    );
    rebuild(&env, Some("keep"), true);
    assert_ne!(std::fs::metadata(&preview).unwrap().ino(), inode, "force rewrites them");
    assert_eq!(env.thumbnails(), 2);
}

#[test]
fn thumbnail_rebuild_counts_generation_failures_and_continues() {
    for failure in ["missing", "corrupt", "partial"] {
        let env = setup(common::all_features());
        media(&env, "bad.png", "bad");
        media(&env, "good.png", "good");
        match failure {
            "missing" => std::fs::remove_file(env.root.join("bad.png")).unwrap(),
            "corrupt" => std::fs::write(env.root.join("bad.png"), b"not an image").unwrap(),
            // The large preview's place is taken, so only the small one is saved.
            _ => std::fs::create_dir_all(env.thumbs.join(storage_path("bad", 1024))).unwrap(),
        }
        let (job, snapshot) = rebuild(&env, None, false);
        assert_eq!(
            (
                snapshot["processed"].as_u64(),
                snapshot["errors"].as_u64(),
                snapshot["outcome"].as_str()
            ),
            (Some(2), Some(1), Some("failed")),
            "{failure}"
        );
        assert_eq!(env.thumbnails(), if failure == "partial" { 3 } else { 2 }, "{failure}");
        let recorded = env.failures();
        assert_eq!(recorded.len(), 1, "{failure}");
        let (feature, path, attempts, resolved, operation) = &recorded[0];
        assert_eq!(
            (feature.as_str(), path.as_str(), *attempts, *resolved),
            ("thumbnails", "bad.png", 1, false)
        );
        assert_eq!(*operation, job.run_id(), "the failure names the rebuild that saw it");
    }
}

#[test]
fn thumbnail_rebuild_counts_policy_skips_separately() {
    for size in [0, 200 * 1024 * 1024 + 1] {
        let env = setup(common::all_features());
        upsert(&env.ctx, "skip.png", "skip", size);
        let (job, _) = rebuild(&env, None, false);
        let activity = job.activity_snapshot("thumbnailRebuild", &["thumbnails"]).unwrap();
        assert_eq!(
            (
                activity["processed"].as_u64(),
                activity["total"].as_u64(),
                activity["skipped"].as_u64(),
                activity["errors"].as_u64()
            ),
            (Some(1), Some(1), Some(1), Some(0)),
            "{size}"
        );
        assert_eq!(activity["state"], "completed");
        assert_eq!(env.thumbnails(), 0);
    }
}

#[test]
fn thumbnail_rebuild_stops_once_thumbnails_are_disabled() {
    let env = setup(values(true, true, false, false));
    common::save_features(&env.url, values(true, true, false, false));
    let mut ctx = RootContext::new(
        "r",
        env.ctx.root_id,
        env.root.clone(),
        Arc::clone(&env.cfg),
        common::features(values(true, true, false, false)),
    );
    ctx.refresh_features = Some(Duration::ZERO);
    let ctx = Arc::new(ctx);
    media(&env, "a.png", "sha-a");
    media(&env, "b.png", "sha-b");
    // Saving the first preview turns thumbnails off, as a person would in settings.
    let off = json!({"version": 1, "revision": 3, "values": common::values_json(values(false, true, false, false))});
    env.client()
        .batch_execute(&format!(
            "CREATE FUNCTION public.disable_thumbnails() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               UPDATE app.settings SET value = '{off}'::jsonb WHERE key = 'features.configuration'; \
               RETURN NEW; END $$; \
             CREATE TRIGGER disable AFTER INSERT ON app.thumbnails FOR EACH ROW \
               EXECUTE FUNCTION public.disable_thumbnails();"
        ))
        .unwrap();
    let job = job();
    assert!(start_thumbnail_rebuild(&job, vec![Arc::clone(&ctx)], None, false));
    let snapshot = wait(&job);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["total"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(1), Some(2), Some("stopped"))
    );
    assert!(!ctx.values().thumbnails);
    assert_eq!(env.thumbnails(), 2);

    // A root whose thumbnails are already off is skipped entirely.
    assert!(start_thumbnail_rebuild(&job, vec![ctx], None, false));
    assert_eq!(wait(&job)["processed"], 0);
}

#[test]
fn avif_images_get_both_thumbnails() {
    let env = setup(common::all_features());
    let avif = hex(AVIF_HEX);
    std::fs::write(env.root.join("photo.avif"), &avif).unwrap();
    upsert(&env.ctx, "photo.avif", "avif-sha", avif.len() as i64);
    let (_, snapshot) = rebuild(&env, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(1), Some(0))
    );
    assert_eq!(env.thumbnails(), 2);
}

// ---------------------------------------------------------------------------------------
// Image-embedding rebuild
// ---------------------------------------------------------------------------------------

fn image_rebuild(ctx: &Arc<RootContext>, path: Option<&str>, force: bool) -> (Arc<Job>, Value) {
    let job = job();
    assert!(start_image_rebuild(
        &job,
        vec![Arc::clone(ctx)],
        path.map(str::to_owned),
        force
    ));
    let snapshot = wait(&job);
    (job, snapshot)
}

fn image_row(env: &Env, rel: &str, sha: &str, thumb: bool) {
    upsert(&env.ctx, rel, sha, 100);
    if thumb {
        env.thumb(sha);
    }
}

fn embed(env: &Env, key: &str, model: &str) {
    env.ctx
        .db
        .with(|c| db::upsert_image_embedding(c, key, model, &[0.2; 1024]))
        .unwrap();
}

#[test]
fn image_rebuild_without_a_unit_or_with_a_failing_guard_does_nothing() {
    let env = setup_with(common::all_features(), |c| c.image_embed_url.clear());
    image_row(&env, "a.png", "sha-a", true);
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (snapshot["total"].as_u64(), snapshot["outcome"].as_str()),
        (Some(0), Some("completed"))
    );
    assert!(env.ml.seen().is_empty());

    for health in [
        json!({"status": "ok", "model": "model-a", "dim": 512}),
        json!({"status": "loading"}),
    ] {
        let env = setup(common::all_features());
        image_row(&env, "a.png", "sha-a", true);
        env.ml.respond(fake_ml::IMAGE_HEALTH, 200, &health.to_string());
        let (_, snapshot) = image_rebuild(&env.ctx, None, false);
        assert_eq!(snapshot["processed"], 0, "{health}");
        assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 0);
        assert_eq!(env.count("SELECT count(*) FROM app.image_embeddings"), 0);
    }
}

#[test]
fn image_rebuild_embeds_missing_candidates_in_scope() {
    let env = setup(common::all_features());
    image_row(&env, "keep/a.png", "sha-keep", true);
    image_row(&env, "skip/b.png", "sha-skip", true);
    upsert(&env.ctx, "keep/notes.txt", "sha-t", 5);
    let (_, snapshot) = image_rebuild(&env.ctx, Some("keep"), false);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["total"].as_u64(),
            snapshot["errors"].as_u64()
        ),
        (Some(1), Some(1), Some(0))
    );
    assert_eq!(env.model("sha-keep").as_deref(), Some("model-a"));
    assert_eq!(env.model("sha-skip"), None);
    assert_eq!(env.model("sha-t"), None);
}

#[test]
fn image_rebuild_replaces_another_models_rows_only_with_force() {
    let env = setup(common::all_features());
    image_row(&env, "a.png", "sha-a", true);
    image_row(&env, "b.png", "sha-b", true);
    embed(&env, "sha-a", "model-old");
    embed(&env, "sha-b", "model-a");
    let (job, _) = image_rebuild(&env.ctx, Some("a.png"), false);
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 0);
    assert_eq!(env.model("sha-a").as_deref(), Some("model-old"));
    let activity = job.activity_snapshot("imageRebuild", &["imageSearch"]).unwrap();
    assert_eq!(
        (activity["processed"].as_u64(), activity["skipped"].as_u64()),
        (Some(1), Some(1))
    );

    let (_, snapshot) = image_rebuild(&env.ctx, None, true);
    assert_eq!(snapshot["processed"], 2);
    assert_eq!(env.model("sha-a").as_deref(), Some("model-a"));
    let requests = env.ml.requests(fake_ml::IMAGE_EMBED);
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].images(),
        1,
        "a row on the configured model is never recomputed"
    );
}

#[test]
fn image_rebuild_batches_follow_the_configured_size() {
    let env = setup_with(common::all_features(), |c| c.image_embed_batch_size = 2);
    for i in 0..3 {
        image_row(&env, &format!("{i}.png"), &format!("sha-{i}"), true);
    }
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(3), Some(0))
    );
    let sizes: Vec<usize> = env
        .ml
        .requests(fake_ml::IMAGE_EMBED)
        .iter()
        .map(fake_ml::Seen::images)
        .collect();
    assert_eq!(sizes, [2, 1]);
}

#[test]
fn image_rebuild_failures_are_counted_and_recorded() {
    // No thumbnail: nothing is sent.
    let env = setup(common::all_features());
    image_row(&env, "a.png", "sha-a", false);
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["errors"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(1), Some(1), Some("failed"))
    );
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 0);
    let recorded = env.failures();
    assert_eq!(
        (recorded[0].0.as_str(), recorded[0].1.as_str()),
        ("imageSearch", "a.png")
    );

    // The unit refuses the batch: no rows.
    let env = setup(common::all_features());
    image_row(&env, "a.png", "sha-a", true);
    env.ml.fail(fake_ml::IMAGE_EMBED, 500);
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(env.count("SELECT count(*) FROM app.image_embeddings"), 0);
    assert_eq!(env.failures()[0].0, "imageSearch");

    // Fewer vectors than images: the rest has no vector.
    let env = setup(common::all_features());
    image_row(&env, "a.png", "sha-a", true);
    image_row(&env, "b.png", "sha-b", true);
    env.ml.respond(
        fake_ml::IMAGE_EMBED,
        200,
        &json!({"model": "model-a", "dim": 1024, "embeddings": [vec![0.5; 1024]]}).to_string(),
    );
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(2), Some(1))
    );
    assert_eq!(env.count("SELECT count(*) FROM app.image_embeddings"), 1);
}

#[test]
fn image_rebuild_counts_shared_content_as_skipped() {
    let env = setup(common::all_features());
    image_row(&env, "a.png", "same-content", false);
    image_row(&env, "copy.png", "same-content", false);
    embed(&env, "same-content", "model-a");
    let (job, _) = image_rebuild(&env.ctx, None, false);
    let activity = job.activity_snapshot("imageRebuild", &["imageSearch"]).unwrap();
    assert_eq!(
        (
            activity["processed"].as_u64(),
            activity["total"].as_u64(),
            activity["skipped"].as_u64()
        ),
        (Some(2), Some(2), Some(2))
    );
    assert_eq!(activity["state"], "completed");
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 0);
}

#[test]
fn image_rebuild_skips_a_root_with_image_search_off() {
    let env = setup(values(true, true, false, false));
    image_row(&env, "a.png", "sha-a", true);
    let (_, snapshot) = image_rebuild(&env.ctx, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["total"].as_u64()),
        (Some(0), Some(1))
    );
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 0);
}

// ---------------------------------------------------------------------------------------
// Failure retry
// ---------------------------------------------------------------------------------------

#[test]
fn retry_rejects_symlinks_missing_files_and_escapes() {
    let env = setup(values(true, false, false, false));
    write_png(&env.base.join("outside.png"));
    symlink(env.base.join("outside.png"), env.root.join("link.png")).unwrap();
    for path in ["link.png", "missing.png", "../outside.png"] {
        assert_eq!(retry_file(&env.ctx, path, "thumbnails"), (false, false), "{path}");
    }
    assert_eq!(env.thumbnails(), 0);
    let recorded: Vec<String> = env.failures().into_iter().map(|f| f.1).collect();
    assert_eq!(recorded, ["link.png", "missing.png", "../outside.png"]);
}

// macOS reopens `/dev/fd/N` on the shared offset, and image decoding opens its source twice.
#[test]
#[cfg_attr(target_os = "macos", ignore = "descriptor paths share one offset on macOS")]
fn thumbnail_retry_rewrites_a_repaired_file() {
    let env = setup(values(true, false, false, false));
    std::fs::write(env.root.join("broken.png"), b"not a png").unwrap();
    upsert(&env.ctx, "broken.png", &"a".repeat(64), 9);
    let (job, _) = rebuild(&env, None, false);
    let recorded = env.failures();
    assert_eq!(
        (
            recorded[0].0.as_str(),
            recorded[0].1.as_str(),
            recorded[0].2,
            recorded[0].3
        ),
        ("thumbnails", "broken.png", 1, false)
    );
    assert_eq!(recorded[0].4, job.run_id());

    write_png(&env.root.join("broken.png"));
    assert_eq!(retry_file(&env.ctx, "broken.png", "thumbnails"), (true, false));
    assert!(env.failures()[0].3);
    assert_eq!(env.thumbnails(), 2);
    let sha: String = env
        .client()
        .query_one("SELECT sha256 FROM idx.files WHERE path = 'broken.png'", &[])
        .unwrap()
        .get(0);
    assert_eq!(sha, sha256(&std::fs::read(env.root.join("broken.png")).unwrap()));
}

#[test]
fn image_retry_resolves_only_its_own_feature() {
    let env = setup(values(true, false, false, true));
    write_png(&env.root.join("photo.png"));
    let sha = sha256(&std::fs::read(env.root.join("photo.png")).unwrap());
    env.thumb(&sha);
    for feature in ["thumbnails", "imageSearch"] {
        report_failure(&env.ctx, "photo.png", feature, "Error: earlier attempt");
    }
    assert_eq!(retry_file(&env.ctx, "photo.png", "imageSearch"), (true, false));
    let recorded = env.failures();
    assert_eq!((recorded[0].0.as_str(), recorded[0].3), ("thumbnails", false));
    assert_eq!((recorded[1].0.as_str(), recorded[1].3), ("imageSearch", true));
    assert_eq!(env.model(&sha).as_deref(), Some("model-a"));
}

#[test]
fn text_retry_rewrites_chunks_without_media_or_embeddings() {
    let env = setup(values(true, true, true, true));
    std::fs::write(env.root.join("repaired.txt"), "recovered text").unwrap();
    report_failure(&env.ctx, "repaired.txt", "textSearch", "DecodeError: could not read");
    assert_eq!(retry_file(&env.ctx, "repaired.txt", "textSearch"), (true, false));
    assert!(env.failures()[0].3);
    let chunk: (String, bool) = env
        .client()
        .query_one("SELECT text, embedding IS NULL FROM idx.chunks", &[])
        .map(|r| (r.get(0), r.get(1)))
        .unwrap();
    assert_eq!(chunk, ("recovered text".to_owned(), true));
    assert!(env.ml.seen().is_empty(), "no embedding or image request");
    assert_eq!(env.thumbnails(), 0);
}

#[test]
fn semantic_retry_keeps_changed_and_missing_sources_unresolved() {
    let env = setup(values(false, true, true, false));
    let source = env.root.join("words.txt");
    std::fs::write(&source, "original").unwrap();
    let id = upsert(&env.ctx, "words.txt", &sha256(b"original"), 8);
    env.ctx
        .db
        .with(|c| db::insert_chunks(c, id, &["original".to_owned()], &[None]))
        .unwrap();
    report_failure(&env.ctx, "words.txt", "semanticSearch", "ValueError: rejected");
    std::fs::write(&source, "changed").unwrap();
    assert_eq!(retry_file(&env.ctx, "words.txt", "semanticSearch"), (false, false));
    assert!(!env.failures()[0].3);
    std::fs::remove_file(&source).unwrap();
    assert_eq!(retry_file(&env.ctx, "words.txt", "semanticSearch"), (false, false));
    assert!(!env.failures()[0].3);
    assert_eq!(env.ml.count(fake_ml::TEXT_EMBED), 0);

    std::fs::write(&source, "original").unwrap();
    assert_eq!(retry_file(&env.ctx, "words.txt", "semanticSearch"), (true, false));
    assert!(env.failures()[0].3);
    assert_eq!(
        env.count("SELECT count(*) FROM idx.chunks WHERE embedding IS NOT NULL"),
        1
    );
}

/// A real PNG at `name` below the root with its 256 px preview in place, as image search
/// needs; returns its content key.
fn previewed_png(env: &Env, name: &str) -> String {
    write_png(&env.root.join(name));
    let sha = sha256(&std::fs::read(env.root.join(name)).unwrap());
    env.thumb(&sha);
    sha
}

#[test]
fn retry_runs_a_fixed_inventory_once_admitted() {
    let env = setup(values(true, false, false, true));
    let sha = previewed_png(&env, "fixed.png");
    report_failure(&env.ctx, "fixed.png", "imageSearch", "Error: previously broken");
    report_failure(&env.ctx, "missing.png", "imageSearch", "FileNotFoundError: missing");
    let admission = Arc::new(AtomicBool::new(false));
    let (job, other) = (Job::new(Arc::clone(&admission)), Job::new(Arc::clone(&admission)));
    let retry = |id: Option<i64>| start_retry(&job, vec![Arc::clone(&env.ctx)], "imageSearch".to_owned(), id);
    assert!(other.try_start(0));
    assert!(!retry(None));
    other.finish();

    assert!(retry(None));
    let snapshot = wait(&job);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["errors"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(2), Some(1), Some("failed"))
    );
    assert_eq!(env.model(&sha).as_deref(), Some("model-a"));
    let recorded = env.failures();
    assert_eq!((recorded[0].1.as_str(), recorded[0].3), ("fixed.png", true));
    assert_eq!(
        (recorded[1].1.as_str(), recorded[1].2, recorded[1].3),
        ("missing.png", 2, false),
        "a failed retry counts one more attempt, once"
    );
    assert_eq!(recorded[1].4, job.run_id());

    // One id only.
    let id: i64 = env
        .client()
        .query_one(
            "SELECT id::bigint FROM idx.processing_failures WHERE path = 'missing.png'",
            &[],
        )
        .unwrap()
        .get(0);
    assert!(retry(Some(id)));
    wait(&job);
    assert_eq!(counts(&job), (1, 1, 1));
    assert_eq!(env.failures()[1].2, 3);
}

#[test]
fn retry_skips_failures_resolved_meanwhile_and_stops_when_disabled() {
    let env = setup(values(true, false, false, true));
    for name in ["a.png", "b.png"] {
        previewed_png(&env, name);
        report_failure(&env.ctx, name, "imageSearch", "Error: earlier");
    }
    // Retrying the first file settles the second one's record as well.
    env.client()
        .batch_execute(
            "CREATE FUNCTION public.settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               UPDATE idx.processing_failures SET resolved_at = now() WHERE path = 'b.png'; RETURN NEW; END $$; \
             CREATE TRIGGER settle AFTER INSERT ON app.image_embeddings FOR EACH ROW \
               EXECUTE FUNCTION public.settle();",
        )
        .unwrap();
    let job = job();
    assert!(start_retry(
        &job,
        vec![Arc::clone(&env.ctx)],
        "imageSearch".to_owned(),
        None
    ));
    let snapshot = wait(&job);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["errors"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(2), Some(0), Some("completed"))
    );
    let activity = job.activity_snapshot("reindex", &["imageSearch"]).unwrap();
    assert_eq!(activity["skipped"], 1);
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 1, "only a.png was embedded");

    report_failure(&env.ctx, "a.png", "imageSearch", "Error: again");
    env.ctx
        .set_features(common::features(values(true, false, false, false)));
    assert!(start_retry(
        &job,
        vec![Arc::clone(&env.ctx)],
        "imageSearch".to_owned(),
        None
    ));
    let snapshot = wait(&job);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["total"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(0), Some(1), Some("stopped"))
    );
}

#[test]
fn a_failed_thumbnail_record_is_counted_as_an_error() {
    let env = setup(common::all_features());
    media(&env, "a.png", "sha-a");
    env.client()
        .batch_execute(
            "CREATE FUNCTION public.refuse_preview() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               RAISE EXCEPTION 'manifest unavailable'; END $$; \
             CREATE TRIGGER refuse BEFORE INSERT ON app.thumbnails FOR EACH ROW \
               WHEN (NEW.size = 1024) EXECUTE FUNCTION public.refuse_preview();",
        )
        .unwrap();
    let (_, snapshot) = rebuild(&env, None, false);
    assert_eq!(
        (snapshot["processed"].as_u64(), snapshot["errors"].as_u64()),
        (Some(1), Some(1))
    );
    assert_eq!(env.thumbnails(), 1);
    assert_eq!(env.failures()[0].0, "thumbnails");
}

#[test]
fn a_video_without_a_picture_is_a_resolving_skip() {
    let tools = ["ffmpeg", "ffprobe"]
        .iter()
        .all(|tool| std::process::Command::new(tool).arg("-version").output().is_ok());
    if !tools {
        eprintln!("skipped: ffmpeg and ffprobe are not installed");
        return;
    }
    let env = setup(common::all_features());
    let voice = env.root.join("voice.mp4");
    let made = std::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-t",
            "0.3",
        ])
        .arg(&voice)
        .status()
        .unwrap();
    assert!(made.success());
    let size = std::fs::metadata(&voice).unwrap().len() as i64;
    upsert(&env.ctx, "voice.mp4", "voice-sha", size);
    report_failure(&env.ctx, "voice.mp4", "thumbnails", "CalledProcessError: no stream");
    let (job, _) = rebuild(&env, None, false);
    let activity = job.activity_snapshot("thumbnailRebuild", &["thumbnails"]).unwrap();
    assert_eq!(
        (
            activity["skipped"].as_u64(),
            activity["errors"].as_u64(),
            activity["state"].as_str()
        ),
        (Some(1), Some(0), Some("completed"))
    );
    assert!(
        env.failures()[0].3,
        "reading the file and finding no picture settles the failure"
    );
    assert_eq!(env.thumbnails(), 0);
}

#[test]
fn a_skipped_retry_is_not_a_recovery() {
    let env = setup(values(true, false, false, false));
    std::fs::write(env.root.join("empty.png"), b"").unwrap();
    report_failure(&env.ctx, "empty.png", "thumbnails", "DecodeError: original issue");
    assert_eq!(retry_file(&env.ctx, "empty.png", "thumbnails"), (true, true));
    let recorded = env.failures();
    assert_eq!((recorded[0].2, recorded[0].3), (1, false));
}

#[test]
fn image_rebuild_without_a_unit_returns_before_any_request() {
    let env = setup_with(common::all_features(), |c| c.image_embed_url.clear());
    image_row(&env, "a.png", "sha-a", true);
    let job = job();
    let rows = vec![("a.png".to_owned(), ".png".to_owned(), "sha-a".to_owned(), 100)];
    fdrive_indexer::maintenance::rebuild_image_embeddings(&env.ctx, &rows, false, &job);
    assert_eq!(counts(&job), (0, 0, 0));
    assert!(env.ml.seen().is_empty());
}

#[test]
fn image_rebuild_stops_once_image_search_is_disabled() {
    let env = setup_with(common::all_features(), |c| c.image_embed_batch_size = 1);
    common::save_features(&env.url, common::all_features());
    let mut ctx = RootContext::new(
        "r",
        env.ctx.root_id,
        env.root.clone(),
        Arc::clone(&env.cfg),
        common::features(common::all_features()),
    );
    ctx.refresh_features = Some(Duration::ZERO);
    let ctx = Arc::new(ctx);
    image_row(&env, "a.png", "sha-a", true);
    image_row(&env, "b.png", "sha-b", true);
    let off = json!({"version": 1, "revision": 3, "values": common::values_json(values(true, true, true, false))});
    env.client()
        .batch_execute(&format!(
            "CREATE FUNCTION public.disable_images() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
               UPDATE app.settings SET value = '{off}'::jsonb WHERE key = 'features.configuration'; \
               RETURN NEW; END $$; \
             CREATE TRIGGER disable AFTER INSERT ON app.image_embeddings FOR EACH ROW \
               EXECUTE FUNCTION public.disable_images();"
        ))
        .unwrap();
    let (_, snapshot) = image_rebuild(&ctx, None, false);
    assert_eq!(
        (
            snapshot["processed"].as_u64(),
            snapshot["total"].as_u64(),
            snapshot["outcome"].as_str()
        ),
        (Some(1), Some(2), Some("stopped"))
    );
    assert_eq!(env.ml.count(fake_ml::IMAGE_EMBED), 1);
}
