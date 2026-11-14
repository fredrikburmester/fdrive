//! The internal HTTP API, reachable only on the compose network and not authenticated.
//! Response shapes and status codes are the ones `apps/api` parses.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::db::{self, Db};
use crate::events::iso_now;
use crate::extract::{ContentExtractor, MAX_CONTENT_BYTES, embed_health};
use crate::failures::FEATURES;
use crate::features::FeatureConfiguration;
use crate::fsx;
use crate::indexer::{RootContext, work_features};
use crate::jobs::Job;
use crate::maintenance;
use crate::names::{NameIndex, NameSearch};
use crate::paths::{ext_of, reindex_scope};

/// Wakes a root's loop early, like a set `threading.Event`.
#[derive(Default)]
pub struct Wake {
    set: Mutex<bool>,
    changed: Condvar,
}

impl Wake {
    pub fn set(&self) {
        *self.set.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    pub fn is_set(&self) -> bool {
        *self.set.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wait up to `timeout`; true when woken. Clears the flag.
    pub fn wait(&self, timeout: Duration) -> bool {
        let guard = self.set.lock().unwrap_or_else(PoisonError::into_inner);
        let (mut guard, _) = self
            .changed
            .wait_timeout_while(guard, timeout, |set| !*set)
            .unwrap_or_else(PoisonError::into_inner);
        std::mem::replace(&mut *guard, false)
    }
}

pub struct Jobs {
    pub thumbnail: Arc<Job>,
    pub index_clear: Arc<Job>,
    pub thumbnail_clear: Arc<Job>,
    pub image_rebuild: Arc<Job>,
    pub image_clear: Arc<Job>,
    pub failure_retry: Arc<Job>,
}

impl Default for Jobs {
    fn default() -> Self {
        let admission = Arc::new(AtomicBool::new(false));
        let job = || Job::new(Arc::clone(&admission));
        Self {
            thumbnail: job(),
            index_clear: job(),
            thumbnail_clear: job(),
            image_rebuild: job(),
            image_clear: job(),
            failure_retry: job(),
        }
    }
}

pub struct AppState {
    pub contexts: Vec<Arc<RootContext>>,
    /// Whether each root currently has a running watcher.
    pub watchers: Arc<Mutex<HashMap<String, bool>>>,
    pub wakes: HashMap<String, Arc<Wake>>,
    /// The handlers' connection: one connection attempt, so a missing database fails fast.
    pub db: Db,
    pub content: Option<Arc<ContentExtractor>>,
    pub jobs: Jobs,
    pub failure_retry_feature: Mutex<String>,
    pub instance_id: String,
    /// The name index `/names/search` reads; `None` answers 503.
    pub names: Option<Arc<NameIndex>>,
}

impl AppState {
    pub fn context(&self, name: &str) -> Option<&Arc<RootContext>> {
        self.contexts.iter().find(|c| c.name == name)
    }

    /// The feature selection, from the first root or straight from the database.
    pub fn features(&self) -> FeatureConfiguration {
        match self.contexts.first() {
            Some(ctx) => ctx.features(),
            None => self
                .db
                .with(db::read_settings)
                .map(|raw| crate::features::resolve(&raw))
                .unwrap_or_default(),
        }
    }
}

type Shared = Arc<AppState>;

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// An error answer in a `Result`, kept small; it becomes `{ "error": … }` with its status.
struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error(self.0, &self.1)
    }
}

fn fail(status: StatusCode, message: &str) -> ApiError {
    ApiError(status, message.to_owned())
}

