//! The HTTP API. Each unit lives under its own prefix and keeps the
//! contract of the service it replaces, so a caller's base URL is the only
//! thing that changes: `/text` was TEI, `/image` the Python image-embed
//! service, `/extract` Apache Tika. Not authenticated: reachable only from
//! other containers on the compose network.

mod extract;
mod image;
mod text;

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use fdrive_ml_extract::Limits;
use serde_json::json;
use tokio::sync::Semaphore;

use crate::lifecycle::{UnitKind, Units};

#[derive(Clone)]
pub struct AppState {
    pub units: Arc<Units>,
    pub extract_limits: Arc<Limits>,
    /// Bounds how many documents are parsed at once.
    pub extract_permits: Arc<Semaphore>,
    pub max_document_bytes: usize,
}

impl AppState {
    pub fn new(units: Arc<Units>, threads: usize, max_document_bytes: usize) -> Self {
        Self {
            units,
            extract_limits: Arc::new(Limits::default()),
            extract_permits: Arc::new(Semaphore::new(threads.max(1))),
            max_document_bytes,
        }
    }
}

pub fn router(state: AppState) -> Router {
    let max_document_bytes = state.max_document_bytes;
    Router::new()
        .route("/health", get(health))
        .route("/runtime", get(runtime))
        .nest("/text", text::routes().merge(unit_runtime(UnitKind::Text)))
        .nest("/image", image::routes().merge(unit_runtime(UnitKind::Image)))
        .nest(
            "/extract",
            extract::routes(max_document_bytes).merge(unit_runtime(UnitKind::Extract)),
        )
        .with_state(state)
}

/// Liveness of the process itself, whatever the units are doing.
async fn health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

/// Every unit's status in one document.
async fn runtime(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut units = serde_json::Map::new();
    for kind in UnitKind::ALL {
        units.insert(kind.name().into(), json!(state.units.status(kind)));
    }
    Json(serde_json::Value::Object(units))
}

/// `GET /<unit>/runtime`: the status document the API polls per feature.
fn unit_runtime(kind: UnitKind) -> Router<AppState> {
    Router::new().route(
        "/runtime",
        get(move |State(state): State<AppState>| async move { Json(state.units.status(kind)) }),
    )
}

/// A unit that is off, loading or failed answers every work request with this.
fn not_loaded(message: &'static str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, message).into_response()
}

#[cfg(test)]
pub mod test_support {
    use std::sync::Arc;
    use std::time::Instant;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::{AppState, router};
    use crate::image::{ImageEmbedError, ImageEmbedder, decode_rgb};
    use crate::lifecycle::{Unit, UnitKind, Units, inline_spawner};
    use crate::text::{TextEmbedError, TextEmbedder};

    pub struct FakeText;

    impl TextEmbedder for FakeText {
        fn model_id(&self) -> &str {
            "fake/text"
        }

        fn max_input_length(&self) -> usize {
            8
        }

        /// `[characters, 0, 0]`, so a test can tell inputs and order apart.
        fn embed(&self, inputs: &[String], truncate: bool) -> Result<Vec<Vec<f32>>, TextEmbedError> {
            inputs
                .iter()
                .map(|input| match input.chars().count() {
                    _ if input == "boom" => Err(TextEmbedError::Backend("inference failed".into())),
                    given if given > 8 && !truncate => Err(TextEmbedError::TooLong { given, max: 8 }),
                    given => Ok(vec![given.min(8) as f32, 0.0, 0.0]),
                })
                .collect()
        }
    }

    pub struct FakeImage;

    impl ImageEmbedder for FakeImage {
        fn model_id(&self) -> &str {
            "fake/image"
        }

        fn dim(&self) -> usize {
            2
        }

        /// `[width, height]` of the decoded image.
        fn embed_images(&self, images: &[Vec<u8>]) -> Result<Vec<Vec<f32>>, ImageEmbedError> {
            images
                .iter()
                .map(|raw| decode_rgb(raw).map(|image| vec![image.width() as f32, image.height() as f32]))
                .collect()
        }

        fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ImageEmbedError> {
            texts
                .iter()
                .map(|text| match text.as_str() {
                    "boom" => Err(ImageEmbedError::Backend("inference failed".into())),
                    _ => Ok(vec![0.0, text.chars().count() as f32]),
                })
                .collect()
        }
    }

    /// Units backed by the fakes, all off until a test enables them.
    pub fn units() -> Arc<Units> {
        Arc::new(Units {
            text: Unit::new(
                UnitKind::Text,
                Arc::new(|| Ok(Arc::new(FakeText) as Arc<dyn TextEmbedder>)),
                inline_spawner(),
            ),
            image: Unit::new(
                UnitKind::Image,
                Arc::new(|| Ok(Arc::new(FakeImage) as Arc<dyn ImageEmbedder>)),
                inline_spawner(),
            ),
            extract: Unit::new(UnitKind::Extract, Arc::new(|| Ok(())), inline_spawner()),
        })
    }

    /// A router over fake units with `enabled` switched on.
    pub fn app(enabled: &[UnitKind]) -> (Router, Arc<Units>) {
        let units = units();
        for kind in enabled {
            units.enable(*kind, Some(1), Instant::now());
        }
        (router(AppState::new(Arc::clone(&units), 2, 1024 * 1024)), units)
    }

    pub async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Vec<u8>) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (
            status,
            response.into_body().collect().await.unwrap().to_bytes().to_vec(),
        )
    }

    pub async fn get(app: &Router, path: &str) -> (StatusCode, Vec<u8>) {
        send(app, Request::get(path).body(Body::empty()).unwrap()).await
    }

    pub async fn post_json(app: &Router, path: &str, body: &str) -> (StatusCode, serde_json::Value) {
        let request = Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(body.to_owned()))
            .unwrap();
        let (status, bytes) = send(app, request).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    pub fn json(bytes: &[u8]) -> serde_json::Value {
        serde_json::from_slice(bytes).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use super::test_support::{app, get, json as parse};
    use crate::lifecycle::UnitKind;

    #[tokio::test]
    async fn the_process_is_healthy_with_every_unit_off() {
        let (app, _) = app(&[]);
        let (status, body) = get(&app, "/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(parse(&body), json!({ "status": "ok" }));
    }

    #[tokio::test]
    async fn runtime_reports_each_unit_and_all_of_them() {
        let (app, _) = app(&[UnitKind::Extract]);
        let (_, body) = get(&app, "/extract/runtime").await;
        assert_eq!(
            parse(&body),
            json!({
                "status": "ready",
                "revision": 1,
                "features": ["searchOcr", "semanticSearch", "textSearch"],
                "attempts": 1,
                "child": true,
                "error": null
            })
        );
        let (_, body) = get(&app, "/text/runtime").await;
        assert_eq!(parse(&body)["status"], "off");
        let (_, body) = get(&app, "/image/runtime").await;
        assert_eq!(parse(&body)["features"], json!(["imageSearch"]));

        let (_, body) = get(&app, "/runtime").await;
        let all = parse(&body);
        assert_eq!(all["extract"]["status"], "ready");
        assert_eq!(all["text"]["status"], "off");
        assert_eq!(all["image"]["status"], "off");
    }

    #[tokio::test]
    async fn unknown_paths_are_not_found() {
        let (app, _) = app(&[]);
        assert_eq!(get(&app, "/embed").await.0, StatusCode::NOT_FOUND);
    }
}
