//! The persisted `features.configuration` document. Anything malformed means every
//! feature is off, so processing never starts by accident.

use serde_json::Value;

use crate::settings::{RawSettings, decode};

pub const FEATURES_KEY: &str = "features.configuration";
pub const FEATURE_NAMES: [&str; 6] = ["thumbnails", "textSearch", "searchOcr", "semanticSearch", "imageSearch", "pdfOcr"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureValues {
    pub thumbnails: bool,
    pub text_search: bool,
    pub search_ocr: bool,
    pub semantic_search: bool,
    pub image_search: bool,
    pub pdf_ocr: bool,
}

impl FeatureValues {
    pub fn indexer_enabled(&self) -> bool {
        self.thumbnails || self.text_search || self.image_search
    }

    pub fn internal_thumbnails(&self) -> bool {
        self.thumbnails || self.image_search
    }

    /// Whether the named feature (`thumbnails`, `textSearch`, …) is on.
    pub fn get(&self, name: &str) -> bool {
        match name {
            "thumbnails" => self.thumbnails,
            "textSearch" => self.text_search,
            "searchOcr" => self.search_ocr,
            "semanticSearch" => self.semantic_search,
            "imageSearch" => self.image_search,
            "pdfOcr" => self.pdf_ocr,
            _ => false,
        }
    }

    pub fn as_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        for name in FEATURE_NAMES {
            map.insert(name.to_owned(), Value::Bool(self.get(name)));
        }
        Value::Object(map)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeatureConfiguration {
    pub revision: i64,
    pub values: FeatureValues,
}

impl FeatureConfiguration {
    pub fn as_json(&self) -> Value {
        serde_json::json!({ "revision": self.revision, "values": self.values.as_json() })
    }
}

pub fn resolve(raw: &RawSettings) -> FeatureConfiguration {
    parse(raw).unwrap_or_default()
}

fn parse(raw: &RawSettings) -> Option<FeatureConfiguration> {
    let value = decode(raw.get(FEATURES_KEY))?;
    if value.get("version")?.as_i64()? != 1 || value.get("version")?.is_boolean() {
        return None;
    }
    let revision = value.get("revision")?;
    let revision = if revision.is_boolean() { None } else { revision.as_i64() }?;
    if revision < 0 {
        return None;
    }
    let values = value.get("values")?.as_object()?;
    let flag = |name: &str| values.get(name)?.as_bool();
    Some(FeatureConfiguration {
        revision,
        values: FeatureValues {
            thumbnails: flag("thumbnails")?,
            text_search: flag("textSearch")?,
            search_ocr: flag("searchOcr")?,
            semantic_search: flag("semanticSearch")?,
            image_search: flag("imageSearch")?,
            pdf_ocr: flag("pdfOcr")?,
        },
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn raw(value: Value) -> RawSettings {
        [(FEATURES_KEY.to_owned(), value)].into_iter().collect()
    }

    fn doc(values: Value) -> Value {
        json!({"version": 1, "revision": 3, "values": values})
    }

    fn all(on: bool) -> Value {
        json!({"thumbnails": on, "textSearch": on, "searchOcr": on, "semanticSearch": on, "imageSearch": on, "pdfOcr": on})
    }

    #[test]
    fn malformed_documents_disable_everything() {
        assert_eq!(resolve(&RawSettings::new()), FeatureConfiguration::default());
        for bad in [
            Value::Null,
            json!({}),
            json!({"version": 2, "revision": 1, "values": all(true)}),
            json!({"version": 1, "revision": -1, "values": all(true)}),
            json!({"version": 1, "revision": true, "values": all(true)}),
            doc(json!({"thumbnails": "yes"})),
        ] {
            assert_eq!(resolve(&raw(bad)), FeatureConfiguration::default());
        }
        let unrelated: RawSettings = [("indexer.workers".to_owned(), json!(2))].into_iter().collect();
        assert!(!resolve(&unrelated).values.indexer_enabled());
    }

    #[test]
    fn valid_documents_parse_including_strings() {
        let parsed = resolve(&raw(Value::String(doc(all(true)).to_string())));
        assert_eq!(parsed.revision, 3);
        assert!(parsed.values.pdf_ocr && parsed.values.indexer_enabled());
        assert_eq!(parsed.as_json()["values"]["searchOcr"], json!(true));
        let mut only_image = all(false);
        only_image["imageSearch"] = json!(true);
        let parsed = resolve(&raw(doc(only_image))).values;
        assert!(parsed.internal_thumbnails() && parsed.indexer_enabled() && !parsed.thumbnails);
        assert!(!parsed.get("unknown"));
    }
}
