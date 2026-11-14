//! `fdrive-indexer`: wait for the schema, start one loop per root, and serve the internal API.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use fdrive_indexer::config::Config;
use fdrive_indexer::db::{self, Db};
use fdrive_indexer::extract::ContentExtractor;
use fdrive_indexer::log::log;
use fdrive_indexer::names::NameIndex;
use fdrive_indexer::runner::{EXPECTED_SCHEMA_VERSION, build_context, refresh_settings, run_root};
use fdrive_indexer::server::{AppState, Jobs, Wake, router};
use fdrive_indexer::work::run_work;

fn main() -> Result<(), String> {
    let cfg = Arc::new(Config::from_env()?);
    let db = Db::new(&cfg.database_url);
    log(&format!(
        "waiting for idx.schema_version = {EXPECTED_SCHEMA_VERSION} (timeout {}s)",
        cfg.schema_wait.as_secs()
    ));
    let version = db::wait_for_schema_version(&db, EXPECTED_SCHEMA_VERSION, cfg.schema_wait, &log, &std::thread::sleep)
        .map_err(|e| e.to_string())?;
    let Some(version) = version else { std::process::exit(1) };
    log(&format!("schema ready at version {version}"));

    let mut contexts = Vec::new();
    for (name, path) in &cfg.roots {
        contexts.push(build_context(&cfg, name, path).map_err(|e| e.to_string())?);
    }
    // Built from the tables in the background; until then search finds names without typos.
    let root_ids: Vec<i64> = contexts.iter().map(|ctx| ctx.root_id).collect();
    let names = NameIndex::start(Db::new(&cfg.database_url), &root_ids).map_err(|e| e.to_string())?;
    for ctx in &contexts {
        let _ = ctx.names.set(Arc::clone(&names));
    }
    let watchers = Arc::new(Mutex::new(HashMap::new()));
    let mut wakes = HashMap::new();
    for ctx in &contexts {
        if let Err(e) = refresh_settings(ctx) {
            log(&format!("[{}] settings unavailable: {e}", ctx.name));
        }
        let wake = Arc::new(Wake::default());
        wakes.insert(ctx.name.clone(), Arc::clone(&wake));
        // Changes the API queues are applied beside the scan loop, never behind a scan.
        let queued = Arc::clone(ctx);
        std::thread::Builder::new()
            .name(format!("work-{}", queued.name))
            .spawn(move || run_work(queued))
            .map_err(|e| e.to_string())?;
        let (ctx, watchers) = (Arc::clone(ctx), Arc::clone(&watchers));
        std::thread::Builder::new()
            .name(format!("root-{}", ctx.name))
            .spawn(move || run_root(&ctx, &watchers, &wake))
            .map_err(|e| e.to_string())?;
    }

    let settings = cfg.default_settings();
    let state = Arc::new(AppState {
        contexts,
        watchers,
        wakes,
        db: Db {
            url: cfg.database_url.clone(),
            retries: 1,
        },
        content: Some(Arc::new(ContentExtractor::new(
            cfg.max_pdf_pages,
            cfg.plain_text_cap,
            &settings.tesseract_langs,
            &cfg.tika_url,
        ))),
        jobs: Jobs::default(),
        failure_retry_feature: Mutex::new("thumbnails".to_owned()),
        instance_id: uuid::Uuid::new_v4().to_string(),
        names: Some(names),
    });
    let names: Vec<&str> = cfg.roots.iter().map(|(name, _)| name.as_str()).collect();
    log(&format!("indexer up. roots={names:?} port={}", cfg.indexer_port));

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async move {
        // Compose network only; nothing here is authenticated.
        let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, cfg.indexer_port));
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .map_err(|e| e.to_string())?;
        axum::serve(listener, router(state))
            .with_graceful_shutdown(shutdown())
            .await
            .map_err(|e| e.to_string())
    })
}

async fn shutdown() {
    let interrupt = tokio::signal::ctrl_c();
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
    tokio::select! {
        _ = interrupt => {}
        _ = async { if let Some(t) = terminate.as_mut() { t.recv().await; } else { std::future::pending::<()>().await } } => {}
    }
}
