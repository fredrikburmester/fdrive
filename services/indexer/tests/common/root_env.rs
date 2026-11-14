//! One test root on disk with a thumbnails directory, a fresh database and a fake `ml`
//! server, plus helpers to seed rows and read back what the indexer wrote.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use fdrive_indexer::config::Config;
use fdrive_indexer::db::{self, NewFile};
use fdrive_indexer::features::FeatureValues;
use fdrive_indexer::indexer::{FileStat, RootContext};
use fdrive_indexer::thumbs::{SIZES, storage_path};
use postgres::Client;
use postgres::fallible_iterator::FallibleIterator;

use super::fake_ml::FakeMl;

pub struct Env {
    pub ml: FakeMl,
    pub url: String,
    pub root: PathBuf,
    pub thumbs: PathBuf,
    /// Listening on `idx_events` since the database was made, with what it heard so far.
    events: Mutex<(Client, Vec<Notified>)>,
    _dir: tempfile::TempDir,
}

/// One `NOTIFY idx_events` payload: `(kind, path, target_path)`.
pub type Notified = (String, String, Option<String>);

/// Sent after the indexer's notifications to mark that every earlier one has arrived.
const HEARD_ALL: &str = "heard-all";

/// `thumbnails, textSearch, searchOcr, semanticSearch, imageSearch`; `pdfOcr` off.
pub fn fv(thumbnails: bool, text: bool, ocr: bool, semantic: bool, image: bool) -> FeatureValues {
    FeatureValues {
        thumbnails,
        text_search: text,
        search_ocr: ocr,
        semantic_search: semantic,
        image_search: image,
        pdf_ocr: false,
    }
}

pub const OFF: FeatureValues = FeatureValues {
    thumbnails: false,
    text_search: false,
    search_ocr: false,
    semantic_search: false,
    image_search: false,
    pdf_ocr: false,
};

/// A 64-character hex content key that no real file here hashes to.
pub fn fake_sha(seed: char) -> String {
    seed.to_string().repeat(64)
}

