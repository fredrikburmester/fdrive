//! All SQL. The indexer never creates tables: `packages/db` migrations own the schema.
//! Each thread keeps its own autocommit connection, reopened when it breaks.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use pgvector::Vector;
use postgres::{Client, NoTls};
use serde_json::Value;

use crate::chunking::PDF_EXTS;
use crate::events::{Event, to_json};
use crate::settings::RawSettings;

pub const SWEEP_BATCH: usize = 5_000;

pub fn connect(url: &str, retries: u32, sleep: impl Fn(Duration)) -> Result<Client> {
    let mut last = None;
    for attempt in 0..retries.max(1) {
        match Client::connect(url, NoTls) {
            Ok(client) => return Ok(client),
            Err(error) => last = Some(error),
        }
        if attempt + 1 < retries {
            sleep(Duration::from_secs(2));
        }
    }
    anyhow::bail!(
        "could not connect to postgres: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    )
}

thread_local! {
    static CONNECTIONS: RefCell<HashMap<String, Client>> = RefCell::new(HashMap::new());
}

/// A database address; work runs on the calling thread's own connection.
#[derive(Debug, Clone)]
pub struct Db {
    pub url: String,
    pub retries: u32,
}

impl Db {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_owned(),
            retries: 30,
        }
    }

    pub fn with<R>(&self, work: impl FnOnce(&mut Client) -> Result<R>) -> Result<R> {
        // Registers tokio's thread-local before ours, so it is destroyed after the pooled client.
        let _ = tokio::runtime::Handle::try_current();
        let mut client = CONNECTIONS.with(|c| c.borrow_mut().remove(&self.url));
        if client.as_ref().is_none_or(Client::is_closed) {
            client = Some(connect(&self.url, self.retries, std::thread::sleep)?);
        }
        let mut client = client.context("no connection")?;
        let result = work(&mut client);
        if !client.is_closed() {
            CONNECTIONS.with(|c| c.borrow_mut().insert(self.url.clone(), client));
        }
        result
    }
}

pub fn read_schema_version(client: &mut Client) -> Result<Option<i64>> {
    let row = client.query_opt(
        r#"SELECT version::bigint FROM "idx"."schema_version" ORDER BY version DESC LIMIT 1"#,
        &[],
    );
    match row {
        Ok(row) => Ok(row.map(|r| r.get(0))),
        Err(error) if error.is_closed() || error.as_db_error().is_none() => Err(error.into()),
        Err(_) => Ok(None),
    }
}

/// Wait for the compatible schema and the failure-history, work-queue and folder tables
/// before any processing. They came without a version bump, which OCR waits for too.
pub fn wait_for_schema_version(
    db: &Db,
    expected: i64,
    timeout: Duration,
    log: &dyn Fn(&str),
    sleep: &dyn Fn(Duration),
) -> Result<Option<i64>> {
    let deadline = Instant::now() + timeout;
    loop {
        let (version, ready) = db.with(|c| {
            let version = read_schema_version(c)?;
            let row = c.query_one(
                "SELECT to_regclass('idx.processing_failures')::text, to_regclass('idx.work')::text, \
                 to_regclass('idx.folders')::text",
                &[],
            )?;
            let tables: [Option<String>; 3] = [row.get(0), row.get(1), row.get(2)];
            Ok((version, tables.iter().all(Option::is_some)))
        })?;
        if version == Some(expected) && ready {
            return Ok(version);
        }
        let seen = version.map_or("None".to_owned(), |v| v.to_string());
        if Instant::now() >= deadline {
            log(&format!(
                "schema not ready (expected {expected}, last seen: {seen}, requires processing_failures, work and folders); giving up"
            ));
            return Ok(None);
        }
        log(&format!(
            "waiting for idx.schema_version = {expected} and the processing_failures, work and folders migrations (last seen: {seen})"
        ));
        sleep(Duration::from_secs(5));
    }
}

pub fn upsert_root(c: &mut Client, name: &str) -> Result<i64> {
    let row = c.query_one(
        r#"INSERT INTO "idx"."roots" (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id::bigint"#,
        &[&name],
    )?;
    Ok(row.get(0))
}

/// One `idx.files` row as a scan sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestRow {
    pub size: i64,
    pub mtime_ns: i64,
    pub status: String,
    pub deleted: bool,
    pub sha256: Option<String>,
    pub image_embedded: bool,
    pub thumbnail_failed: bool,
}