fn io_status(e: &io::Error) -> StatusCode {
    match e.raw_os_error().map(rustix::io::Errno::from_raw_os_error) {
        Some(rustix::io::Errno::NOENT) => StatusCode::NOT_FOUND,
        Some(rustix::io::Errno::NOTDIR | rustix::io::Errno::LOOP) => StatusCode::BAD_REQUEST,
        Some(rustix::io::Errno::ACCESS | rustix::io::Errno::PERM) => StatusCode::FORBIDDEN,
        _ if e.kind() == io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}

async fn blocking<R: Send + 'static>(work: impl FnOnce() -> R + Send + 'static) -> Result<R, ApiError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| fail(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

/// The JSON body as an object; an empty body is `{}`.
fn object(body: &[u8]) -> Result<serde_json::Map<String, Value>, ApiError> {
    if body.is_empty() {
        return Ok(serde_json::Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(fail(StatusCode::BAD_REQUEST, "body must be an object")),
        Err(_) => Err(fail(StatusCode::BAD_REQUEST, "invalid JSON")),
    }
}

fn storage_diagnostics(contexts: &[Arc<RootContext>]) -> Value {
    use rustix::fs::{Access, access};
    let mut out = serde_json::Map::new();
    for ctx in contexts {
        let readable = std::fs::read_dir(&ctx.abs_path).is_ok_and(|mut d| {
            let _ = d.next();
            true
        }) && access(&ctx.abs_path, Access::READ_OK).is_ok();
        let writable = access(&ctx.abs_path, Access::WRITE_OK).is_ok();
        out.insert(ctx.name.clone(), json!({"readable": readable, "writable": writable}));
    }
    Value::Object(out)
}

async fn health(State(state): State<Shared>) -> Response {
    let result = blocking(move || {
        let features = state.features();
        let embed_url = state
            .contexts
            .first()
            .map(|c| c.cfg.embed_url.clone())
            .unwrap_or_default();
        // An unavailable optional embedding service must not delay setup health.
        let embed_ok = features.values.semantic_search
            && !embed_url.is_empty()
            && embed_health(&embed_url, Duration::from_secs(1));
        let version = state.db.with(db::read_schema_version)?;
        let watchers = state.watchers.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let watcher: serde_json::Map<String, Value> = state
            .contexts
            .iter()
            .map(|c| (c.name.clone(), json!(watchers.get(&c.name).copied().unwrap_or(false))))
            .collect();
        Ok::<_, anyhow::Error>(json!({
            "ok": version.is_some(),
            "roots": state.contexts.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
            "watcher": watcher,
            "embed_ok": embed_ok,
            "schema_version": version,
            "features": features.as_json(),
            "storage": storage_diagnostics(&state.contexts),
        }))
    })
    .await;
    match result {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(_)) | Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    }
}

async fn activity(State(state): State<Shared>) -> Response {
    let mut operations = Vec::new();
    for ctx in &state.contexts {
        let values = ctx.values();
        for mut op in ctx.activity.snapshot() {
            let has = |feature: &str| {
                op["features"]
                    .as_array()
                    .is_some_and(|f| f.iter().any(|v| v == feature))
            };
            let waiting = (has("semanticSearch") && ctx.embed_backoff.waiting() && values.semantic_search)
                || (has("imageSearch") && ctx.image_embed_backoff.waiting() && values.image_search);
            if waiting {
                op["state"] = json!("waiting");
                op["phase"] = json!("waiting");
                op["total"] = Value::Null;
                op["finishedAt"] = Value::Null;
            }
            operations.push(op);
        }
    }
    let feature = state
        .failure_retry_feature
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    let jobs = &state.jobs;
    for (job, kind, features) in [
        (&jobs.failure_retry, "reindex", vec![feature.as_str()]),
        (&jobs.thumbnail, "thumbnailRebuild", vec!["thumbnails"]),
        (&jobs.thumbnail_clear, "thumbnailClear", vec!["thumbnails"]),
        (&jobs.index_clear, "indexClear", vec!["textSearch", "semanticSearch"]),
        (&jobs.image_rebuild, "imageRebuild", vec!["imageSearch"]),
        (&jobs.image_clear, "imageClear", vec!["imageSearch"]),
    ] {
        if let Some(snapshot) = job.activity_snapshot(kind, &features) {
            operations.push(snapshot);
        }
    }
    Json(json!({"instanceId": state.instance_id, "observedAt": iso_now(), "operations": operations})).into_response()
}

async fn stats(State(state): State<Shared>) -> Response {
    let result = blocking(move || {
        state.db.with(|c| {
            let mut roots = Vec::new();
            let mut errors = Vec::new();
            let mut queue_depth = 0;
            for ctx in &state.contexts {
                roots.push(db::root_stats(c, &ctx.name, ctx.root_id)?);
                errors.extend(db::errors_sample(c, ctx.root_id, 20)?);
                queue_depth += db::pending_count(c, ctx.root_id)?;
            }
            let jobs = &state.jobs;
            Ok(json!({
                "roots": roots,
                "thumbnails": db::count(c, r#""app"."thumbnails""#)?,
                "image_embeddings": db::count(c, r#""app"."image_embeddings""#)?,
                "queue_depth": queue_depth,
                "errors_sample": errors,
                "thumbnail_rebuild": jobs.thumbnail.snapshot(),
                "image_embedding_rebuild": jobs.image_rebuild.snapshot(),
                "features": state.features().as_json(),
                "index_clear": jobs.index_clear.snapshot(),
                "thumbnail_clear": jobs.thumbnail_clear.snapshot(),
                "image_embedding_clear": jobs.image_clear.snapshot(),
            }))
        })
    })
    .await;
    match result {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(_)) | Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "database unavailable"),
    }
}

async fn extract_text(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let payload = match object(&body) {
        Ok(payload) => payload,
        Err(response) => return response.into_response(),
    };
    let (Some(root), Some(path)) = (
        payload.get("root").and_then(Value::as_str),
        payload.get("path").and_then(Value::as_str),
    ) else {
        return error(StatusCode::BAD_REQUEST, "root and path are required");
    };
    let Some(ctx) = state.context(root).cloned() else {
        return error(StatusCode::NOT_FOUND, &format!("unknown root: {root}"));
    };
    let features = ctx.values();
    if !features.text_search {
        return Json(json!({"text": null, "status": "disabled"})).into_response();
    }
    let path = path.to_owned();
    let offset = payload.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let max_chars = payload.get("max_chars").and_then(Value::as_u64).map(|v| v as usize);
    let result = blocking(move || {
        let parts = if path.is_empty() {
            Err("invalid path")
        } else {
            fsx::path_parts(&if path.starts_with('/') {
                path.clone()
            } else {
                format!("/{path}")
            })
        };
        let parts = match parts {
            Ok(parts) if !parts.is_empty() => parts,
            _ => return Err(fail(StatusCode::BAD_REQUEST, "invalid path")),
        };
        let opened = fsx::open_file(&ctx.abs_path, &parts).map_err(|e| {
            let status = io_status(&e);
            fail(
                status,
                if status == StatusCode::NOT_FOUND {
                    "not found"
                } else {
                    "path unavailable"
                },
            )
        })?;
        let ext = ext_of(crate::paths::basename(&path));
        if crate::chunking::is_image(&ext) && !features.search_ocr {
            return Ok(json!({"text": null, "status": "disabled"}));
        }
        if !crate::chunking::is_textual(&ext) {
            return Ok(json!({"text": null, "status": "none"}));
        }
        let (text, status) = ctx
            .extractor()
            .extract(&opened.path(), &path, &ext, opened.size, features.search_ocr);
        Ok(match text {
            None => json!({"text": null, "status": status}),
            Some(text) => {
                let total = text.chars().count();
                let slice: String = text
                    .chars()
                    .skip(offset)
                    .take(max_chars.unwrap_or(usize::MAX))
                    .collect();
                json!({"text": slice, "status": status, "total_chars": total})
            }
        })
    })
    .await;
    match result {
        Ok(Ok(body)) => Json(body).into_response(),
        Ok(Err(response)) | Err(response) => response.into_response(),
    }
}

#[derive(serde::Deserialize)]
struct NameQuery {
    #[serde(default)]
    name: String,
}

async fn extract_content(State(state): State<Shared>, Query(query): Query<NameQuery>, body: Body) -> Response {
    let Some(extractor) = state.content.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "extraction unavailable");
    };
    let name = query.name;
    if name.is_empty() || name.chars().count() > 255 || name.contains(['/', '\\', '\0']) {
        return error(StatusCode::BAD_REQUEST, "invalid name");
    }
    let Ok(permit) = Arc::clone(&extractor.admission).try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "extraction busy");
    };
    let content =
        match tokio::time::timeout(Duration::from_secs(10), axum::body::to_bytes(body, MAX_CONTENT_BYTES)).await {
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "request timed out"),
            Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "content too large"),
            Ok(Ok(content)) => content,
        };
    let result = blocking(move || {
        let _permit = permit;
        // Without roots this reads the database, which must not happen on the async thread.
        let search_ocr = state.features().values.search_ocr;
        extractor.extract(&content, &name, search_ocr)
    })
    .await;
    match result {
        Ok(body) => Json(body).into_response(),
        Err(response) => response.into_response(),
    }
}

