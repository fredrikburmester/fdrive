//! The API's feature document and the fail-closed rules for following it.
//!
//! The owner switches optional processing on and off in the app. The API
//! publishes that as one small document, and this server only keeps a unit
//! running while a current document says its feature is on. Losing the
//! document stops every unit, so an API outage cannot leave optional
//! processing running against the owner's wishes.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::{Duration, Instant};

use serde_json::Value;

/// Every key the API's feature document carries. All must be present and
/// boolean, including the ones this server does not act on.
pub const FEATURE_KEYS: [&str; 6] = [
    "thumbnails",
    "textSearch",
    "searchOcr",
    "semanticSearch",
    "imageSearch",
    "pdfOcr",
];

pub const WORKER_TOKEN_HEADER: &str = "x-fdrive-worker-token";
pub const UNAVAILABLE: &str = "feature document unavailable";
pub const UNREACHABLE: &str = "feature endpoint unreachable";

const MAX_DOCUMENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeatureSnapshot {
    pub revision: u64,
    values: BTreeMap<&'static str, bool>,
}

impl FeatureSnapshot {
    pub fn enabled(&self, feature: &str) -> bool {
        self.values.get(feature).copied().unwrap_or(false)
    }

    #[cfg(test)]
    pub fn for_test(revision: u64, enabled: &[&str]) -> Self {
        let values = FEATURE_KEYS.iter().map(|key| (*key, enabled.contains(key))).collect();
        Self { revision, values }
    }
}

/// Validates the worker contract strictly; callers fail closed on an error.
pub fn parse_feature_snapshot(body: &Value) -> Result<FeatureSnapshot, String> {
    if body.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("feature document must have version 1".into());
    }
    let revision = body
        .get("revision")
        .and_then(Value::as_u64)
        .ok_or("feature document revision must be a non-negative integer")?;
    let values = body
        .get("values")
        .and_then(Value::as_object)
        .ok_or("feature document values must be an object")?;
    let mut parsed = BTreeMap::new();
    for key in FEATURE_KEYS {
        let value = values
            .get(key)
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("feature document {key} must be boolean"))?;
        parsed.insert(key, value);
    }
    Ok(FeatureSnapshot {
        revision,
        values: parsed,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchError {
    /// The endpoint could not be reached at all.
    Unreachable(String),
    /// The endpoint answered with something the contract rejects.
    Invalid(String),
}

pub trait FeatureSource: Send + Sync {
    fn fetch(&self) -> impl Future<Output = Result<FeatureSnapshot, FetchError>> + Send;
}

/// Reads the feature document from the API's internal endpoint.
pub struct HttpFeatureSource {
    client: reqwest::Client,
    url: String,
    token: String,
}

impl HttpFeatureSource {
    pub fn new(url: String, token: String) -> Result<Self, reqwest::Error> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()?;
        Ok(Self { client, url, token })
    }
}

impl FeatureSource for HttpFeatureSource {
    async fn fetch(&self) -> Result<FeatureSnapshot, FetchError> {
        if self.token.is_empty() {
            return Err(FetchError::Invalid("FDRIVE_WORKER_TOKEN is required".into()));
        }
        let mut response = self
            .client
            .get(&self.url)
            .header(WORKER_TOKEN_HEADER, &self.token)
            .send()
            .await
            .map_err(|error| FetchError::Unreachable(describe(&error)))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(FetchError::Invalid(format!(
                "feature endpoint returned {}",
                response.status().as_u16()
            )));
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| FetchError::Unreachable(describe(&error)))?
        {
            if raw.len() + chunk.len() > MAX_DOCUMENT_BYTES {
                return Err(FetchError::Invalid("feature endpoint response is too large".into()));
            }
            raw.extend_from_slice(&chunk);
        }
        let body: Value =
            serde_json::from_slice(&raw).map_err(|_| FetchError::Invalid("feature document is not JSON".into()))?;
        parse_feature_snapshot(&body).map_err(FetchError::Invalid)
    }
}

