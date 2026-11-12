//! The `ml` server's image unit: health, the 1024-wide dimension guard, batched requests,
//! and the decisions about which rows need (re)embedding.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::blocking::multipart::{Form, Part};
use serde_json::Value;

use crate::http::client;
use crate::thumbs::{Kind, is_thumbnail_candidate, kind_for_ext};

/// The width of `app.image_embeddings.embedding`. Any other dimension is a hard stop,
/// never a truncation or padding.
pub const DIMENSIONS: i64 = 1024;
/// The server answers 413 above this many images per request.
pub const MAX_IMAGES_PER_REQUEST: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub status: String,
    pub model: Option<String>,
    pub dim: Option<i64>,
}

/// Tolerant parsing: a malformed field fails the dimension guard instead of raising.
pub fn parse_health(body: &Value) -> Health {
    Health {
        status: body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("loading")
            .to_owned(),
        model: body.get("model").and_then(Value::as_str).map(str::to_owned),
        dim: body.get("dim").filter(|v| !v.is_boolean()).and_then(Value::as_i64),
    }
}

/// `None` when the unit cannot be reached at all; a `loading` unit still answers.
pub fn health(url: &str, timeout: Duration) -> Option<Health> {
    let response = client().get(format!("{url}/health")).timeout(timeout).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().ok().map(|body| parse_health(&body))
}

pub fn dimension_guard(health: Option<&Health>) -> Option<String> {
    let health = match health {
        None => return Some("image-embed sidecar unreachable".to_owned()),
        Some(health) => health,
    };
    if health.status != "ok" {
        return Some(format!("image-embed sidecar not ready (status={})", health.status));
    }
    if health.dim != Some(DIMENSIONS) {
        let got = health.dim.map_or("None".to_owned(), |d| d.to_string());
        return Some(format!(
            "image-embed sidecar dimension mismatch: expected {DIMENSIONS}, got {got}"
        ));
    }
    None
}

pub fn parse_embed_response(body: &Value) -> Result<(Vec<Vec<f32>>, String)> {
    let model = body.get("model").and_then(Value::as_str);
    let embeddings = body.get("embeddings").and_then(Value::as_array);
    let (Some(model), Some(embeddings)) = (model, embeddings) else {
        bail!("ValueError: malformed image-embed response");
    };
    let vectors = embeddings
        .iter()
        .map(|v| {
            v.as_array()
                .context("ValueError: malformed image-embed response")?
                .iter()
                .map(|x| {
                    x.as_f64()
                        .map(|x| x as f32)
                        .context("ValueError: malformed image-embed response")
                })
                .collect()
        })
        .collect::<Result<_>>()?;
    Ok((vectors, model.to_owned()))
}

/// POST images in groups of at most `min(batch, 32)`; returns vectors in order and the model.
pub fn embed_images(images: &[Vec<u8>], url: &str, batch: usize) -> Result<(Vec<Vec<f32>>, String)> {
    let step = batch.clamp(1, MAX_IMAGES_PER_REQUEST);
    let mut vectors = Vec::with_capacity(images.len());
    let mut model = String::new();
    for (start, group) in images.chunks(step).enumerate() {
        let mut form = Form::new();
        for (j, data) in group.iter().enumerate() {
            let part = Part::bytes(data.clone())
                .file_name(format!("{}.bin", start * step + j))
                .mime_str("application/octet-stream")?;
            form = form.part("images", part);
        }
        let response = client()
            .post(format!("{url}/embed/image"))
            .multipart(form)
            .timeout(Duration::from_secs(60))
            .send()?
            .error_for_status()?;
        let (embedded, reported) = parse_embed_response(&response.json()?)?;
        vectors.extend(embedded);
        model = reported;
    }
    Ok((vectors, model))
}

/// Images earn an embedding; a PDF page or a video frame does not.
pub fn is_candidate(ext: &str) -> bool {
    kind_for_ext(ext) == Some(Kind::Image)
}

pub fn is_rebuild_candidate(ext: &str, rel_path: &str, scope: &str) -> bool {
    is_candidate(ext) && is_thumbnail_candidate(ext, rel_path, scope)
}

/// The live path re-embeds anything not written by the configured model.
pub fn needs_embedding(existing: Option<&str>, configured: &str) -> bool {
    existing != Some(configured)
}