pub fn png(width: u32, height: u32) -> Vec<u8> {
    let picture = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([x as u8, y as u8, 128]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(picture)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

pub fn jpeg(width: u32, height: u32, seed: u8) -> Vec<u8> {
    let picture = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([x as u8 ^ seed, y as u8, seed]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(picture)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .unwrap();
    out.into_inner()
}

/// A minimal PDF whose pages show the given text; an empty string gives a page without
/// a text layer.
pub fn pdf(pages: &[&str]) -> Vec<u8> {
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        String::new(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut kids = Vec::new();
    for text in pages {
        let content = if text.is_empty() {
            String::new()
        } else {
            format!("BT /F1 12 Tf 50 700 Td ({text}) Tj ET")
        };
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

pub fn tesseract_available() -> bool {
    Command::new("tesseract")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A clock for `Backoff` that moves only when the test says so.
pub fn manual_clock() -> (Arc<AtomicU64>, Box<dyn Fn() -> Instant + Send + Sync>) {
    let base = Instant::now();
    let offset = Arc::new(AtomicU64::new(0));
    let reader = Arc::clone(&offset);
    (
        offset,
        Box::new(move || base + Duration::from_secs(reader.load(Ordering::SeqCst))),
    )
}

pub fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    predicate()
}

/// A context for `cfg`'s first root, adjusted by `tweak` before it is shared.
pub fn context_with(cfg: Config, values: FeatureValues, tweak: impl FnOnce(&mut RootContext)) -> Arc<RootContext> {
    let cfg = Arc::new(cfg);
    let (name, path) = cfg.roots[0].clone();
    super::mark_files_folder(&cfg.database_url, &path);
    let root_id = db::upsert_root(&mut super::connect(&cfg.database_url), &name).unwrap();
    let mut ctx = RootContext::new(&name, root_id, path, Arc::clone(&cfg), super::features(values));
    tweak(&mut ctx);
    Arc::new(ctx)
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

impl Env {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let thumbs = dir.path().join("thumbs");
        std::fs::create_dir_all(&root).unwrap();
        let url = super::database();
        let mut listener = super::connect(&url);
        listener.batch_execute("LISTEN idx_events").unwrap();
        Self {
            ml: FakeMl::start(),
            url,
            root,
            thumbs,
            events: Mutex::new((listener, Vec::new())),
            _dir: dir,
        }
    }

    pub fn config(&self) -> Config {
        (*super::config(&self.url, &self.root, &self.thumbs, &self.ml.url)).clone()
    }

    pub fn ctx(&self, values: FeatureValues) -> Arc<RootContext> {
        context_with(self.config(), values, |_| {})
    }

    pub fn ctx_with(&self, values: FeatureValues, tweak: impl FnOnce(&mut RootContext)) -> Arc<RootContext> {
        context_with(self.config(), values, tweak)
    }

    pub fn client(&self) -> Client {
        super::connect(&self.url)
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn write(&self, rel: &str, bytes: &[u8]) -> (PathBuf, FileStat) {
        let path = self.path(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        let stat = self.stat(rel);
        (path, stat)
    }

    pub fn stat(&self, rel: &str) -> FileStat {
        FileStat::of(&std::fs::metadata(self.path(rel)).unwrap())
    }

    /// A row matching the file on disk, with a chosen content key and status.
    pub fn seed(&self, ctx: &RootContext, rel: &str, sha: &str, status: &str) -> i64 {
        let stat = self.stat(rel);
        let name = rel.rsplit('/').next().unwrap();
        let ext = fdrive_indexer::paths::ext_of(name);
        let mut c = self.client();
        let id = db::upsert_file(
            &mut c,
            &NewFile {
                root_id: ctx.root_id,
                path: rel,
                name,
                ext: &ext,
                size: stat.size as i64,
                mtime_ns: stat.mtime_ns,
                sha256: sha,
                mime: None,
            },
        )
        .unwrap();
        if status != "pending" {
            db::update_file_status(&mut c, id, status, 0, None).unwrap();
        }
        id
    }

    pub fn row(&self, ctx: &RootContext, rel: &str) -> db::FileRow {
        db::file_row(&mut self.client(), ctx.root_id, rel).unwrap().unwrap()
    }

    pub fn statuses(&self, ctx: &RootContext) -> HashMap<String, String> {
        db::scan_manifest(&mut self.client(), ctx.root_id)
            .unwrap()
            .into_iter()
            .map(|(path, row)| (path, row.status))
            .collect()
    }

    pub fn status(&self, ctx: &RootContext, rel: &str) -> String {
        self.row(ctx, rel).status
    }

    /// `(path, feature)` of every unresolved failure.
    pub fn unresolved(&self) -> BTreeSet<(String, String)> {
        self.client()
            .query(
                "SELECT path, feature FROM idx.processing_failures WHERE resolved_at IS NULL",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect()
    }

    pub fn attempts(&self, rel: &str, feature: &str) -> Option<i32> {
        self.client()
            .query_opt(
                "SELECT attempts FROM idx.processing_failures WHERE path = $1 AND feature = $2",
                &[&rel, &feature],
            )
            .unwrap()
            .map(|r| r.get(0))
    }

    /// The root's folder rows as `(path, name)`, sorted by path byte by byte.
    pub fn folders(&self, ctx: &RootContext) -> Vec<(String, String)> {
        let mut rows: Vec<(String, String)> = self
            .client()
            .query(
                r#"SELECT path, name FROM "idx"."folders" WHERE root_id = $1::bigint"#,
                &[&ctx.root_id],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect();
        rows.sort();
        rows
    }

    pub fn count(&self, table: &str) -> i64 {
        db::count(&mut self.client(), table).unwrap()
    }

    /// Every event the indexer has sent on `idx_events` so far, oldest first. Notifications
    /// arrive in commit order, so once a marker sent now arrives, every earlier one has.
    pub fn notified(&self) -> Vec<Notified> {
        let mut events = self.events.lock().unwrap_or_else(PoisonError::into_inner);
        let (listener, heard) = &mut *events;
        self.client()
            .execute("SELECT pg_notify('idx_events', $1)", &[&HEARD_ALL])
            .unwrap();
        let mut notifications = listener.notifications();
        let mut arriving = notifications.timeout_iter(Duration::from_secs(10));
        loop {
            let notification = arriving.next().unwrap().expect("the marker arrives");
            if notification.payload() == HEARD_ALL {
                return heard.clone();
            }
            let event: serde_json::Value = serde_json::from_str(notification.payload()).unwrap();
            heard.push((
                event["kind"].as_str().unwrap().to_owned(),
                event["path"].as_str().unwrap().to_owned(),
                event["target_path"].as_str().map(str::to_owned),
            ));
        }
    }

    /// The kinds of `notified`.
    pub fn events(&self) -> Vec<String> {
        self.notified().into_iter().map(|(kind, _, _)| kind).collect()
    }

    pub fn thumb_path(&self, sha: &str, size: u32) -> PathBuf {
        self.thumbs.join(storage_path(sha, size))
    }

    pub fn has_thumbnails(&self, sha: &str) -> bool {
        SIZES.iter().all(|s| self.thumb_path(sha, *s).exists())
    }

    pub fn thumbnail_files(&self) -> usize {
        fn walk(dir: &Path) -> usize {
            std::fs::read_dir(dir).map_or(0, |entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 })
                    .sum()
            })
        }
        walk(&self.thumbs)
    }

    /// Small stand-in thumbnails under `sha`, as if generated earlier.
    pub fn fake_thumbnail(&self, sha: &str) {
        let picture = image::RgbImage::from_pixel(4, 3, image::Rgb([10, 20, 30]));
        let mut webp = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut webp)
            .encode(picture.as_raw(), 4, 3, image::ExtendedColorType::Rgb8)
            .unwrap();
        for size in SIZES {
            let path = self.thumb_path(sha, size);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, &webp).unwrap();
        }
    }

    pub fn snapshot(ctx: &RootContext, feature: &str) -> serde_json::Value {
        ctx.activity
            .snapshot()
            .into_iter()
            .find(|op| op["features"][0] == feature)
            .unwrap_or_else(|| panic!("no operation for {feature}"))
    }
}