/// The kind of failure without the URL, which can carry nothing secret but
/// is noise in a log line that already names the endpoint.
fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timeout".into()
    } else if error.is_connect() {
        "connection failed".into()
    } else {
        "request failed".into()
    }
}

/// What the units should do after one poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Apply(FeatureSnapshot),
    /// A failed poll inside its grace window: keep the current state.
    Hold,
    FailClosed(&'static str),
}

/// Turns poll results into verdicts with two grace windows.
///
/// A document that arrives and violates the contract is a real signal and
/// fails closed after the short `stale` window. A poll that never completed
/// usually means a busy host, and stopping a healthy model for that reloads
/// it, which makes the host busier and fails the next poll; so that case gets
/// the longer `unreachable` window. Both still fail closed.
pub struct Gate {
    stale: Duration,
    unreachable: Duration,
    last_good: Option<Instant>,
}

impl Gate {
    pub fn new(stale: Duration, unreachable: Duration) -> Self {
        Self {
            stale,
            unreachable,
            last_good: None,
        }
    }

    pub fn observe(&mut self, result: Result<FeatureSnapshot, FetchError>, now: Instant) -> Verdict {
        let (window, reason) = match result {
            Ok(snapshot) => {
                self.last_good = Some(now);
                return Verdict::Apply(snapshot);
            }
            Err(FetchError::Unreachable(_)) => (self.unreachable, UNREACHABLE),
            Err(FetchError::Invalid(_)) => (self.stale, UNAVAILABLE),
        };
        match self.last_good {
            Some(at) if now.duration_since(at) < window => Verdict::Hold,
            _ => Verdict::FailClosed(reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn document() -> Value {
        json!({
            "version": 1,
            "revision": 7,
            "values": {
                "thumbnails": true,
                "textSearch": true,
                "searchOcr": false,
                "semanticSearch": true,
                "imageSearch": false,
                "pdfOcr": false
            }
        })
    }

    #[test]
    fn parses_a_valid_document() {
        let snapshot = parse_feature_snapshot(&document()).unwrap();
        assert_eq!(snapshot.revision, 7);
        assert!(snapshot.enabled("semanticSearch"));
        assert!(!snapshot.enabled("imageSearch"));
        assert!(!snapshot.enabled("notAFeature"));
    }

    #[test]
    fn rejects_documents_outside_the_contract() {
        let cases: [(&str, Value); 7] = [
            ("version", json!(2)),
            ("version", json!(true)),
            ("revision", json!(-1)),
            ("revision", json!(true)),
            ("revision", json!("7")),
            ("values", json!([])),
            ("values", json!({ "thumbnails": true })),
        ];
        for (field, value) in cases {
            let mut body = document();
            body[field] = value;
            assert!(parse_feature_snapshot(&body).is_err(), "{field} should be rejected");
        }
        let mut body = document();
        body["values"]["pdfOcr"] = json!("yes");
        assert_eq!(
            parse_feature_snapshot(&body).unwrap_err(),
            "feature document pdfOcr must be boolean"
        );
        assert!(parse_feature_snapshot(&json!("nope")).is_err());
    }

    async fn api() -> String {
        use axum::http::{HeaderMap, StatusCode, header};
        use axum::response::IntoResponse;
        use axum::routing::get;

        let features = |headers: HeaderMap| async move {
            if headers.get(WORKER_TOKEN_HEADER).and_then(|value| value.to_str().ok()) != Some("secret") {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            axum::Json(document()).into_response()
        };
        let app = axum::Router::new()
            .route("/features", get(features))
            .route("/large", get(|| async { "x".repeat(MAX_DOCUMENT_BYTES + 1) }))
            .route("/text", get(|| async { "not json" }))
            .route("/contract", get(|| async { axum::Json(json!({ "version": 2 })) }))
            .route(
                "/moved",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/features")]) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    async fn fetch(url: String, token: &str) -> Result<FeatureSnapshot, FetchError> {
        HttpFeatureSource::new(url, token.into()).unwrap().fetch().await
    }

    #[tokio::test]
    async fn fetches_the_document_with_the_worker_token() {
        let base = api().await;
        let snapshot = fetch(format!("{base}/features"), "secret").await.unwrap();
        assert_eq!(snapshot.revision, 7);
        assert!(snapshot.enabled("textSearch"));
    }

    #[tokio::test]
    async fn every_bad_answer_is_invalid_rather_than_unreachable() {
        let base = api().await;
        let invalid = |detail: &str| Err(FetchError::Invalid(detail.into()));
        assert_eq!(
            fetch(format!("{base}/features"), "wrong").await,
            invalid("feature endpoint returned 401")
        );
        assert_eq!(
            fetch(format!("{base}/features"), "").await,
            invalid("FDRIVE_WORKER_TOKEN is required")
        );
        assert_eq!(
            fetch(format!("{base}/large"), "secret").await,
            invalid("feature endpoint response is too large")
        );
        assert_eq!(
            fetch(format!("{base}/text"), "secret").await,
            invalid("feature document is not JSON")
        );
        assert_eq!(
            fetch(format!("{base}/contract"), "secret").await,
            invalid("feature document must have version 1")
        );
        // A redirect is never followed: the token must not travel to another host.
        assert_eq!(
            fetch(format!("{base}/moved"), "secret").await,
            invalid("feature endpoint returned 302")
        );
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable() {
        let result = fetch("http://127.0.0.1:1/features".into(), "secret").await;
        assert_eq!(result, Err(FetchError::Unreachable("connection failed".into())));
    }

    fn snapshot() -> FeatureSnapshot {
        FeatureSnapshot::for_test(1, &["semanticSearch"])
    }

    #[test]
    fn a_first_failed_poll_fails_closed_immediately() {
        let now = Instant::now();
        let mut gate = Gate::new(Duration::from_secs(9), Duration::from_secs(60));
        assert_eq!(
            gate.observe(Err(FetchError::Unreachable("x".into())), now),
            Verdict::FailClosed(UNREACHABLE)
        );
        assert_eq!(
            gate.observe(Err(FetchError::Invalid("x".into())), now),
            Verdict::FailClosed(UNAVAILABLE)
        );
    }

    #[test]
    fn an_invalid_document_holds_only_for_the_stale_window() {
        let start = Instant::now();
        let mut gate = Gate::new(Duration::from_secs(9), Duration::from_secs(60));
        assert_eq!(gate.observe(Ok(snapshot()), start), Verdict::Apply(snapshot()));
        let invalid = || Err(FetchError::Invalid("x".into()));
        assert_eq!(gate.observe(invalid(), start + Duration::from_secs(8)), Verdict::Hold);
        assert_eq!(
            gate.observe(invalid(), start + Duration::from_secs(9)),
            Verdict::FailClosed(UNAVAILABLE)
        );
    }

    #[test]
    fn an_unreachable_endpoint_holds_for_the_longer_window() {
        let start = Instant::now();
        let mut gate = Gate::new(Duration::from_secs(9), Duration::from_secs(60));
        gate.observe(Ok(snapshot()), start);
        let unreachable = || Err(FetchError::Unreachable("x".into()));
        assert_eq!(
            gate.observe(unreachable(), start + Duration::from_secs(59)),
            Verdict::Hold
        );
        assert_eq!(
            gate.observe(unreachable(), start + Duration::from_secs(60)),
            Verdict::FailClosed(UNREACHABLE)
        );
        // A good poll restarts both windows.
        gate.observe(Ok(snapshot()), start + Duration::from_secs(61));
        assert_eq!(
            gate.observe(unreachable(), start + Duration::from_secs(100)),
            Verdict::Hold
        );
    }
}