async fn reindex(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let payload = match object(&body) {
        Ok(payload) => payload,
        Err(response) => return response.into_response(),
    };
    let Some(root) = payload.get("root").and_then(Value::as_str) else {
        return error(StatusCode::BAD_REQUEST, "root is required");
    };
    let Some(ctx) = state.context(root).cloned() else {
        return error(StatusCode::NOT_FOUND, &format!("unknown root: {root}"));
    };
    let features = ctx.features();
    if !features.values.indexer_enabled() {
        return error(StatusCode::CONFLICT, "feature processing disabled");
    }
    let path = payload.get("path").and_then(Value::as_str).map(str::to_owned);
    let thumbnails = payload.get("thumbnails") == Some(&Value::Bool(true));
    let marked = {
        let ctx = Arc::clone(&ctx);
        let path = path.clone();
        blocking(move || {
            let scope = reindex_scope(path.as_deref());
            ctx.db
                .with(|c| db::mark_pending(c, ctx.root_id, scope.as_ref().map(|(e, p)| (e.as_str(), p.as_str()))))
        })
        .await
    };
    let count = match marked {
        Ok(Ok(count)) => count,
        Ok(Err(_)) | Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "database unavailable"),
    };
    ctx.activity
        .queue_scan(work_features(&features.values, None, false, false), features.revision);
    if let Some(wake) = state.wakes.get(root) {
        wake.set();
    }
    if thumbnails && features.values.internal_thumbnails() {
        // Best effort: a running rebuild means this one is not queued.
        maintenance::start_thumbnail_rebuild(&state.jobs.thumbnail, vec![ctx], path, false);
    }
    Json(json!({"count": count})).into_response()
}

