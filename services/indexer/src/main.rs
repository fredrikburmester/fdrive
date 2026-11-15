//! `fdrive-indexer`: start the root loop and serve the internal API. Compose starts it after
//! the API is healthy, and the API runs every migration before it serves.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use fdrive_indexer::config::Config;
use fdrive_indexer::db::Db;
use fdrive_indexer::extract::ContentExtractor;
use fdrive_indexer::log::log;
use fdrive_indexer::names::NameIndex;
use fdrive_indexer::runner::{RootLoop, build_context, refresh_settings, run_root};
use fdrive_indexer::server::{AppState, Jobs, Wake, router};
use fdrive_indexer::work::run_work;

fn main() -> Result<(), String> {
    let cfg = Arc::new(Config::from_env()?);
    let ctx = build_context(&cfg).map_err(|e| e.to_string())?;
    // Built from the tables in the background; until then search finds names without typos.
    let names = NameIndex::start(Db::new(&cfg.database_url), &[ctx.root_id]).map_err(|e| e.to_string())?;
    let _ = ctx.names.set(Arc::clone(&names));
    if let Err(e) = refresh_settings(&ctx) {
        log(&format!("[{}] settings unavailable: {e}", ctx.name));
    }
    // Decided before the journal's reader takes its first position.
    let root = RootLoop::new(&ctx).map_err(|e| e.to_string())?;
    let watcher = Arc::new(AtomicBool::new(false));
    let wake = Arc::new(Wake::default());
    // Changes the API queues are applied beside the scan loop, never behind a scan.
    let queued = Arc::clone(&ctx);
    std::thread::Builder::new()
        .name("work-files".to_owned())
        .spawn(move || run_work(queued))
        .map_err(|e| e.to_string())?;
    {
        let (ctx, watcher, wake) = (Arc::clone(&ctx), Arc::clone(&watcher), Arc::clone(&wake));
        std::thread::Builder::new()
            .name("root-files".to_owned())
            .spawn(move || run_root(root, &ctx, &watcher, &wake))
            .map_err(|e| e.to_string())?;
    }

    let settings = cfg.default_settings();
    let state = Arc::new(AppState {
        context: ctx,
        watcher,
        wake,
        db: Db {
            url: cfg.database_url.clone(),
            retries: 1,
        },
        content: Some(Arc::new(ContentExtractor::new(
            cfg.max_pdf_pages,
            cfg.plain_text_cap,
            &settings.tesseract_langs,
            &cfg.extract_url(),
        ))),
        jobs: Jobs::default(),
        failure_retry_feature: Mutex::new("thumbnails".to_owned()),
        instance_id: uuid::Uuid::new_v4().to_string(),
        names: Some(names),
    });
    log(&format!("indexer up. port={}", cfg.indexer_port));

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
