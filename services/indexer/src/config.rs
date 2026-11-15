//! Environment configuration, mostly with the Python indexer's names and defaults.

use std::path::PathBuf;
use std::time::Duration;

use crate::rules::split_prefixes;
use crate::settings::{MAX_WORKERS, Settings};

pub const SKIP_NAMES: &[&str] = &[
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    ".localized",
    crate::files_marker::FILES_MARKER,
];
/// Folders a walk never enters, wherever they lie. fdrive's own is the Mac app's folder (its
/// staged uploads); fdrive's Trash is indexed, so moves into and out of it stay renames that keep
/// thumbnails and embeddings.
pub const SKIP_DIRS: &[&str] = &[
    ".fdrive-desktop",
    "@eaDir",
    ".Trash",
    ".Trashes",
    "node_modules",
    ".git",
];

/// The files folder, the one root the indexer serves.
pub const ROOT_NAME: &str = "files";
/// The files root's `idx.roots` id, seeded by a migration (`index_root_files`).
pub const ROOT_ID: i64 = 1;
/// Where the files folder is mounted.
pub const ROOT_PATH: &str = "/data";

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    /// The files folder: `ROOT_PATH`, never read from the environment.
    pub root: PathBuf,
    /// The `ml` server; its units are `extract_url`, `text_url` and `image_url`.
    pub ml_url: String,
    pub embed_batch: usize,
    pub image_embed_batch_size: usize,
    pub scan_interval: u64,
    pub text_max_bytes: u64,
    pub image_max_bytes: u64,
    pub plain_text_cap: usize,
    pub max_pdf_pages: usize,
    pub max_chunks_per_file: usize,
    pub chunk_chars: usize,
    pub chunk_overlap: usize,
    pub text_exclude_globs: Vec<String>,
    pub tesseract_langs: String,
    pub watch: bool,
    pub watch_debounce: Duration,
    pub workers: usize,
    pub thumbs_dir: PathBuf,
    pub thumb_max_bytes: u64,
    pub indexer_port: u16,
    pub settings_refresh: Duration,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|name| std::env::var(name).ok())
    }

    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let text = |name: &str, default: &str| var(name).unwrap_or_else(|| default.to_owned());
        let number = |name: &str, default: u64| -> Result<u64, String> {
            match var(name) {
                Some(value) => value
                    .trim()
                    .parse()
                    .map_err(|_| format!("{name} must be a whole number, not '{value}'")),
                None => Ok(default),
            }
        };
        let flag = |name: &str, default: bool| {
            var(name).map_or(default, |v| {
                matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")
            })
        };
        let mb = |name: &str, default: u64| number(name, default).map(|v| v * 1024 * 1024);
        let image_batch = match var("IMAGE_EMBED_REQUEST_BATCH_SIZE") {
            Some(_) => number("IMAGE_EMBED_REQUEST_BATCH_SIZE", 8)?,
            None => number("IMAGE_EMBED_BATCH_SIZE", 8)?,
        };
        let debounce = text("WATCH_DEBOUNCE_SECONDS", "2");
        let debounce: f64 = debounce
            .trim()
            .parse()
            .map_err(|_| format!("WATCH_DEBOUNCE_SECONDS must be a number, not '{debounce}'"))?;
        Ok(Self {
            database_url: text("DATABASE_URL", "postgres://fdrive:fdrive@db:5432/fdrive"),
            root: PathBuf::from(ROOT_PATH),
            ml_url: text("ML_URL", "http://ml:8080").trim_end_matches('/').to_owned(),
            embed_batch: number("EMBED_BATCH", 16)?.max(1) as usize,
            image_embed_batch_size: image_batch as usize,
            scan_interval: number("SCAN_INTERVAL_SECONDS", 3600)?,
            text_max_bytes: mb("TEXT_MAX_MB", 64)?,
            image_max_bytes: mb("IMAGE_MAX_MB", 25)?,
            plain_text_cap: number("PLAIN_TEXT_CAP", 300_000)? as usize,
            max_pdf_pages: number("MAX_PDF_PAGES", 600)? as usize,
            max_chunks_per_file: number("MAX_CHUNKS_PER_FILE", 400)? as usize,
            chunk_chars: number("CHUNK_CHARS", 1200)?.max(1) as usize,
            chunk_overlap: number("CHUNK_OVERLAP", 200)? as usize,
            text_exclude_globs: split_prefixes(&text("TEXT_EXCLUDE_GLOBS", "")),
            tesseract_langs: text("TESSERACT_LANGS", "swe+eng"),
            watch: flag("WATCH", true),
            watch_debounce: Duration::from_secs_f64(debounce.max(0.0)),
            workers: (number("INDEX_WORKERS", 4)? as usize).clamp(1, MAX_WORKERS),
            thumbs_dir: PathBuf::from(text("THUMBS_DIR", "/thumbs")),
            thumb_max_bytes: mb("THUMB_MAX_MB", 200)?,
            indexer_port: number("INDEXER_PORT", 8010)? as u16,
            settings_refresh: Duration::from_secs(number("SETTINGS_REFRESH_SECONDS", 5)?.max(1)),
        })
    }

    /// The `ml` server's document extraction unit.
    pub fn extract_url(&self) -> String {
        format!("{}/extract", self.ml_url)
    }

    /// The `ml` server's text embedding unit.
    pub fn text_url(&self) -> String {
        format!("{}/text", self.ml_url)
    }

    /// The `ml` server's image embedding unit.
    pub fn image_url(&self) -> String {
        format!("{}/image", self.ml_url)
    }

    /// Feature admission is separate; once search OCR is on, an unset scope covers the whole root.
    pub fn default_settings(&self) -> Settings {
        Settings {
            scan_interval_seconds: self.scan_interval,
            workers: self.workers,
            text_exclude_globs: self.text_exclude_globs.clone(),
            ocr_image_globs: vec!["**".to_owned()],
            tesseract_langs: self.tesseract_langs.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, String> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        Config::from_vars(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults_and_overrides() {
        let c = config(&[]).unwrap();
        assert_eq!(c.root, PathBuf::from(ROOT_PATH));
        assert!(c.watch);
        assert_eq!(c.chunk_chars, 1200);
        assert_eq!(c.indexer_port, 8010);
        assert_eq!(c.ml_url, "http://ml:8080");
        assert_eq!(
            (c.extract_url(), c.text_url(), c.image_url()),
            (
                "http://ml:8080/extract".to_owned(),
                "http://ml:8080/text".to_owned(),
                "http://ml:8080/image".to_owned()
            )
        );
        assert_eq!(c.image_embed_batch_size, 8);
        assert_eq!(c.default_settings().ocr_image_globs, vec!["**"]);
        assert_eq!(c.text_max_bytes, 64 * 1024 * 1024);
        let c = config(&[
            ("WATCH", "false"),
            ("ML_URL", "http://models:9000/"),
            ("IMAGE_EMBED_BATCH_SIZE", "4"),
            ("TEXT_EXCLUDE_GLOBS", "a/*, b"),
        ])
        .unwrap();
        assert!(!c.watch);
        assert_eq!(c.ml_url, "http://models:9000");
        assert_eq!(c.image_url(), "http://models:9000/image");
        assert_eq!(c.image_embed_batch_size, 4);
        assert_eq!(c.text_exclude_globs, vec!["a/*", "b"]);
        let c = config(&[("IMAGE_EMBED_BATCH_SIZE", "4"), ("IMAGE_EMBED_REQUEST_BATCH_SIZE", "2")]).unwrap();
        assert_eq!(c.image_embed_batch_size, 2);
        assert!(config(&[("INDEX_WORKERS", "many")]).is_err());
        assert_eq!(config(&[("INDEX_WORKERS", "64")]).unwrap().workers, MAX_WORKERS);
        assert!(config(&[("WATCH_DEBOUNCE_SECONDS", "soon")]).is_err());
        assert_eq!(
            config(&[("SETTINGS_REFRESH_SECONDS", "0")]).unwrap().settings_refresh,
            Duration::from_secs(1)
        );
    }
}