/// Every row of a root with its content key, whether that key has an image embedding,
/// and whether its last thumbnail attempt failed, in one query.
pub fn scan_manifest(c: &mut Client, root_id: i64) -> Result<HashMap<String, ManifestRow>> {
    let rows = c.query(
        r#"SELECT f.path, f.size::bigint, f.mtime_ns::bigint, f.text_status, f.deleted_at IS NOT NULL, f.sha256,
                  e.content_key IS NOT NULL, p.id IS NOT NULL
           FROM "idx"."files" f
           LEFT JOIN "app"."image_embeddings" e ON e.content_key = f.sha256
           LEFT JOIN "idx"."processing_failures" p ON p.root_id = f.root_id AND p.path = f.path
             AND p.feature = 'thumbnails' AND p.resolved_at IS NULL
           WHERE f.root_id = $1::bigint"#,
        &[&root_id],
    )?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get(0),
                ManifestRow {
                    size: r.get(1),
                    mtime_ns: r.get(2),
                    status: r.get(3),
                    deleted: r.get(4),
                    sha256: r.get(5),
                    image_embedded: r.get(6),
                    thumbnail_failed: r.get(7),
                },
            )
        })
        .collect())
}

/// Count of `pending` rows in a root, for `/stats`' queue depth.
pub fn pending_count(c: &mut Client, root_id: i64) -> Result<i64> {
    Ok(c.query_one(
        r#"SELECT count(*) FROM "idx"."files" WHERE root_id = $1::bigint AND text_status = 'pending'"#,
        &[&root_id],
    )?
    .get(0))
}

/// The row `process_file` checks under its path lock.
#[derive(Debug, Clone)]
pub struct FileRow {
    pub size: i64,
    pub mtime_ns: i64,
    pub status: String,
    pub deleted: bool,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

pub fn file_row(c: &mut Client, root_id: i64, path: &str) -> Result<Option<FileRow>> {
    let row = c.query_opt(
        r#"SELECT size::bigint, mtime_ns::bigint, text_status, deleted_at IS NOT NULL, sha256, error
           FROM "idx"."files" WHERE root_id = $1::bigint AND path = $2"#,
        &[&root_id, &path],
    )?;
    Ok(row.map(|r| FileRow {
        size: r.get(0),
        mtime_ns: r.get(1),
        status: r.get(2),
        deleted: r.get(3),
        sha256: r.get(4),
        error: r.get(5),
    }))
}

/// Move old `no_text` PDFs to `disabled:search_ocr` for a root whose OCR is off.
pub fn mark_pdfs_skipped_by_ocr(c: &mut Client, root_id: i64) -> Result<u64> {
    let exts: Vec<&str> = PDF_EXTS.to_vec();
    Ok(c.execute(
        r#"UPDATE "idx"."files" SET text_status = 'disabled:search_ocr'
           WHERE root_id = $1::bigint AND text_status = 'no_text' AND ext = ANY($2) AND deleted_at IS NULL"#,
        &[&root_id, &exts],
    )?)
}

pub struct NewFile<'a> {
    pub root_id: i64,
    pub path: &'a str,
    pub name: &'a str,
    pub ext: &'a str,
    pub size: i64,
    pub mtime_ns: i64,
    pub sha256: &'a str,
    pub mime: Option<&'a str>,
}

