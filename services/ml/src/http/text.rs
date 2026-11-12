//! `/text`: the subset of text-embeddings-inference fdrive calls.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use super::AppState;
use crate::text::{EmbedRequest, MAX_CLIENT_BATCH_SIZE, RequestError, TextEmbedError};
use crate::vector::l2_normalize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/embed", post(embed))
        .route("/health", get(health))
        .route("/info", get(info))
}

/// TEI's error body: a message plus a coarse type, with TEI's status codes.
fn error(status: StatusCode, error_type: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": message.into(), "error_type": error_type })),
    )
        .into_response()
}

fn unhealthy() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "Unhealthy", "model is not loaded")
}

/// 200 with an empty body once the model is loaded, which is all callers check.
async fn health(State(state): State<AppState>) -> Response {
    match state.units.text.resource() {
        Some(_) => StatusCode::OK.into_response(),
        None => unhealthy(),
    }
}

async fn info(State(state): State<AppState>) -> Response {
    let Some(embedder) = state.units.text.resource() else {
        return unhealthy();
    };
    Json(json!({
        "model_id": embedder.model_id(),
        "max_input_length": embedder.max_input_length(),
        "max_client_batch_size": MAX_CLIENT_BATCH_SIZE,
    }))
    .into_response()
}

async fn embed(State(state): State<AppState>, Json(request): Json<EmbedRequest>) -> Response {
    let Some(embedder) = state.units.text.resource() else {
        return unhealthy();
    };
    let (truncate, normalize) = (request.truncate, request.normalize);
    let inputs = match request.into_inputs() {
        Ok(inputs) => inputs,
        Err(RequestError::Empty) => {
            return error(
                StatusCode::BAD_REQUEST,
                "Empty",
                "Input validation error: `inputs` cannot be empty",
            );
        }
        Err(RequestError::BatchTooLarge(given)) => {
            let message = format!("batch size {given} > maximum allowed batch size {MAX_CLIENT_BATCH_SIZE}");
            return error(StatusCode::UNPROCESSABLE_ENTITY, "Validation", message);
        }
    };
    let embedded = tokio::task::spawn_blocking(move || embedder.embed(&inputs, truncate)).await;
    match embedded {
        Ok(Ok(mut vectors)) => {
            if normalize {
                vectors.iter_mut().for_each(|vector| l2_normalize(vector));
            }
            Json(vectors).into_response()
        }
        Ok(Err(too_long @ TextEmbedError::TooLong { .. })) => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Validation",
            format!("Input validation error: {too_long}"),
        ),
        Ok(Err(TextEmbedError::Backend(detail))) => {
            tracing::error!("text embedding failed: {detail}");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Backend", "inference failed")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Backend", "inference failed"),
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::json;

    use crate::http::test_support::{app, get, json as parse, post_json};
    use crate::lifecycle::UnitKind;

    #[tokio::test]
    async fn everything_is_unavailable_while_the_unit_is_off() {
        let (app, _) = app(&[]);
        assert_eq!(get(&app, "/text/health").await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(get(&app, "/text/info").await.0, StatusCode::SERVICE_UNAVAILABLE);
        let (status, body) = post_json(&app, "/text/embed", r#"{"inputs":["a"]}"#).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            json!({ "error": "model is not loaded", "error_type": "Unhealthy" })
        );
    }

    #[tokio::test]
    async fn health_and_info_describe_the_loaded_model() {
        let (app, _) = app(&[UnitKind::Text]);
        let (status, body) = get(&app, "/text/health").await;
        assert_eq!((status, body.len()), (StatusCode::OK, 0));
        let (status, body) = get(&app, "/text/info").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            parse(&body),
            json!({ "model_id": "fake/text", "max_input_length": 8, "max_client_batch_size": 32 })
        );
    }

    #[tokio::test]
    async fn embeds_a_batch_in_order_and_normalizes_by_default() {
        let (app, _) = app(&[UnitKind::Text]);
        let (status, body) = post_json(&app, "/text/embed", r#"{"inputs":["ab","abcd"]}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!([[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]));

        let (_, body) = post_json(&app, "/text/embed", r#"{"inputs":["ab","abcd"],"normalize":false}"#).await;
        assert_eq!(body, json!([[2.0, 0.0, 0.0], [4.0, 0.0, 0.0]]));

        let (_, body) = post_json(&app, "/text/embed", r#"{"inputs":"abc","normalize":false}"#).await;
        assert_eq!(body, json!([[3.0, 0.0, 0.0]]));
    }

    #[tokio::test]
    async fn a_long_input_is_cut_only_when_asked() {
        let (app, _) = app(&[UnitKind::Text]);
        let long = r#"{"inputs":["0123456789"],"normalize":false"#;
        let (status, body) = post_json(&app, "/text/embed", &format!("{long}}}")).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body["error"],
            "Input validation error: `inputs` must have less than 8 tokens. Given: 10"
        );
        assert_eq!(body["error_type"], "Validation");

        let (status, body) = post_json(&app, "/text/embed", &format!("{long},\"truncate\":true}}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!([[8.0, 0.0, 0.0]]));
    }

    #[tokio::test]
    async fn rejects_requests_outside_the_contract() {
        let (app, _) = app(&[UnitKind::Text]);
        let (status, body) = post_json(&app, "/text/embed", r#"{"inputs":[]}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body,
            json!({ "error": "Input validation error: `inputs` cannot be empty", "error_type": "Empty" })
        );

        let many = serde_json::to_string(&vec!["a"; 33]).unwrap();
        let (status, body) = post_json(&app, "/text/embed", &format!(r#"{{"inputs":{many}}}"#)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"], "batch size 33 > maximum allowed batch size 32");

        assert_eq!(
            post_json(&app, "/text/embed", r#"{"inputs":[1]}"#).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            post_json(&app, "/text/embed", "not json").await.0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn a_backend_failure_is_a_500_without_details() {
        let (app, _) = app(&[UnitKind::Text]);
        let (status, body) = post_json(&app, "/text/embed", r#"{"inputs":["boom"]}"#).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, json!({ "error": "inference failed", "error_type": "Backend" }));
    }
}
