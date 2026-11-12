//! `/image`: the image-embed service's contract.

use axum::body::Bytes;
use axum::extract::multipart::{Field, Multipart};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::{AppState, not_loaded};
use crate::hub::IMAGE_MODEL;
use crate::image::{
    ImageEmbedError, ImageEmbedder, MAX_IMAGE_BYTES, MAX_IMAGES, RequestError, parse_text_inputs, validate_images,
};
use crate::lifecycle::Status;
use crate::vector::l2_normalize;

const MODEL_NOT_LOADED: &str = "model is not loaded yet";
/// Every image at its largest, plus room for the multipart framing.
const MAX_BODY_BYTES: usize = MAX_IMAGES * MAX_IMAGE_BYTES + 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route(
            "/embed/image",
            post(embed_image).layer(DefaultBodyLimit::max(MAX_BODY_BYTES)),
        )
        .route("/embed/text", post(embed_text))
}

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

impl IntoResponse for RequestError {
    fn into_response(self) -> Response {
        error(
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::BAD_REQUEST),
            self.message,
        )
    }
}

/// `"ok"` once loaded and `"loading"` while it loads, both 200, as the
/// indexer's dimension guard expects. A unit that is off or failed is 503.
async fn health(State(state): State<AppState>) -> Response {
    let unit = &state.units.image;
    if let Some(embedder) = unit.resource() {
        let body = json!({ "status": "ok", "model": embedder.model_id(), "dim": embedder.dim(), "device": "cpu" });
        return Json(body).into_response();
    }
    if unit.status().status == Status::Preparing {
        let body = json!({ "status": "loading", "model": IMAGE_MODEL.id, "dim": null, "device": "cpu" });
        return Json(body).into_response();
    }
    not_loaded(MODEL_NOT_LOADED)
}

fn respond(embedder: &dyn ImageEmbedder, result: Result<Vec<Vec<f32>>, ImageEmbedError>) -> Response {
    match result {
        Ok(mut vectors) => {
            vectors.iter_mut().for_each(|vector| l2_normalize(vector));
            Json(json!({ "model": embedder.model_id(), "dim": embedder.dim(), "embeddings": vectors })).into_response()
        }
        Err(decode @ ImageEmbedError::Decode(_)) => error(StatusCode::BAD_REQUEST, decode.to_string()),
        Err(ImageEmbedError::Backend(detail)) => {
            tracing::error!("image embedding failed: {detail}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "inference failed")
        }
    }
}

/// Reads one part without ever holding more than the per-image bound.
async fn read_image(mut field: Field<'_>) -> Result<Vec<u8>, RequestError> {
    if field.file_name().is_none() {
        return Err(RequestError::new(400, "'images' parts must be file uploads"));
    }
    let mut data = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|_| RequestError::new(400, "malformed multipart body"))?
    {
        if data.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err(RequestError::new(
                413,
                format!("an image part exceeds {MAX_IMAGE_BYTES} bytes"),
            ));
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}

async fn read_images(mut multipart: Multipart) -> Result<Vec<Vec<u8>>, RequestError> {
    let mut images = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| RequestError::new(400, "malformed multipart body"))?
    {
        if field.name() != Some("images") {
            continue;
        }
        if images.len() == MAX_IMAGES {
            return Err(RequestError::new(
                413,
                format!("at most {MAX_IMAGES} images per request"),
            ));
        }
        images.push(read_image(field).await?);
    }
    validate_images(&images)?;
    Ok(images)
}

async fn embed_image(State(state): State<AppState>, multipart: Multipart) -> Response {
    let Some(embedder) = state.units.image.resource() else {
        return not_loaded(MODEL_NOT_LOADED);
    };
    let images = match read_images(multipart).await {
        Ok(images) => images,
        Err(rejected) => return rejected.into_response(),
    };
    let worker = std::sync::Arc::clone(&embedder);
    match tokio::task::spawn_blocking(move || worker.embed_images(&images)).await {
        Ok(result) => respond(embedder.as_ref(), result),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "inference failed"),
    }
}

