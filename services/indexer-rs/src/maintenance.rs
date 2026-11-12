//! Background maintenance passes: thumbnail and image-embedding rebuilds, the three
//! clears, and failure retries. They share one admission lock (see `jobs`).

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use regex::Regex;

use crate::db;
use crate::failures::{self, Report, attempt, describe};
use crate::fsx;
use crate::image_embed;
use crate::indexer::{RootContext, embed_missing, process_image_embedding, process_inner, process_thumbnails};
use crate::jobs::Job;
use crate::log::log;
use crate::paths::{basename, ext_of};
use crate::thumbs::{SIZES, is_thumbnail_candidate, normalize_scope, skip_reason, storage_path};
use crate::thumbs_io;

pub const BATCH_SIZE: i64 = 250;

type MediaRow = (String, String, String, i64);

fn revision(contexts: &[Arc<RootContext>]) -> i64 {
    contexts.iter().map(|c| c.features().revision).max().unwrap_or(0)
}

fn ids(feature: &str, job: &Job) -> HashMap<String, String> {
    [(feature.to_owned(), job.run_id())].into_iter().collect()
}

pub fn thumbnail_candidates(ctx: &RootContext, path: Option<&str>) -> Result<Vec<MediaRow>> {
    let scope = normalize_scope(path);
    Ok(ctx
        .db
        .with(|c| db::media_files(c, ctx.root_id))?
        .into_iter()
        .filter(|(rel, ext, _, _)| is_thumbnail_candidate(ext, rel, &scope))
        .collect())
}

/// Regenerate thumbnails for live media in `rows`. Never touches text, chunks or embeddings.
pub fn rebuild_thumbnails(ctx: &RootContext, rows: &[MediaRow], force: bool, job: &Job) {
    for (rel, ext, sha, size) in rows {
        ctx.maybe_refresh_features();
        if !ctx.values().internal_thumbnails() {
            log("thumbnail rebuild stopped: feature disabled");
            break;
        }
        let size = u64::try_from(*size).unwrap_or(0);
        if let Some(reason) = skip_reason(size, ctx.cfg.thumb_max_bytes) {
            log(&format!("thumb rebuild: skip {rel}: {reason}"));
            job.advance(true, true);
            continue;
        }
        let opened = match crate::indexer::open_source(ctx, rel) {
            Ok(opened) => opened,
            Err(e) => {
                let reason = describe(&e);
                log(&format!("thumb rebuild: cannot open {rel}: {reason}"));
                failures::report(&ctx.db, ctx.root_id, rel, "thumbnails", failures::failed(&reason));
                job.advance(false, false);
                continue;
            }
        };
        let abs = opened.path();
        let generation = thumbs_io::generate(
            &abs,
            ext,
            sha,
            size,
            &ctx.cfg.thumbs_dir,
            ctx.cfg.thumb_max_bytes,
            force,
            &log,
        );
        if generation.skipped.is_some() {
            failures::report(&ctx.db, ctx.root_id, rel, "thumbnails", failures::resolving_skip());
            job.advance(true, true);
            continue;
        }
        let mut reason = generation.error.clone();
        for thumb in &generation.thumbs {
            if let Err(e) = ctx
                .db
                .with(|c| db::upsert_thumbnail(c, sha, thumb.size, &thumb.rel_path, thumb.width, thumb.height))
            {
                log(&format!(
                    "thumb rebuild: unexpected failure for {rel}: {}",
                    describe(&e)
                ));
                reason.get_or_insert_with(|| describe(&e));
            }
        }
        let complete = generation
            .thumbs
            .iter()
            .map(|t| t.size)
            .collect::<std::collections::HashSet<_>>()
            == SIZES.into_iter().collect();
        let ok = complete && reason.is_none();
        let message =
            (!ok).then(|| reason.unwrap_or_else(|| "Incomplete thumbnail: required sizes were not saved".to_owned()));
        failures::report(
            &ctx.db,
            ctx.root_id,
            rel,
            "thumbnails",
            Report {
                error: message.as_deref(),
                ..Report::default()
            },
        );
        job.advance(ok, false);
    }
}

