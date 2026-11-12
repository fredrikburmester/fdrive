//! The `indexer.*` rows of `app.settings`, read every cycle with env defaults as fallback.

use serde_json::Value;

use crate::config::Config;

pub const SCAN_INTERVAL_KEY: &str = "indexer.scan_interval_seconds";
pub const WORKERS_KEY: &str = "indexer.workers";
pub const TEXT_EXCLUDE_GLOBS_KEY: &str = "indexer.text_exclude_globs";
pub const OCR_IMAGE_GLOBS_KEY: &str = "indexer.ocr_image_globs";
pub const TESSERACT_LANGS_KEY: &str = "indexer.tesseract_langs";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub scan_interval_seconds: u64,
    pub workers: usize,
    pub text_exclude_globs: Vec<String>,
    pub ocr_image_globs: Vec<String>,
    pub tesseract_langs: String,
}

pub type RawSettings = std::collections::HashMap<String, Value>;

/// A jsonb value that holds a JSON document as a string is decoded once more.
pub fn decode(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::String(text) => Some(serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone()))),
        other => Some(other.clone()),
    }
}

fn parse_int(raw: Option<&Value>, default: u64) -> u64 {
    match decode(raw) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(default),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(default),
        _ => default,
    }
}

fn parse_list(raw: Option<&Value>, default: &[String]) -> Vec<String> {
    match decode(raw) {
        Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
            items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()
        }
        _ => default.to_vec(),
    }
}

fn parse_str(raw: Option<&Value>, default: &str) -> String {
    match decode(raw) {
        Some(Value::String(s)) if !s.trim().is_empty() => s,
        _ => default.to_owned(),
    }
}

pub fn resolve(raw: &RawSettings, defaults: &Settings) -> Settings {
    Settings {
        scan_interval_seconds: parse_int(raw.get(SCAN_INTERVAL_KEY), defaults.scan_interval_seconds),
        workers: parse_int(raw.get(WORKERS_KEY), defaults.workers as u64) as usize,
        text_exclude_globs: parse_list(raw.get(TEXT_EXCLUDE_GLOBS_KEY), &defaults.text_exclude_globs),
        ocr_image_globs: parse_list(raw.get(OCR_IMAGE_GLOBS_KEY), &defaults.ocr_image_globs),
        tesseract_langs: parse_str(raw.get(TESSERACT_LANGS_KEY), &defaults.tesseract_langs),
    }
}

/// Field names whose value changed, for the `settings changed: …` log line.
pub fn diff_changed(old: &Settings, new: &Settings) -> Vec<&'static str> {
    let mut changed = Vec::new();
    if old.scan_interval_seconds != new.scan_interval_seconds {
        changed.push("scan_interval_seconds");
    }
    if old.workers != new.workers {
        changed.push("workers");
    }
    if old.text_exclude_globs != new.text_exclude_globs {
        changed.push("text_exclude_globs");
    }
    if old.ocr_image_globs != new.ocr_image_globs {
        changed.push("ocr_image_globs");
    }
    if old.tesseract_langs != new.tesseract_langs {
        changed.push("tesseract_langs");
    }
    changed
}

pub fn defaults(config: &Config) -> Settings {
    config.default_settings()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn base() -> Settings {
        Settings {
            scan_interval_seconds: 900,
            workers: 4,
            text_exclude_globs: vec![],
            ocr_image_globs: vec!["**".into()],
            tesseract_langs: "eng".into(),
        }
    }

    fn raw(pairs: &[(&str, Value)]) -> RawSettings {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), v.clone())).collect()
    }

    #[test]
    fn values_and_fallbacks() {
        assert_eq!(resolve(&RawSettings::new(), &base()), base());
        let s = resolve(
            &raw(&[
                (SCAN_INTERVAL_KEY, json!("60")),
                (WORKERS_KEY, json!("007")),
                (TEXT_EXCLUDE_GLOBS_KEY, json!(["a/*"])),
                (OCR_IMAGE_GLOBS_KEY, json!("[\"scans/*\"]")),
                (TESSERACT_LANGS_KEY, json!("swe")),
            ]),
            &base(),
        );
        assert_eq!(s.scan_interval_seconds, 60);
        assert_eq!(s.workers, 7);
        assert_eq!(s.text_exclude_globs, vec!["a/*"]);
        assert_eq!(s.ocr_image_globs, vec!["scans/*"]);
        assert_eq!(s.tesseract_langs, "swe");
        let s = resolve(
            &raw(&[
                (WORKERS_KEY, json!(true)),
                (TEXT_EXCLUDE_GLOBS_KEY, json!(["a", 1])),
                (OCR_IMAGE_GLOBS_KEY, json!("[unterminated")),
                (TESSERACT_LANGS_KEY, json!("  ")),
            ]),
            &base(),
        );
        assert_eq!(s, base());
    }

    #[test]
    fn diff_names_fields() {
        let mut new = base();
        new.workers = 2;
        new.tesseract_langs = "swe".into();
        assert_eq!(diff_changed(&base(), &new), vec!["workers", "tesseract_langs"]);
        new.scan_interval_seconds = 1;
        new.text_exclude_globs = vec!["x".into()];
        new.ocr_image_globs = vec![];
        assert_eq!(diff_changed(&base(), &new).len(), 5);
    }
}