/// Insert or reset a row to `pending` and drop its chunks. Returns the row id.
pub fn upsert_file(c: &mut Client, file: &NewFile<'_>) -> Result<i64> {
    let id: i64 = c
        .query_one(
            r#"INSERT INTO "idx"."files"
                 (root_id, path, name, ext, size, mtime_ns, sha256, mime, text_status, last_seen, deleted_at, error)
               VALUES ($1::bigint, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, 'pending', now(), NULL, NULL)
               ON CONFLICT (root_id, path) DO UPDATE SET
                 name = EXCLUDED.name, ext = EXCLUDED.ext, size = EXCLUDED.size, mtime_ns = EXCLUDED.mtime_ns,
                 sha256 = EXCLUDED.sha256, mime = EXCLUDED.mime, text_status = 'pending',
                 last_seen = now(), deleted_at = NULL, error = NULL
               RETURNING id::bigint"#,
            &[
                &file.root_id,
                &file.path,
                &file.name,
                &file.ext,
                &file.size,
                &file.mtime_ns,
                &file.sha256,
                &file.mime,
            ],
        )?
        .get(0);
    c.execute(r#"DELETE FROM "idx"."chunks" WHERE file_id = $1::bigint"#, &[&id])?;
    Ok(id)
}

pub fn insert_chunks(c: &mut Client, file_id: i64, pieces: &[String], vectors: &[Option<Vec<f32>>]) -> Result<()> {
    if pieces.is_empty() {
        return Ok(());
    }
    let statement = c.prepare(
        r#"INSERT INTO "idx"."chunks" (file_id, idx, text, embedding) VALUES ($1::bigint, $2::int, $3, $4)"#,
    )?;
    let mut tx = c.transaction()?;
    for (i, (piece, vector)) in pieces.iter().zip(vectors).enumerate() {
        let vector = vector.clone().map(Vector::from);
        tx.execute(&statement, &[&file_id, &(i as i32), piece, &vector])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_file_status(c: &mut Client, file_id: i64, status: &str, chars: i64, error: Option<&str>) -> Result<()> {
    c.execute(
        r#"UPDATE "idx"."files" SET text_status = $1, text_chars = $2::bigint, error = $3, indexed_at = now() WHERE id = $4::bigint"#,
        &[&status, &chars, &error, &file_id],
    )?;
    Ok(())
}

pub fn chunks_missing_embeddings(c: &mut Client, root_id: i64, path: &str) -> Result<Vec<(i64, String)>> {
    Ok(c.query(
        r#"SELECT c.id::bigint, c.text FROM "idx"."chunks" c JOIN "idx"."files" f ON f.id = c.file_id
           WHERE f.root_id = $1::bigint AND f.path = $2 AND c.embedding IS NULL ORDER BY c.idx"#,
        &[&root_id, &path],
    )?
    .into_iter()
    .map(|r| (r.get(0), r.get(1)))
    .collect())
}

pub fn set_chunk_embeddings(c: &mut Client, pairs: &[(i64, Vec<f32>)]) -> Result<()> {
    let statement = c.prepare(r#"UPDATE "idx"."chunks" SET embedding = $1 WHERE id = $2::bigint"#)?;
    let mut tx = c.transaction()?;
    for (id, vector) in pairs {
        tx.execute(&statement, &[&Vector::from(vector.clone()), id])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn mark_file_indexed(c: &mut Client, root_id: i64, path: &str) -> Result<()> {
    c.execute(
        r#"UPDATE "idx"."files" SET text_status = 'indexed', error = NULL WHERE root_id = $1::bigint AND path = $2"#,
        &[&root_id, &path],
    )?;
    Ok(())
}

pub fn mark_file_error(c: &mut Client, root_id: i64, path: &str, error: &str) -> Result<()> {
    c.execute(
        r#"UPDATE "idx"."files" SET text_status = 'error', error = $1, indexed_at = now() WHERE root_id = $2::bigint AND path = $3"#,
        &[&error, &root_id, &path],
    )?;
    Ok(())
}

/// Soft-delete a path (or a directory's subtree), drop its chunks and its folder rows;
/// returns the file row ids.
pub fn mark_deleted(c: &mut Client, root_id: i64, path: &str, is_dir: bool) -> Result<Vec<i64>> {
    let mut tx = c.transaction()?;
    let prefix = format!("{path}/");
    let ids: Vec<i64> = tx
        .query(
            r#"UPDATE "idx"."files" SET deleted_at = now() WHERE root_id = $1::bigint AND deleted_at IS NULL
               AND (path = $2 OR ($3 AND starts_with(path, $4))) RETURNING id::bigint"#,
            &[&root_id, &path, &is_dir, &prefix],
        )?
        .into_iter()
        .map(|r| r.get(0))
        .collect();
    if !ids.is_empty() {
        tx.execute(
            r#"DELETE FROM "idx"."chunks" WHERE file_id = ANY($1::bigint[])"#,
            &[&ids],
        )?;
    }
    tx.execute(
        r#"DELETE FROM "idx"."folders" WHERE root_id = $1::bigint AND (path = $2 OR ($3 AND starts_with(path, $4)))"#,
        &[&root_id, &path, &is_dir, &prefix],
    )?;
    tx.commit()?;
    Ok(ids)
}

/// Rename rows in place, replacing a stale row at the destination; a folder's rows in
/// `idx.folders` follow it. Returns file rows moved.
pub fn rename_paths(c: &mut Client, root_id: i64, old: &str, new: &str, is_dir: bool) -> Result<u64> {
    let mut tx = c.transaction()?;
    let moved = if is_dir {
        let (old_prefix, new_prefix) = (format!("{old}/"), format!("{new}/"));
        let from = old_prefix.chars().count() as i32 + 1;
        tx.execute(
            r#"DELETE FROM "idx"."files" f USING "idx"."files" s
               WHERE f.root_id = $1::bigint AND s.root_id = $1::bigint AND starts_with(s.path, $2) AND s.deleted_at IS NULL
               AND f.path = $3 || substr(s.path, $4::int)"#,
            &[&root_id, &old_prefix, &new_prefix, &from],
        )?;
        let moved = tx.execute(
            r#"UPDATE "idx"."files" SET path = $1 || substr(path, $2::int), last_seen = now()
               WHERE root_id = $3::bigint AND starts_with(path, $4) AND deleted_at IS NULL"#,
            &[&new_prefix, &from, &root_id, &old_prefix],
        )?;
        rename_folders(&mut tx, root_id, old, new)?;
        moved
    } else {
        tx.execute(
            r#"DELETE FROM "idx"."files" WHERE root_id = $1::bigint AND path = $2 AND EXISTS
               (SELECT 1 FROM "idx"."files" WHERE root_id = $1::bigint AND path = $3 AND deleted_at IS NULL)"#,
            &[&root_id, &new, &old],
        )?;
        let name = crate::paths::basename(new);
        tx.execute(
            r#"UPDATE "idx"."files" SET path = $1, name = $2, last_seen = now()
               WHERE root_id = $3::bigint AND path = $4 AND deleted_at IS NULL"#,
            &[&new, &name, &root_id, &old],
        )?
    };
    tx.commit()?;
    Ok(moved)
}

pub fn insert_move(c: &mut Client, root_id: i64, src: &str, dst: &str, actor: &str) -> Result<()> {
    c.execute(
        r#"INSERT INTO "idx"."moves" (root_id, src, dst, actor) VALUES ($1::bigint, $2, $3, $4)"#,
        &[&root_id, &src, &dst, &actor],
    )?;
    Ok(())
}

/// Insert the durable row and NOTIFY listeners with the same payload.
pub fn record_event(c: &mut Client, root_id: i64, event: &Event) -> Result<()> {
    let payload = to_json(event);
    c.execute(
        r#"INSERT INTO "idx"."events" (root_id, kind, path, target_path) VALUES ($1::bigint, $2, $3, $4)"#,
        &[&root_id, &event.kind.as_str(), &event.path, &event.target_path],
    )?;
    c.execute("SELECT pg_notify('idx_events', $1)", &[&payload])?;
    Ok(())
}

pub fn prune_events(c: &mut Client, older_than_days: i64) -> Result<u64> {
    let cutoff = Utc::now() - chrono::Duration::days(older_than_days);
    Ok(c.execute(r#"DELETE FROM "idx"."events" WHERE at < $1"#, &[&cutoff])?)
}

pub fn start_scan(c: &mut Client, root_id: i64) -> Result<(i64, DateTime<Utc>)> {
    let row = c.query_one(
        r#"INSERT INTO "idx"."scans" (root_id, started_at) VALUES ($1::bigint, now()) RETURNING id::bigint, started_at"#,
        &[&root_id],
    )?;
    Ok((row.get(0), row.get(1)))
}

pub fn finish_scan(c: &mut Client, scan_id: i64, seen: i64, changed: i64, deleted: i64, errors: i64) -> Result<()> {
    c.execute(
        r#"UPDATE "idx"."scans" SET finished_at = now(), files_seen = $1::bigint, files_changed = $2::bigint,
           files_deleted = $3::bigint, errors = $4::bigint WHERE id = $5::bigint"#,
        &[&seen, &changed, &deleted, &errors, &scan_id],
    )?;
    Ok(())
}

/// Soft-delete live rows a completed walk no longer found, unless written after `started_at`.
pub fn sweep_vanished(c: &mut Client, root_id: i64, vanished: &[String], started_at: DateTime<Utc>) -> Result<i64> {
    let mut paths = vanished.to_vec();
    paths.sort();
    let mut deleted = 0;
    for batch in paths.chunks(SWEEP_BATCH) {
        let row = c.query_one(
            r#"WITH gone AS (
                 UPDATE "idx"."files" SET deleted_at = now()
                 WHERE root_id = $1::bigint AND deleted_at IS NULL AND last_seen < $2 AND path = ANY($3)
                 RETURNING id
               ), dropped AS (
                 DELETE FROM "idx"."chunks" WHERE file_id IN (SELECT id FROM gone)
               )
               SELECT count(*) FROM gone"#,
            &[&root_id, &started_at, &batch],
        )?;
        deleted += row.get::<_, i64>(0);
    }
    Ok(deleted)
}

pub fn read_settings(c: &mut Client) -> Result<RawSettings> {
    Ok(c.query(r#"SELECT key, value FROM "app"."settings""#, &[])?
        .into_iter()
        .map(|r| (r.get::<_, String>(0), r.get::<_, Value>(1)))
        .collect())
}

pub fn upsert_thumbnail(c: &mut Client, key: &str, size: u32, path: &str, width: u32, height: u32) -> Result<()> {
    c.execute(
        r#"INSERT INTO "app"."thumbnails" (content_key, size, storage_path, width, height, generated_at)
           VALUES ($1, $2::bigint, $3, $4::bigint, $5::bigint, now())
           ON CONFLICT (content_key, size) DO UPDATE SET
             storage_path = EXCLUDED.storage_path, width = EXCLUDED.width, height = EXCLUDED.height, generated_at = now()"#,
        &[&key, &i64::from(size), &path, &i64::from(width), &i64::from(height)],
    )?;
    Ok(())
}

pub fn count(c: &mut Client, table: &str) -> Result<i64> {
    Ok(c.query_one(&format!("SELECT count(*) FROM {table}"), &[])?.get(0))
}

pub fn image_embedding_model(c: &mut Client, key: &str) -> Result<Option<String>> {
    Ok(c.query_opt(
        r#"SELECT model FROM "app"."image_embeddings" WHERE content_key = $1"#,
        &[&key],
    )?
    .map(|r| r.get(0)))
}

pub fn file_content_key(c: &mut Client, root_id: i64, path: &str) -> Result<Option<String>> {
    Ok(c.query_opt(
        r#"SELECT sha256 FROM "idx"."files" WHERE root_id = $1::bigint AND path = $2 AND deleted_at IS NULL"#,
        &[&root_id, &path],
    )?
    .and_then(|r| r.get(0)))
}

pub fn upsert_image_embedding(c: &mut Client, key: &str, model: &str, embedding: &[f32]) -> Result<()> {
    c.execute(
        r#"INSERT INTO "app"."image_embeddings" (content_key, model, embedding, created_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (content_key) DO UPDATE SET model = EXCLUDED.model, embedding = EXCLUDED.embedding, created_at = now()"#,
        &[&key, &model, &Vector::from(embedding.to_vec())],
    )?;
    Ok(())
}

/// `(path, ext, sha256, size)` of every live, hashed file in a root.
pub fn media_files(c: &mut Client, root_id: i64) -> Result<Vec<(String, String, String, i64)>> {
    Ok(c.query(
        r#"SELECT path, ext, sha256, size::bigint FROM "idx"."files"
           WHERE root_id = $1::bigint AND deleted_at IS NULL AND sha256 IS NOT NULL"#,
        &[&root_id],
    )?
    .into_iter()
    .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
    .collect())
}

pub fn root_stats(c: &mut Client, root: &str, root_id: i64) -> Result<Value> {
    let counts: serde_json::Map<String, Value> = c
        .query(
            r#"SELECT text_status, count(*) FROM "idx"."files" WHERE root_id = $1::bigint AND deleted_at IS NULL GROUP BY text_status"#,
            &[&root_id],
        )?
        .into_iter()
        .map(|r| (r.get::<_, String>(0), Value::from(r.get::<_, i64>(1))))
        .collect();
    let chunks = c.query_one(
        r#"SELECT count(*), count(*) FILTER (WHERE c.embedding IS NOT NULL)
           FROM "idx"."chunks" c JOIN "idx"."files" f ON f.id = c.file_id
           WHERE f.root_id = $1::bigint AND f.deleted_at IS NULL"#,
        &[&root_id],
    )?;
    let scan = c.query_opt(
        r#"SELECT started_at, finished_at, files_seen::bigint, files_changed::bigint, files_deleted::bigint, errors::bigint
           FROM "idx"."scans" WHERE root_id = $1::bigint ORDER BY started_at DESC LIMIT 1"#,
        &[&root_id],
    )?;
    let last_scan = scan.map(|r| {
        serde_json::json!({
            "started_at": crate::events::iso(r.get::<_, DateTime<Utc>>(0)),
            "finished_at": r.get::<_, Option<DateTime<Utc>>>(1).map(crate::events::iso),
            "files_seen": r.get::<_, i64>(2), "files_changed": r.get::<_, i64>(3),
            "files_deleted": r.get::<_, i64>(4), "errors": r.get::<_, i64>(5),
        })
    });
    Ok(serde_json::json!({
        "root": root, "counts_by_status": counts, "chunks": chunks.get::<_, i64>(0),
        "chunks_embedded": chunks.get::<_, i64>(1), "last_scan": last_scan,
    }))
}

pub fn errors_sample(c: &mut Client, root_id: i64, limit: i64) -> Result<Vec<Value>> {
    Ok(c.query(
        r#"SELECT path, error FROM "idx"."files" WHERE root_id = $1::bigint AND text_status = 'error'
           AND deleted_at IS NULL ORDER BY indexed_at DESC LIMIT $2::bigint"#,
        &[&root_id, &limit],
    )?
    .into_iter()
    .map(|r| serde_json::json!({"path": r.get::<_, String>(0), "error": r.get::<_, Option<String>>(1)}))
    .collect())
}

/// Mark rows `pending` for `/reindex`: the whole root, or a path and everything below it.
pub fn mark_pending(c: &mut Client, root_id: i64, scope: Option<(&str, &str)>) -> Result<u64> {
    Ok(match scope {
        None => c.execute(
            r#"UPDATE "idx"."files" SET text_status = 'pending' WHERE root_id = $1::bigint AND deleted_at IS NULL"#,
            &[&root_id],
        )?,
        Some((exact, prefix)) => c.execute(
            r#"UPDATE "idx"."files" SET text_status = 'pending' WHERE root_id = $1::bigint AND deleted_at IS NULL
               AND (path = $2 OR starts_with(path, $3))"#,
            &[&root_id, &exact, &prefix],
        )?,
    })
}

/// One change the API queued in `idx.work`, exactly as stored; `work` checks it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkRow {
    pub id: i64,
    pub path: String,
    pub target_path: Option<String>,
    pub sha256: Option<String>,
    pub size: Option<i64>,
    pub mtime_ns: Option<i64>,
    /// The unsigned inode number's 64 bits, stored signed.
    pub inode: Option<i64>,
    pub ctime_ns: Option<i64>,
}

/// A root's oldest queued changes, at most `limit`.
pub fn work_batch(c: &mut Client, root_id: i64, limit: i64) -> Result<Vec<WorkRow>> {
    Ok(c.query(
        r#"SELECT id::bigint, path, target_path, sha256, size::bigint, mtime_ns::bigint, inode::bigint,
           ctime_ns::bigint FROM "idx"."work"
           WHERE root_id = $1::bigint ORDER BY id LIMIT $2::bigint"#,
        &[&root_id, &limit],
    )?
    .into_iter()
    .map(|r| WorkRow {
        id: r.get(0),
        path: r.get(1),
        target_path: r.get(2),
        sha256: r.get(3),
        size: r.get(4),
        mtime_ns: r.get(5),
        inode: r.get(6),
        ctime_ns: r.get(7),
    })
    .collect())
}

/// Remove applied (or discarded) queue rows.
pub fn delete_work(c: &mut Client, ids: &[i64]) -> Result<u64> {
    if ids.is_empty() {
        return Ok(0);
    }
    Ok(c.execute(r#"DELETE FROM "idx"."work" WHERE id = ANY($1::bigint[])"#, &[&ids])?)
}

/// Live rows at or below `path`, for comparing one folder against the disk.
pub fn subtree_manifest(c: &mut Client, root_id: i64, path: &str) -> Result<HashMap<String, ManifestRow>> {
    let prefix = format!("{path}/");
    let rows = c.query(
        r#"SELECT path, size::bigint, mtime_ns::bigint, text_status, sha256 FROM "idx"."files"
           WHERE root_id = $1::bigint AND deleted_at IS NULL AND (path = $2 OR starts_with(path, $3))"#,
        &[&root_id, &path, &prefix],
    )?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.get(0),
                ManifestRow {
                    size: r.get(1),
                    mtime_ns: r.get(2),
                    status: r.get(3),
                    deleted: false,
                    sha256: r.get(4),
                    image_embedded: false,
                    thumbnail_failed: false,
                },
            )
        })
        .collect())
}

/// The database's clock, which `last_seen` is written with.
/// The installation's id, which the files folder's `.fdrive-files` marker must hold; `None`
/// until the API has recorded it.
pub fn installation_id(c: &mut Client) -> Result<Option<String>> {
    Ok(c.query_opt(
        r#"SELECT installation_id::text FROM "app"."backup_configuration" WHERE id = 1"#,
        &[],
    )?
    .map(|row| row.get(0)))
}

pub fn now(c: &mut Client) -> Result<DateTime<Utc>> {
    Ok(c.query_one("SELECT now()", &[])?.get(0))
}

/// Move the folder rows at and below `old` to `new`, replacing rows already there.
fn rename_folders(tx: &mut postgres::Transaction<'_>, root_id: i64, old: &str, new: &str) -> Result<()> {
    let old_prefix = format!("{old}/");
    let rest = old.chars().count() as i32 + 1;
    let name = crate::paths::basename(new);
    tx.execute(
        r#"DELETE FROM "idx"."folders" d USING "idx"."folders" s
           WHERE d.root_id = $1::bigint AND s.root_id = $1::bigint AND (s.path = $2 OR starts_with(s.path, $3))
           AND d.path = $4 || substr(s.path, $5::int)"#,
        &[&root_id, &old, &old_prefix, &new, &rest],
    )?;
    tx.execute(
        r#"UPDATE "idx"."folders" SET path = $4 || substr(path, $5::int),
           name = CASE WHEN path = $2 THEN $6 ELSE name END, seen_at = now()
           WHERE root_id = $1::bigint AND (path = $2 OR starts_with(path, $3))"#,
        &[&root_id, &old, &old_prefix, &new, &rest, &name],
    )?;
    Ok(())
}

/// One folder as a walk found it: root-relative path and modification time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRow {
    pub path: String,
    pub mtime_ns: i64,
}

/// Write the folders a walk found. With `sweep`, a root-relative folder (`""` for the whole
/// root) and when the walk started, also drop the rows below that folder the walk did not
/// write: everything it found was written after it started. Returns rows dropped.
pub fn sync_folders(
    c: &mut Client,
    root_id: i64,
    found: &[FolderRow],
    sweep: Option<(&str, DateTime<Utc>)>,
) -> Result<u64> {
    // One statement cannot write a row twice, and two names that are not valid UTF-8 can read
    // the same.
    let mut unique: Vec<&FolderRow> = found.iter().collect();
    unique.sort_by(|a, b| a.path.cmp(&b.path));
    unique.dedup_by(|a, b| a.path == b.path);
    let mut tx = c.transaction()?;
    for batch in unique.chunks(SWEEP_BATCH) {
        let paths: Vec<&str> = batch.iter().map(|f| f.path.as_str()).collect();
        let names: Vec<&str> = batch.iter().map(|f| crate::paths::basename(&f.path)).collect();
        let mtimes: Vec<i64> = batch.iter().map(|f| f.mtime_ns).collect();
        tx.execute(
            r#"INSERT INTO "idx"."folders" (root_id, path, name, mtime_ns)
               SELECT $1::bigint, p, n, m FROM unnest($2::text[], $3::text[], $4::bigint[]) AS t(p, n, m)
               ON CONFLICT (root_id, path) DO UPDATE
               SET name = EXCLUDED.name, mtime_ns = EXCLUDED.mtime_ns, seen_at = now()"#,
            &[&root_id, &paths, &names, &mtimes],
        )?;
    }
    let dropped = match sweep {
        Some((under, started_at)) => {
            let prefix = format!("{under}/");
            tx.execute(
                r#"DELETE FROM "idx"."folders" WHERE root_id = $1::bigint AND seen_at < $2
                   AND ($3 = '' OR starts_with(path, $4))"#,
                &[&root_id, &started_at, &under, &prefix],
            )?
        }
        None => 0,
    };
    tx.commit()?;
    Ok(dropped)
}