pub fn start_thumbnail_rebuild(
    job: &Arc<Job>,
    contexts: Vec<Arc<RootContext>>,
    path: Option<String>,
    force: bool,
) -> bool {
    crate::jobs::spawn(job, revision(&contexts), "thumbnail-rebuild", move |job| {
        let mut inventory = Vec::new();
        for ctx in &contexts {
            match thumbnail_candidates(ctx, path.as_deref()) {
                Ok(rows) => inventory.push((ctx, rows)),
                Err(e) => {
                    job.fail();
                    log(&format!("thumbnail-rebuild job crashed: {}", describe(&e)));
                    return;
                }
            }
        }
        job.discover(inventory.iter().map(|(_, rows)| rows.len() as u64).sum());
        job.discovered();
        for (ctx, rows) in inventory {
            if !ctx.values().internal_thumbnails() {
                continue;
            }
            attempt(ids("thumbnails", job), || rebuild_thumbnails(ctx, &rows, force, job));
            let _ = failures::prune(&ctx.db);
        }
    })
}

/// Backfill image embeddings, or with `force` replace another model's rows. Never writes
/// anything when the unit fails its health guard.
pub fn rebuild_image_embeddings(ctx: &RootContext, rows: &[MediaRow], force: bool, job: &Job) {
    let url = &ctx.cfg.image_embed_url;
    if url.is_empty() {
        return;
    }
    let health = image_embed::health(url, std::time::Duration::from_secs(5));
    if let Some(guard) = image_embed::dimension_guard(health.as_ref()) {
        log(&format!("image embedding rebuild: {guard}; skipping"));
        return;
    }
    let configured = health.and_then(|h| h.model).unwrap_or_default();
    let batch = ctx.cfg.image_embed_batch_size.max(1);
    let mut pending: Vec<(String, String)> = Vec::new();
    let flush = |pending: &mut Vec<(String, String)>| {
        let mut data = Vec::new();
        let mut opened = Vec::new();
        let mut reasons: HashMap<String, String> = HashMap::new();
        for (sha, _) in pending.iter() {
            let thumb = ctx.cfg.thumbs_dir.join(storage_path(sha, 256));
            match std::fs::read(&thumb) {
                Ok(bytes) => {
                    data.push(bytes);
                    opened.push(sha.clone());
                }
                Err(e) => {
                    log(&format!(
                        "image embedding rebuild: cannot read thumbnail for {sha}: {e}"
                    ));
                    reasons.insert(sha.clone(), format!("OSError: {e}"));
                }
            }
        }
        let mut succeeded = std::collections::HashSet::new();
        if !opened.is_empty() {
            let embedded = image_embed::embed_images(&data, url, batch).and_then(|(vectors, model)| {
                for (sha, vector) in opened.iter().zip(&vectors) {
                    ctx.db.with(|c| db::upsert_image_embedding(c, sha, &model, vector))?;
                    succeeded.insert(sha.clone());
                }
                Ok(())
            });
            if let Err(e) = embedded {
                log(&format!(
                    "image embedding rebuild: embed request failed: {}",
                    describe(&e)
                ));
                for sha in &opened {
                    reasons.entry(sha.clone()).or_insert_with(|| describe(&e));
                }
            }
        }
        for (sha, rel) in pending.drain(..) {
            let ok = succeeded.contains(&sha);
            let reason = reasons
                .get(&sha)
                .cloned()
                .unwrap_or_else(|| "Embedding unavailable: no vector returned".to_owned());
            failures::report(
                &ctx.db,
                ctx.root_id,
                &rel,
                "imageSearch",
                Report {
                    error: (!ok).then_some(reason.as_str()),
                    ..Report::default()
                },
            );
            job.advance(ok, false);
        }
    };
    for (rel, _, sha, _) in rows {
        ctx.maybe_refresh_features();
        if !ctx.values().image_search {
            log("image embedding rebuild stopped: feature disabled");
            break;
        }
        let existing = ctx.db.with(|c| db::image_embedding_model(c, sha)).ok().flatten();
        if !image_embed::rebuild_needs_embedding(existing.as_deref(), &configured, force) {
            failures::report(&ctx.db, ctx.root_id, rel, "imageSearch", failures::ok());
            job.advance(true, true);
            continue;
        }
        pending.push((sha.clone(), rel.clone()));
        if pending.len() >= batch {
            flush(&mut pending);
        }
    }
    flush(&mut pending);
}