struct RebuildRequest {
    contexts: Vec<Arc<RootContext>>,
    path: Option<String>,
    force: bool,
}

fn rebuild_request(state: &AppState, body: &[u8]) -> Result<RebuildRequest, ApiError> {
    let payload = object(body)?;
    let root = payload.get("root").filter(|v| !v.is_null());
    let path = payload.get("path").filter(|v| !v.is_null());
    if root.is_some_and(|r| !r.is_string()) {
        return Err(fail(StatusCode::BAD_REQUEST, "root must be a string"));
    }
    if path.is_some_and(|p| !p.is_string()) {
        return Err(fail(StatusCode::BAD_REQUEST, "path must be a string"));
    }
    let contexts = match root.and_then(Value::as_str) {
        Some(name) => state.context(name).cloned().into_iter().collect(),
        None => state.contexts.clone(),
    };
    Ok(RebuildRequest {
        contexts,
        path: path.and_then(Value::as_str).map(str::to_owned),
        force: payload.get("force") == Some(&Value::Bool(true)),
    })
}

async fn thumbnails_rebuild(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let request = match rebuild_request(&state, &body) {
        Ok(request) => request,
        Err(response) => return response.into_response(),
    };
    if !request.contexts.is_empty() && !request.contexts.iter().any(|c| c.values().internal_thumbnails()) {
        return error(StatusCode::CONFLICT, "thumbnail processing disabled");
    }
    if !maintenance::start_thumbnail_rebuild(&state.jobs.thumbnail, request.contexts, request.path, request.force) {
        return error(StatusCode::CONFLICT, "a thumbnail rebuild is already running");
    }
    (StatusCode::ACCEPTED, Json(json!({"started": true, "total": null}))).into_response()
}

async fn image_embeddings_rebuild(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let request = match rebuild_request(&state, &body) {
        Ok(request) => request,
        Err(response) => return response.into_response(),
    };
    if !request.contexts.is_empty() && !request.contexts.iter().any(|c| c.values().image_search) {
        return error(StatusCode::CONFLICT, "image search disabled");
    }
    if !maintenance::start_image_rebuild(&state.jobs.image_rebuild, request.contexts, request.path, request.force) {
        return error(StatusCode::CONFLICT, "an image-embedding rebuild is already running");
    }
    (StatusCode::ACCEPTED, Json(json!({"started": true, "total": null}))).into_response()
}