async fn embed_text(State(state): State<AppState>, body: Bytes) -> Response {
    let Some(embedder) = state.units.image.resource() else {
        return not_loaded(MODEL_NOT_LOADED);
    };
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "request body must be JSON");
    };
    let texts = match parse_text_inputs(&body) {
        Ok(texts) => texts,
        Err(rejected) => return rejected.into_response(),
    };
    let worker = std::sync::Arc::clone(&embedder);
    match tokio::task::spawn_blocking(move || worker.embed_texts(&texts)).await {
        Ok(result) => respond(embedder.as_ref(), result),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "inference failed"),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::{Value, json};

    use crate::http::test_support::{app, get, json as parse, post_json, send};
    use crate::http::{AppState, router};
    use crate::image::test_support::png;
    use crate::image::{ImageEmbedder, MAX_IMAGE_BYTES, MAX_IMAGES};
    use crate::lifecycle::test_support::ManualSpawner;
    use crate::lifecycle::{Unit, UnitKind, Units, inline_spawner};

    const BOUNDARY: &str = "fdrive-boundary";

    /// A multipart body of `(field name, file name, bytes)` parts.
    fn multipart(parts: &[(&str, Option<&str>, &[u8])]) -> Request<Body> {
        let mut body = Vec::new();
        for (name, file_name, data) in parts {
            body.extend_from_slice(
                format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"").as_bytes(),
            );
            if let Some(file_name) = file_name {
                body.extend_from_slice(format!("; filename=\"{file_name}\"").as_bytes());
            }
            body.extend_from_slice(b"\r\nContent-Type: application/octet-stream\r\n\r\n");
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        Request::post("/image/embed/image")
            .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
            .body(Body::from(body))
            .unwrap()
    }

    async fn post_images(app: &Router, parts: &[(&str, Option<&str>, &[u8])]) -> (StatusCode, Value) {
        let (status, bytes) = send(app, multipart(parts)).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn everything_is_unavailable_while_the_unit_is_off() {
        let (app, _) = app(&[]);
        assert_eq!(get(&app, "/image/health").await.0, StatusCode::SERVICE_UNAVAILABLE);
        let (status, body) = send(&app, multipart(&[("images", Some("0.bin"), &png(1, 1, [0, 0, 0]))])).await;
        assert_eq!(
            (status, body.as_slice()),
            (StatusCode::SERVICE_UNAVAILABLE, b"model is not loaded yet".as_slice())
        );
        assert_eq!(
            post_json(&app, "/image/embed/text", r#"{"inputs":["a"]}"#).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn health_reports_loading_and_then_the_loaded_model() {
        let spawner = ManualSpawner::default();
        let units = crate::http::test_support::units();
        let units = Arc::new(Units {
            text: Arc::clone(&units.text),
            image: Unit::new(
                UnitKind::Image,
                Arc::new(|| Ok(Arc::new(crate::http::test_support::FakeImage) as Arc<dyn ImageEmbedder>)),
                spawner.spawner(),
            ),
            extract: Unit::new(UnitKind::Extract, Arc::new(|| Ok(())), inline_spawner()),
        });
        let app = router(AppState::new(Arc::clone(&units), 1, 1024));
        units.enable(UnitKind::Image, Some(1), Instant::now());

        let (status, body) = get(&app, "/image/health").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            parse(&body),
            json!({ "status": "loading", "model": "google/siglip2-large-patch16-256", "dim": null, "device": "cpu" })
        );

        spawner.run_all();
        let (_, body) = get(&app, "/image/health").await;
        assert_eq!(
            parse(&body),
            json!({ "status": "ok", "model": "fake/image", "dim": 2, "device": "cpu" })
        );
    }

    #[tokio::test]
    async fn embeds_images_in_order_and_normalizes() {
        let (app, _) = app(&[UnitKind::Image]);
        let (wide, tall) = (png(3, 4, [1, 2, 3]), png(4, 3, [1, 2, 3]));
        let parts = [
            ("images", Some("0.bin"), wide.as_slice()),
            ("other", None, b"ignored".as_slice()),
            ("images", Some("1.bin"), tall.as_slice()),
        ];
        let (status, body) = post_images(&app, &parts).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["model"], "fake/image");
        assert_eq!(body["dim"], 2);
        let embeddings = body["embeddings"].as_array().unwrap();
        assert_eq!(embeddings.len(), 2);
        assert!((embeddings[0][0].as_f64().unwrap() - 0.6).abs() < 1e-6);
        assert!((embeddings[0][1].as_f64().unwrap() - 0.8).abs() < 1e-6);
        assert!((embeddings[1][0].as_f64().unwrap() - 0.8).abs() < 1e-6);
    }

    #[tokio::test]
    async fn rejects_image_requests_outside_the_contract() {
        let (app, _) = app(&[UnitKind::Image]);
        let image = png(1, 1, [0, 0, 0]);

        let (status, body) = post_images(&app, &[]).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "at least one image is required" })
            )
        );

        let (status, body) = post_images(&app, &[("images", None, image.as_slice())]).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "'images' parts must be file uploads" })
            )
        );

        let too_many = vec![("images", Some("x.bin"), image.as_slice()); MAX_IMAGES + 1];
        let (status, body) = post_images(&app, &too_many).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "error": "at most 32 images per request" })
            )
        );

        let huge = vec![0u8; MAX_IMAGE_BYTES + 1];
        let (status, body) = post_images(&app, &[("images", Some("x.bin"), huge.as_slice())]).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body, json!({ "error": "an image part exceeds 8388608 bytes" }));

        let (status, body) = post_images(&app, &[("images", Some("x.bin"), b"not an image".as_slice())]).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().starts_with("undecodable image: "));

        let not_multipart = Request::post("/image/embed/image").body(Body::from("plain")).unwrap();
        assert_eq!(send(&app, not_multipart).await.0, StatusCode::BAD_REQUEST);

        let cut_short = Request::post("/image/embed/image")
            .header("content-type", format!("multipart/form-data; boundary={BOUNDARY}"))
            .body(Body::from(format!(
                "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"images\"; filename=\"a\"\r\n\r\nabc"
            )))
            .unwrap();
        let (status, body) = send(&app, cut_short).await;
        assert_eq!(
            (status, parse(&body)),
            (StatusCode::BAD_REQUEST, json!({ "error": "malformed multipart body" }))
        );
    }

    #[tokio::test]
    async fn embeds_text_queries() {
        let (app, _) = app(&[UnitKind::Image]);
        let (status, body) = post_json(&app, "/image/embed/text", r#"{"inputs":["blue chair","dog"]}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({ "model": "fake/image", "dim": 2, "embeddings": [[0.0, 1.0], [0.0, 1.0]] })
        );
    }

    #[tokio::test]
    async fn rejects_text_requests_outside_the_contract() {
        let (app, _) = app(&[UnitKind::Image]);
        let (status, body) = post_json(&app, "/image/embed/text", "nope").await;
        assert_eq!(
            (status, body),
            (StatusCode::BAD_REQUEST, json!({ "error": "request body must be JSON" }))
        );
        let (status, body) = post_json(&app, "/image/embed/text", r#"{"inputs":"x"}"#).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "'inputs' must be a list of strings" })
            )
        );
        let (status, _) = post_json(
            &app,
            "/image/embed/text",
            &format!(r#"{{"inputs":["{}"]}}"#, "x".repeat(513)),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn a_backend_failure_is_a_500_without_details() {
        let (app, _) = app(&[UnitKind::Image]);
        let (status, body) = post_json(&app, "/image/embed/text", r#"{"inputs":["boom"]}"#).await;
        assert_eq!(
            (status, body),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "inference failed" })
            )
        );
    }
}