pub fn start_image_rebuild(job: &Arc<Job>, contexts: Vec<Arc<RootContext>>, path: Option<String>, force: bool) -> bool {
    crate::jobs::spawn(job, revision(&contexts), "image-embed-rebuild", move |job| {
        let scope = normalize_scope(path.as_deref());
        let mut inventory = Vec::new();
        for ctx in contexts.iter().filter(|c| !c.cfg.image_embed_url.is_empty()) {
            match ctx.db.with(|c| db::media_files(c, ctx.root_id)) {
                Ok(rows) => inventory.push((
                    ctx,
                    rows.into_iter()
                        .filter(|(rel, ext, _, _)| image_embed::is_rebuild_candidate(ext, rel, &scope))
                        .collect::<Vec<_>>(),
                )),
                Err(e) => {
                    job.fail();
                    log(&format!("image-embed-rebuild job crashed: {}", describe(&e)));
                    return;
                }
            }
        }
        job.discover(inventory.iter().map(|(_, rows)| rows.len() as u64).sum());
        job.discovered();
        for (ctx, rows) in inventory {
            if !ctx.values().image_search {
                continue;
            }
            attempt(ids("imageSearch", job), || {
                rebuild_image_embeddings(ctx, &rows, force, job)
            });
            let _ = failures::prune(&ctx.db);
        }
    })
}

/// Delete `idx.files` rows (and, by cascade, chunks) in a scope. Originals, roots, history,
/// tags and thumbnails stay. `%` and `_` in names are literal.
pub fn clear_index(contexts: &[Arc<RootContext>], scope: Option<&str>, job: &Job) -> Result<()> {
    let prefix = scope.map(|s| format!("{s}/"));
    for ctx in contexts {
        let upper: i64 = ctx.db.with(|c| {
            Ok(c.query_one(
                "SELECT coalesce(max(id), 0)::bigint FROM idx.files WHERE root_id = $1::bigint",
                &[&ctx.root_id],
            )?
            .get(0))
        })?;
        let mut after = 0_i64;
        loop {
            let rows: Vec<(i64, String)> = ctx.db.with(|c| {
                Ok(c.query(
                    "SELECT id::bigint, path FROM idx.files WHERE root_id = $1::bigint AND id > $2::bigint AND id <= $3::bigint \
                     AND ($4::text IS NULL OR path = $4 OR starts_with(path, $5)) ORDER BY id LIMIT $6::bigint",
                    &[&ctx.root_id, &after, &upper, &scope, &prefix, &BATCH_SIZE],
                )?
                .into_iter()
                .map(|r| (r.get(0), r.get(1)))
                .collect())
            })?;
            if rows.is_empty() {
                break;
            }
            job.discover(rows.len() as u64);
            for (id, path) in rows {
                after = id;
                let _guard = ctx.path_locks.get(&path);
                let deleted = ctx.db.with(|c| {
                    c.execute(
                        "DELETE FROM idx.files WHERE root_id = $1::bigint AND id = $2::bigint AND path = $3",
                        &[&ctx.root_id, &id, &path],
                    )?;
                    Ok(())
                });
                if let Err(e) = &deleted {
                    log(&format!("index clear failed for {path}: {}", describe(e)));
                }
                job.advance(deleted.is_ok(), false);
            }
        }
    }
    Ok(())
}

fn preview_name() -> Regex {
    Regex::new(r"\A([0-9a-f]{64})\.(256|1024)\.webp\z").unwrap_or_else(|_| unreachable!("static pattern"))
}