/// `os.path.normpath` for a validated relative path: drop empty and `.` segments.
fn normalize_scope(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

async fn clear(State(state): State<Shared>, uri: Uri, body: axum::body::Bytes) -> Response {
    let payload = match object(&body) {
        Ok(payload) => payload,
        Err(response) => return response.into_response(),
    };
    let kind = match uri.path() {
        "/index/clear" => "index",
        "/thumbnails/clear" => "thumbnails",
        _ => "image_embeddings",
    };
    let allowed: &[&str] = if kind == "index" { &["root", "path"] } else { &[] };
    if payload.keys().any(|k| !allowed.contains(&k.as_str())) {
        return error(StatusCode::BAD_REQUEST, "unknown fields");
    }
    for field in allowed {
        if let Some(value) = payload.get(*field)
            && value.as_str().is_none_or(|s| s.trim().is_empty())
        {
            return error(StatusCode::BAD_REQUEST, &format!("{field} must be a nonempty string"));
        }
    }
    let root = payload.get("root").and_then(Value::as_str);
    let path = payload.get("path").and_then(Value::as_str);
    if path.is_some() && root.is_none() {
        return error(StatusCode::BAD_REQUEST, "path requires root");
    }
    if path.is_some_and(|p| p.split('/').any(|s| s == "..") || p.contains(['\\', '\0'])) {
        return error(StatusCode::BAD_REQUEST, "invalid path");
    }
    let contexts = match root {
        Some(name) => match state.context(name) {
            Some(ctx) => vec![Arc::clone(ctx)],
            None => return error(StatusCode::NOT_FOUND, &format!("unknown root: {name}")),
        },
        None => state.contexts.clone(),
    };
    let scope = path.and_then(|p| normalize_scope(p.trim_start_matches('/')));
    let started = match kind {
        "thumbnails" => maintenance::start_clear(&state.jobs.thumbnail_clear, "thumbnails", move |job| {
            maintenance::clear_thumbnails(&contexts, job)
        }),
        "image_embeddings" => maintenance::start_clear(&state.jobs.image_clear, "image_embeddings", move |job| {
            maintenance::clear_image_embeddings(&contexts, job)
        }),
        _ => maintenance::start_clear(&state.jobs.index_clear, "index", move |job| {
            maintenance::clear_index(&contexts, scope.as_deref(), job)
        }),
    };
    if !started {
        return error(StatusCode::CONFLICT, "a clear or thumbnail rebuild is already running");
    }
    (StatusCode::ACCEPTED, Json(json!({"started": true}))).into_response()
}

async fn retry_failures(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let Ok(Value::Object(payload)) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid request");
    };
    let Some(feature) = payload
        .get("feature")
        .and_then(Value::as_str)
        .filter(|f| FEATURES.contains(f))
    else {
        return error(StatusCode::BAD_REQUEST, "invalid feature");
    };
    let feature = feature.to_owned();
    let failure_id = match payload.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) if n.as_i64().is_some_and(|id| id >= 1) && n.is_i64() => n.as_i64(),
        Some(_) => return error(StatusCode::BAD_REQUEST, "invalid failure id"),
    };
    let contexts: Vec<Arc<RootContext>> = state
        .contexts
        .iter()
        .filter(|c| c.values().get(&feature))
        .cloned()
        .collect();
    if contexts.is_empty() {
        return error(StatusCode::CONFLICT, "feature disabled");
    }
    if let Some(id) = failure_id {
        let (lookup, wanted) = (contexts.clone(), feature.clone());
        let found = blocking(move || {
            lookup.iter().any(|ctx| {
                ctx.db
                    .with(|c| {
                        Ok(c.query_opt(
                            "SELECT 1 FROM idx.processing_failures WHERE id = $1::bigint AND root_id = $2::bigint \
                             AND feature = $3 AND resolved_at IS NULL",
                            &[&id, &ctx.root_id, &wanted],
                        )?
                        .is_some())
                    })
                    .unwrap_or(false)
            })
        })
        .await;
        if !matches!(found, Ok(true)) {
            return error(StatusCode::NOT_FOUND, "no unresolved failure found");
        }
    }
    if !maintenance::start_retry(&state.jobs.failure_retry, contexts, feature.clone(), failure_id) {
        return error(StatusCode::CONFLICT, "maintenance busy");
    }
    *state
        .failure_retry_feature
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = feature;
    (
        StatusCode::ACCEPTED,
        Json(json!({"started": true, "operationId": state.jobs.failure_retry.run_id()})),
    )
        .into_response()
}

/// Files and folders whose name answers a query, typos allowed: see `NameIndex::search`.
/// 503 while the index is building or absent, so the caller falls back to its own queries.
async fn search_names(State(state): State<Shared>, body: axum::body::Bytes) -> Response {
    let query = match serde_json::from_slice::<NameSearch>(&body) {
        Ok(query) => query,
        Err(_) => return error(StatusCode::BAD_REQUEST, "query is required"),
    };
    let Some(names) = state.names.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "name index unavailable");
    };
    match blocking(move || names.search(&query)).await {
        Ok(Ok(Some(hits))) => Json(hits).into_response(),
        Ok(Ok(None)) => error(StatusCode::SERVICE_UNAVAILABLE, "name index is building"),
        Ok(Err(_)) | Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "name search failed"),
    }
}

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/failures/retry", post(retry_failures))
        .route("/health", get(health))
        .route("/stats", get(stats))
        .route("/activity", get(activity))
        .route("/extract", post(extract_text))
        .route("/extract-content", post(extract_content))
        .route("/reindex", post(reindex))
        .route("/index/clear", post(clear))
        .route("/thumbnails/clear", post(clear))
        .route("/thumbnails/rebuild", post(thumbnails_rebuild))
        .route("/image-embeddings/clear", post(clear))
        .route("/image-embeddings/rebuild", post(image_embeddings_rebuild))
        .route("/names/search", post(search_names))
        .with_state(state)
}