/// A rebuild fills missing rows; it replaces another model's rows only with `force`.
pub fn rebuild_needs_embedding(existing: Option<&str>, configured: &str, force: bool) -> bool {
    match existing {
        None => true,
        Some(model) if model == configured => false,
        Some(_) => force,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::http::fake::Server;

    #[test]
    fn health_parsing_and_guard() {
        let ok = parse_health(&json!({"status": "ok", "model": "m", "dim": 1024, "device": "cpu"}));
        assert_eq!(dimension_guard(Some(&ok)), None);
        let bad = parse_health(&json!({"status": 1, "model": 2, "dim": true}));
        assert_eq!(
            bad,
            Health {
                status: "loading".into(),
                model: None,
                dim: None
            }
        );
        assert_eq!(dimension_guard(None).unwrap(), "image-embed sidecar unreachable");
        assert!(dimension_guard(Some(&bad)).unwrap().contains("status=loading"));
        let narrow = parse_health(&json!({"status": "ok", "dim": 512}));
        assert_eq!(
            dimension_guard(Some(&narrow)).unwrap(),
            "image-embed sidecar dimension mismatch: expected 1024, got 512"
        );
        let missing = parse_health(&json!({"status": "ok"}));
        assert!(dimension_guard(Some(&missing)).unwrap().ends_with("got None"));
    }

    #[test]
    fn health_over_http() {
        let server = Server::start();
        server.route("/health", 200, r#"{"status":"ok","model":"m","dim":1024}"#);
        assert_eq!(
            health(&server.url, Duration::from_secs(2)).unwrap().model.as_deref(),
            Some("m")
        );
        server.route("/health", 503, "");
        assert_eq!(health(&server.url, Duration::from_secs(2)), None);
        server.route("/health", 200, "not json");
        assert_eq!(health(&server.url, Duration::from_secs(2)), None);
        assert_eq!(health("http://127.0.0.1:1", Duration::from_secs(1)), None);
    }

    #[test]
    fn embedding_requests_are_batched() {
        let server = Server::start();
        server.respond("/embed/image", |seen| {
            let count = String::from_utf8_lossy(&seen.body).matches("name=\"images\"").count();
            let vectors: Vec<Vec<f32>> = (0..count).map(|_| vec![0.5; 2]).collect();
            (200, json!({"model": "m", "dim": 2, "embeddings": vectors}).to_string())
        });
        let images: Vec<Vec<u8>> = (0..40).map(|i| vec![i as u8]).collect();
        let (vectors, model) = embed_images(&images, &server.url, 64).unwrap();
        assert_eq!((vectors.len(), model.as_str()), (40, "m"));
        let sizes: Vec<usize> = server
            .seen()
            .iter()
            .map(|s| String::from_utf8_lossy(&s.body).matches("name=\"images\"").count())
            .collect();
        assert_eq!(sizes, vec![32, 8]);
        assert!(String::from_utf8_lossy(&server.seen()[1].body).contains("filename=\"32.bin\""));
        assert_eq!(embed_images(&[], &server.url, 8).unwrap(), (vec![], String::new()));
        server.route("/embed/image", 500, "");
        assert!(embed_images(&images[..1], &server.url, 8).is_err());
        server.route("/embed/image", 200, r#"{"embeddings": []}"#);
        assert!(
            embed_images(&images[..1], &server.url, 8)
                .unwrap_err()
                .to_string()
                .contains("malformed")
        );
        assert!(parse_embed_response(&json!({"model": "m", "embeddings": [["x"]]})).is_err());
        assert!(parse_embed_response(&json!({"model": "m", "embeddings": [1]})).is_err());
    }

    #[test]
    fn decisions() {
        assert!(is_candidate(".jpg") && is_candidate(".cr2") && !is_candidate(".pdf") && !is_candidate(".mp4"));
        assert!(is_rebuild_candidate(".png", "a/b.png", "a") && !is_rebuild_candidate(".png", "ab/b.png", "a"));
        assert!(needs_embedding(None, "m") && needs_embedding(Some("old"), "m") && !needs_embedding(Some("m"), "m"));
        assert!(rebuild_needs_embedding(None, "m", false));
        assert!(!rebuild_needs_embedding(Some("old"), "m", false));
        assert!(rebuild_needs_embedding(Some("old"), "m", true));
        assert!(!rebuild_needs_embedding(Some("m"), "m", true));
    }
}