/// Clear the shared preview cache and its manifest, then orphan previews in the generated
/// layout. A failed removal keeps its manifest row for a later retry.
pub fn clear_thumbnails(contexts: &[Arc<RootContext>], job: &Job) -> Result<()> {
    let Some(ctx) = contexts.first() else { return Ok(()) };
    let cache = match fsx::open_dir_nofollow(&ctx.cfg.thumbs_dir) {
        Ok(fd) => Some(fd),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let upper: Option<(String, i64)> = ctx.db.with(|c| {
        Ok(c.query_opt(
            "SELECT content_key, size::bigint FROM app.thumbnails ORDER BY content_key DESC, size DESC LIMIT 1",
            &[],
        )?
        .map(|r| (r.get(0), r.get(1))))
    })?;
    if let Some(upper) = upper {
        let mut after = (String::new(), 0_i64);
        loop {
            let rows: Vec<(String, i64, String)> = ctx.db.with(|c| {
                Ok(c.query(
                    "SELECT content_key, size::bigint, storage_path FROM app.thumbnails \
                     WHERE (content_key, size) > ($1, $2::bigint) AND (content_key, size) <= ($3, $4::bigint) \
                     ORDER BY content_key, size LIMIT $5::bigint",
                    &[&after.0, &after.1, &upper.0, &upper.1, &BATCH_SIZE],
                )?
                .into_iter()
                .map(|r| (r.get(0), r.get(1), r.get(2)))
                .collect())
            })?;
            if rows.is_empty() {
                break;
            }
            job.discover(rows.len() as u64);
            for (key, size, relative) in rows {
                after = (key.clone(), size);
                let removed = match &cache {
                    Some(fd) => fsx::remove_below(fd, &relative),
                    None => Ok(()),
                }
                .and_then(|()| {
                    ctx.db.with(|c| {
                        c.execute(
                            "DELETE FROM app.thumbnails WHERE content_key = $1 AND size = $2::bigint AND storage_path = $3",
                            &[&key, &size, &relative],
                        )?;
                        Ok(())
                    })
                });
                if let Err(e) = &removed {
                    log(&format!("thumbnail clear failed for {relative}: {}", describe(e)));
                }
                job.advance(removed.is_ok(), false);
            }
        }
    }
    let Some(cache) = cache else { return Ok(()) };
    let pattern = preview_name();
    let shards = rustix::fs::Dir::read_from(&cache)?;
    for shard in shards.flatten() {
        let shard = shard.file_name().to_string_lossy().into_owned();
        if shard.len() != 2 || !shard.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            continue;
        }
        let fd = match rustix::fs::openat(
            &cache,
            shard.as_str(),
            rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => continue,
            Err(e) => {
                log(&format!("cannot inspect thumbnail shard {shard}: {e}"));
                job.discover(1);
                job.advance(false, false);
                continue;
            }
        };
        let names: Vec<String> = match rustix::fs::Dir::read_from(&fd) {
            Ok(dir) => dir
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(e) => {
                log(&format!("cannot inspect thumbnail shard {shard}: {e}"));
                job.discover(1);
                job.advance(false, false);
                continue;
            }
        };
        for name in names {
            let Some(found) = pattern.captures(&name) else { continue };
            if !found[1].starts_with(&shard) {
                continue;
            }
            let relative = format!("{shard}/{name}");
            let listed = ctx
                .db
                .with(|c| {
                    Ok(c.query_opt(
                        "SELECT 1 FROM app.thumbnails WHERE storage_path = $1 LIMIT 1",
                        &[&relative],
                    )?
                    .is_some())
                })
                .unwrap_or(true);
            if listed {
                // A failed manifest entry stays retryable without counting it twice.
                continue;
            }
            job.discover(1);
            let removed = fsx::remove_below(&cache, &relative);
            if let Err(e) = &removed {
                log(&format!(
                    "orphan thumbnail clear failed for {relative}: {}",
                    describe(e)
                ));
            }
            job.advance(removed.is_ok(), false);
        }
    }
    Ok(())
}

/// Delete every `app.image_embeddings` row in key order, bounded by the key that was
/// largest at the start so rows added meanwhile are never visited.
pub fn clear_image_embeddings(contexts: &[Arc<RootContext>], job: &Job) -> Result<()> {
    let Some(ctx) = contexts.first() else { return Ok(()) };
    let upper: Option<String> = ctx.db.with(|c| {
        Ok(c.query_one("SELECT max(content_key) FROM app.image_embeddings", &[])?
            .get(0))
    })?;
    let Some(upper) = upper else { return Ok(()) };
    let mut after = String::new();
    loop {
        let keys: Vec<String> = ctx.db.with(|c| {
            Ok(c.query(
                "SELECT content_key FROM app.image_embeddings WHERE content_key > $1 AND content_key <= $2 \
                 ORDER BY content_key LIMIT $3::bigint",
                &[&after, &upper, &BATCH_SIZE],
            )?
            .into_iter()
            .map(|r| r.get(0))
            .collect())
        })?;
        if keys.is_empty() {
            break;
        }
        job.discover(keys.len() as u64);
        for key in keys {
            after = key.clone();
            let deleted = ctx.db.with(|c| {
                c.execute("DELETE FROM app.image_embeddings WHERE content_key = $1", &[&key])?;
                Ok(())
            });
            if let Err(e) = &deleted {
                log(&format!("image embedding clear failed for {key}: {}", describe(e)));
            }
            job.advance(deleted.is_ok(), false);
        }
    }
    Ok(())
}

pub fn start_clear(job: &Arc<Job>, name: &'static str, run: impl FnOnce(&Job) -> Result<()> + Send + 'static) -> bool {
    crate::jobs::spawn(job, 0, "indexer-clear", move |job| {
        if let Err(e) = run(job) {
            job.fail();
            log(&format!("clear job failed ({name}): {}", describe(&e)));
        }
    })
}

