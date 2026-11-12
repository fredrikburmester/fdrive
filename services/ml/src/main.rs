//! `fdrive-ml`: resolve config, wire the three units to their real
//! backends, start following the feature document, and serve.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use fdrive_ml::config::{Config, GateConfig};
use fdrive_ml::features::{Gate, HttpFeatureSource};
use fdrive_ml::http::{AppState, router};
use fdrive_ml::hub::Hub;
use fdrive_ml::lifecycle::{Unit, UnitKind, Units, inline_spawner, thread_spawner};
use fdrive_ml::onnx::Runtime;
use fdrive_ml::supervisor::{follow, keep_enabled};
use tokio::runtime::Handle;

#[tokio::main]
async fn main() -> Result<(), String> {
    init_logging();
    let config = Config::from_env()?;

    let hub = Hub::new(&config.hub_endpoint, &config.models_dir).map_err(|error| error.to_string())?;
    let runtime = Arc::new(Runtime::new(hub, config.threads, Handle::current())?);
    let (text_runtime, image_runtime) = (Arc::clone(&runtime), Arc::clone(&runtime));
    let units = Arc::new(Units {
        text: Unit::new(
            UnitKind::Text,
            Arc::new(move || text_runtime.load_text()),
            thread_spawner(),
        ),
        image: Unit::new(
            UnitKind::Image,
            Arc::new(move || image_runtime.load_image()),
            thread_spawner(),
        ),
        extract: Unit::new(UnitKind::Extract, Arc::new(|| Ok(())), inline_spawner()),
    });

    match config.gate {
        GateConfig::Static(kinds) => {
            tracing::warn!(?kinds, "feature gating is off; these units stay on");
            tokio::spawn(keep_enabled(
                Arc::clone(&units),
                kinds,
                std::time::Duration::from_secs(3),
            ));
        }
        GateConfig::Features {
            url,
            token,
            poll,
            stale,
            unreachable,
        } => {
            let source = HttpFeatureSource::new(url, token).map_err(|error| error.to_string())?;
            tokio::spawn(follow(source, Arc::clone(&units), poll, Gate::new(stale, unreachable)));
        }
    }

    let state = AppState::new(&config.version, units, config.threads, config.max_document_bytes);
    // Compose network only; nothing here is authenticated.
    let address = SocketAddr::from((Ipv4Addr::UNSPECIFIED, config.port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| error.to_string())?;
    tracing::info!(
        version = config.version,
        port = config.port,
        threads = config.threads,
        "fdrive-ml up"
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|error| error.to_string())
}

/// Plain lines for `docker logs`. ONNX Runtime narrates every session it
/// builds at info level, so only its warnings are kept.
fn init_logging() {
    use tracing::Level;
    use tracing_subscriber::filter::Targets;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let levels = Targets::new().with_default(Level::INFO).with_target("ort", Level::WARN);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_target(false).with_ansi(false))
        .with(levels)
        .init();
}

async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = terminate.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}
