//! A fake `ml` server for integration tests: the text embedding, extraction and image
//! units the indexer calls, with switches to make each route fail or hang, and a log of
//! every request it saw.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

pub const TEXT_EMBED: &str = "/text/embed";
pub const TEXT_HEALTH: &str = "/text/health";
pub const TIKA: &str = "/extract/tika";
pub const IMAGE_HEALTH: &str = "/image/health";
pub const IMAGE_EMBED: &str = "/image/embed/image";

pub const TEXT_DIM: usize = 384;
pub const IMAGE_DIM: usize = 1024;

#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }

    /// Number of multipart `images` parts in the body.
    pub fn images(&self) -> usize {
        String::from_utf8_lossy(&self.body).matches("name=\"images\"").count()
    }
}

struct Inner {
    overrides: HashMap<String, (u16, String)>,
    seen: Vec<Seen>,
    tika_text: String,
    image_model: String,
    held: HashMap<String, tokio::sync::watch::Sender<bool>>,
}

type Shared = Arc<Mutex<Inner>>;

fn lock(shared: &Shared) -> MutexGuard<'_, Inner> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

pub struct FakeMl {
    pub url: String,
    shared: Shared,
    _runtime: tokio::runtime::Runtime,
}

/// A deterministic unit vector-ish embedding for one input.
pub fn text_vector(input: &str) -> Vec<f32> {
    let seed = input
        .bytes()
        .fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
    (0..TEXT_DIM as u32)
        .map(|i| (seed.wrapping_add(i.wrapping_mul(2_654_435_761)) % 1000) as f32 / 1000.0)
        .collect()
}

/// An address nothing listens on: connecting is refused.
pub fn closed_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{address}")
}

impl FakeMl {
    pub fn start() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let shared: Shared = Arc::new(Mutex::new(Inner {
            overrides: HashMap::new(),
            seen: Vec::new(),
            tika_text: "extracted office document text that is long enough to keep".to_owned(),
            image_model: "model-a".to_owned(),
            held: HashMap::new(),
        }));
        let app = axum::Router::new().fallback(handle).with_state(Arc::clone(&shared));
        let listener = runtime.block_on(tokio::net::TcpListener::bind("127.0.0.1:0")).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        runtime.spawn(async move { axum::serve(listener, app).await });
        Self {
            url,
            shared,
            _runtime: runtime,
        }
    }

    /// Answer `path` with `status` and an empty body.
    pub fn fail(&self, path: &str, status: u16) -> &Self {
        self.respond(path, status, "")
    }

    pub fn respond(&self, path: &str, status: u16, body: &str) -> &Self {
        lock(&self.shared)
            .overrides
            .insert(path.to_owned(), (status, body.to_owned()));
        self
    }

    /// Back to the default answer.
    pub fn reset(&self, path: &str) -> &Self {
        lock(&self.shared).overrides.remove(path);
        self
    }

    pub fn set_tika_text(&self, text: &str) {
        lock(&self.shared).tika_text = text.to_owned();
    }

    pub fn set_image_model(&self, model: &str) {
        lock(&self.shared).image_model = model.to_owned();
    }

    /// Requests to `path` wait (after being logged) until `release`.
    pub fn hold(&self, path: &str) {
        let (sender, _) = tokio::sync::watch::channel(false);
        lock(&self.shared).held.insert(path.to_owned(), sender);
    }

    pub fn release(&self, path: &str) {
        if let Some(sender) = lock(&self.shared).held.remove(path) {
            let _ = sender.send(true);
        }
    }

    pub fn seen(&self) -> Vec<Seen> {
        lock(&self.shared).seen.clone()
    }

    pub fn requests(&self, path: &str) -> Vec<Seen> {
        self.seen().into_iter().filter(|s| s.path == path).collect()
    }

    pub fn count(&self, path: &str) -> usize {
        lock(&self.shared).seen.iter().filter(|s| s.path == path).count()
    }

    pub fn clear(&self) {
        lock(&self.shared).seen.clear();
    }

    /// Wait until `path` has seen at least `n` requests.
    pub fn wait_for(&self, path: &str, n: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.count(path) >= n {
                return true;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        self.count(path) >= n
    }
}

fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn handle(State(shared): State<Shared>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body: Bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default();
    let seen = Seen {
        method: parts.method.to_string(),
        path: parts.uri.path().to_owned(),
        headers: parts
            .headers
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or_default().to_owned()))
            .collect(),
        body: body.to_vec(),
    };
    let (gate, overridden, tika_text, image_model) = {
        let mut inner = lock(&shared);
        inner.seen.push(seen.clone());
        (
            inner.held.get(&seen.path).map(tokio::sync::watch::Sender::subscribe),
            inner.overrides.get(&seen.path).cloned(),
            inner.tika_text.clone(),
            inner.image_model.clone(),
        )
    };
    if let Some(mut gate) = gate {
        let _ = gate.wait_for(|open| *open).await;
    }
    let overridden = overridden.or_else(|| lock(&shared).overrides.get(&seen.path).cloned());
    if let Some((code, body)) = overridden {
        return (status(code), body).into_response();
    }
    match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", TEXT_EMBED) => {
            let inputs: Vec<String> = seen.json()["inputs"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
                .unwrap_or_default();
            let vectors: Vec<Vec<f32>> = inputs.iter().map(|i| text_vector(i)).collect();
            axum::Json(json!(vectors)).into_response()
        }
        ("GET", TEXT_HEALTH) => StatusCode::OK.into_response(),
        ("PUT", TIKA) => (StatusCode::OK, tika_text).into_response(),
        ("GET", IMAGE_HEALTH) => {
            axum::Json(json!({"status": "ok", "model": image_model, "dim": IMAGE_DIM, "device": "cpu"})).into_response()
        }
        ("POST", IMAGE_EMBED) => {
            let vectors: Vec<Vec<f32>> = (0..seen.images())
                .map(|i| vec![0.5 + i as f32 / 100.0; IMAGE_DIM])
                .collect();
            axum::Json(json!({"model": image_model, "dim": IMAGE_DIM, "embeddings": vectors})).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