/// Retry one unresolved file for one feature. Returns `(ok, skipped)`.
pub fn retry_file(ctx: &Arc<RootContext>, path: &str, feature: &str) -> (bool, bool) {
    let (outcome, observed) = attempt(HashMap::new(), || -> Result<Option<(bool, bool)>> {
        let parts = fsx::path_parts(&format!("/{}", path.trim_start_matches('/'))).map_err(anyhow::Error::msg)?;
        // `embed_missing` takes the path lock itself and checks the content under it.
        let _guard = (feature != "semanticSearch").then(|| ctx.path_locks.get(path));
        let mut opened = fsx::open_file(&ctx.abs_path, &parts)?;
        let source = opened.path();
        let metadata = std::fs::metadata(&source)?;
        let sha = fsx::sha256_of_file(&mut opened.file)?;
        // `/dev/fd/N` (macOS) shares this descriptor's offset; readers of `source` start at 0.
        std::io::Seek::rewind(&mut opened.file)?;
        let stat = crate::indexer::FileStat::of(&metadata);
        match feature {
            "semanticSearch" => {
                let ok = embed_missing(ctx, path, Some(&sha))?;
                Ok(Some((ok, !ok)))
            }
            "textSearch" => {
                process_inner(ctx, &source, path, stat, Some(sha), Some("textSearch"))?;
                Ok(None)
            }
            _ => {
                // A changed original invalidates old text before a new derivative is published.
                if ctx.db.with(|c| db::file_content_key(c, ctx.root_id, path))?.as_deref() != Some(sha.as_str()) {
                    let name = basename(path);
                    ctx.db.with(|c| {
                        db::upsert_file(
                            c,
                            &db::NewFile {
                                root_id: ctx.root_id,
                                path,
                                name,
                                ext: &ext_of(name),
                                size: opened.size as i64,
                                mtime_ns: stat.mtime_ns,
                                sha256: &sha,
                                mime: None,
                            },
                        )
                    })?;
                }
                if feature == "thumbnails" {
                    return Ok(Some(process_thumbnails(
                        ctx,
                        &source,
                        path,
                        &ext_of(path),
                        &sha,
                        opened.size,
                        true,
                    )));
                }
                process_image_embedding(ctx, path, &sha);
                Ok(None)
            }
        }
    });
    match outcome {
        Ok(Some(result)) => observed.outcomes.get(feature).copied().unwrap_or(result),
        Ok(None) => observed.outcomes.get(feature).copied().unwrap_or((true, true)),
        Err(e) => {
            let reason = describe(&e);
            log(&format!("retry {feature} {path}: {reason}"));
            if observed.outcomes.get(feature).is_none_or(|(ok, _)| *ok) {
                failures::report(&ctx.db, ctx.root_id, path, feature, failures::failed(&reason));
            }
            (false, false)
        }
    }
}

/// Retry a fixed inventory of unresolved failures for `feature`, optionally one id.
pub fn start_retry(job: &Arc<Job>, contexts: Vec<Arc<RootContext>>, feature: String, failure_id: Option<i64>) -> bool {
    crate::jobs::spawn(job, revision(&contexts), "failure-retry", move |job| {
        let mut inventory = Vec::new();
        for ctx in &contexts {
            let rows: Result<Vec<(i64, String)>> = ctx.db.with(|c| {
                Ok(c.query(
                    "SELECT id::bigint, path FROM idx.processing_failures WHERE root_id = $1::bigint AND feature = $2 \
                     AND resolved_at IS NULL AND ($3::bigint IS NULL OR id = $3) ORDER BY id",
                    &[&ctx.root_id, &feature, &failure_id],
                )?
                .into_iter()
                .map(|r| (r.get(0), r.get(1)))
                .collect())
            });
            match rows {
                Ok(rows) => {
                    job.discover(rows.len() as u64);
                    inventory.push((ctx, rows));
                }
                Err(e) => {
                    job.fail();
                    log(&format!("failure retry crashed: {}", describe(&e)));
                    return;
                }
            }
        }
        job.discovered();
        'roots: for (ctx, rows) in inventory {
            for (id, path) in rows {
                ctx.maybe_refresh_features();
                if !ctx.values().get(&feature) {
                    break 'roots;
                }
                let open = ctx
                    .db
                    .with(|c| {
                        Ok(c.query_opt(
                            "SELECT 1 FROM idx.processing_failures WHERE id = $1::bigint AND resolved_at IS NULL",
                            &[&id],
                        )?
                        .is_some())
                    })
                    .unwrap_or(false);
                if !open {
                    job.advance(true, true);
                    continue;
                }
                let ((ok, skipped), _) = attempt(ids(&feature, job), || retry_file(ctx, &path, &feature));
                job.advance(ok, skipped);
            }
        }
        for ctx in &contexts {
            let _ = failures::prune(&ctx.db);
        }
    })
}
