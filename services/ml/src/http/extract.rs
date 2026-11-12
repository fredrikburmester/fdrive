//! `/extract`: the one Tika endpoint the indexer calls, `PUT /tika`.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use fdrive_ml_extract::extract;

use super::{AppState, not_loaded};

const NOT_ENABLED: &str = "text extraction is not enabled";

pub fn routes(max_document_bytes: usize) -> Router<AppState> {
    Router::new()
        .route("/tika", put(tika).layer(DefaultBodyLimit::max(max_document_bytes)))
        .route("/version", get(version))
}

fn text(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

/// A bare 200 is how the API probes this unit when it has no runtime URL.
async fn version(State(state): State<AppState>) -> Response {
    match state.units.extract.resource() {
        Some(()) => text(StatusCode::OK, concat!("fdrive-ml ", env!("CARGO_PKG_VERSION")).into()),
        None => not_loaded(NOT_ENABLED),
    }
}

/// The document's text, or 422 for one this server cannot read. The indexer
/// records 422 as an unsupported file rather than a failure to retry.
async fn tika(State(state): State<AppState>, body: Bytes) -> Response {
    if state.units.extract.resource().is_none() {
        return not_loaded(NOT_ENABLED);
    }
    let Ok(_permit) = state.extract_permits.acquire().await else {
        return not_loaded(NOT_ENABLED);
    };
    let limits = std::sync::Arc::clone(&state.extract_limits);
    match tokio::task::spawn_blocking(move || extract(&body, &limits)).await {
        Ok(Ok(extracted)) => text(StatusCode::OK, extracted.text),
        Ok(Err(unreadable)) => text(StatusCode::UNPROCESSABLE_ENTITY, unreadable.to_string()),
        Err(_) => {
            tracing::error!("document extraction panicked");
            text(StatusCode::INTERNAL_SERVER_ERROR, "extraction failed".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};

    use crate::http::test_support::{app, get, send};
    use crate::lifecycle::UnitKind;

    fn put(body: Vec<u8>) -> Request<Body> {
        Request::put("/extract/tika")
            .header("accept", "text/plain")
            .body(Body::from(body))
            .unwrap()
    }

    const RTF: &[u8] = br"{\rtf1\ansi Hello from fdrive\par second line}";

    #[tokio::test]
    async fn everything_is_unavailable_while_the_unit_is_off() {
        let (app, _) = app(&[]);
        assert_eq!(get(&app, "/extract/version").await.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(send(&app, put(RTF.to_vec())).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn version_answers_once_enabled() {
        let (app, _) = app(&[UnitKind::Extract]);
        let (status, body) = get(&app, "/extract/version").await;
        assert_eq!(status, StatusCode::OK);
        assert!(String::from_utf8(body).unwrap().starts_with("fdrive-ml "));
    }

    #[tokio::test]
    async fn returns_a_documents_text() {
        let (app, _) = app(&[UnitKind::Extract]);
        let (status, body) = send(&app, put(RTF.to_vec())).await;
        assert_eq!(status, StatusCode::OK);
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains("Hello from fdrive"), "{text}");
        assert!(text.contains("second line"), "{text}");
    }

    #[tokio::test]
    async fn an_unreadable_document_is_unprocessable() {
        let (app, _) = app(&[UnitKind::Extract]);
        let (status, body) = send(&app, put(b"just some bytes".to_vec())).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            String::from_utf8(body)
                .unwrap()
                .starts_with("unsupported document type")
        );
    }

    #[tokio::test]
    async fn a_document_over_the_size_limit_is_refused() {
        let (app, _) = app(&[UnitKind::Extract]);
        let (status, _) = send(&app, put(vec![b'a'; 1024 * 1024 + 1])).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }
}
