//! Shared test support: one reusable Postgres container shared by every test binary, the
//! repository's migrations applied to a template database, and a fresh database cloned from
//! it per test. A container held in a static is never dropped, so it is named and reused
//! rather than started anew by every test binary.

#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use fdrive_indexer::config::Config;
use fdrive_indexer::features::{FeatureConfiguration, FeatureValues};
use fdrive_indexer::indexer::RootContext;
use postgres::{Client, NoTls};
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::SyncRunner;
use testcontainers::{Container, GenericImage, ImageExt, ReuseDirective};

struct Server {
    base: String,
    _container: Option<Container<GenericImage>>,
}

fn migrations_dir() -> PathBuf {
    std::env::var("FDRIVE_DB_MIGRATIONS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/db/drizzle"))
}

fn server() -> &'static Server {
    static SERVER: OnceLock<Server> = OnceLock::new();
    SERVER.get_or_init(|| {
        // FDRIVE_TEST_DATABASE_URL points at an existing server instead (no Docker needed).
        let (base, container) = match std::env::var("FDRIVE_TEST_DATABASE_URL") {
            Ok(url) => (url.trim_end_matches('/').to_owned(), None),
            Err(_) => {
                let container = GenericImage::new("pgvector/pgvector", "pg17")
                    .with_exposed_port(5432.tcp())
                    .with_wait_for(WaitFor::message_on_stderr(
                        "database system is ready to accept connections",
                    ))
                    .with_env_var("POSTGRES_PASSWORD", "fdrive")
                    .with_env_var("POSTGRES_USER", "fdrive")
                    .with_env_var("POSTGRES_DB", "postgres")
                    .with_container_name("fdrive-indexer-tests-postgres")
                    .with_reuse(ReuseDirective::Always)
                    .start()
                    .expect("start postgres");
                let host = container.get_host().expect("host");
                let port = container.get_host_port_ipv4(5432).expect("port");
                (format!("postgres://fdrive:fdrive@{host}:{port}"), Some(container))
            }
        };
        let admin = format!("{base}/postgres");
        let mut client = (0..60)
            .find_map(|_| {
                Client::connect(&admin, NoTls).ok().or_else(|| {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    None
                })
            })
            .expect("connect to postgres");
        // Databases earlier runs cloned stay in the reused container until here.
        let stale: Vec<String> = client
            .query("SELECT datname FROM pg_database WHERE datname LIKE 't\\_%'", &[])
            .unwrap()
            .into_iter()
            .map(|r| r.get(0))
            .collect();
        for name in stale {
            client
                .batch_execute(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
                .unwrap();
        }
        client
            .batch_execute("DROP DATABASE IF EXISTS fdrive_template WITH (FORCE)")
            .unwrap();
        client.batch_execute("CREATE DATABASE fdrive_template").unwrap();
        let mut template = Client::connect(&format!("{base}/fdrive_template"), NoTls).unwrap();
        let mut files: Vec<PathBuf> = std::fs::read_dir(migrations_dir())
            .expect("migrations directory")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|e| e == "sql"))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no migrations found");
        for file in files {
            for statement in std::fs::read_to_string(&file)
                .unwrap()
                .split("--> statement-breakpoint")
            {
                if !statement.trim().is_empty() {
                    template
                        .batch_execute(statement)
                        .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
                }
            }
        }
        drop(template);
        Server {
            base,
            _container: container,
        }
    })
}

/// A fresh, migrated database; returns its URL.
pub fn database() -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let server = server();
    let name = format!("t_{}_{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst));
    let mut admin = Client::connect(&format!("{}/postgres", server.base), NoTls).unwrap();
    admin
        .batch_execute(&format!("CREATE DATABASE {name} TEMPLATE fdrive_template"))
        .unwrap();
    format!("{}/{name}", server.base)
}

pub fn connect(url: &str) -> Client {
    Client::connect(url, NoTls).unwrap()
}

/// Records the installation id and writes `root`'s `.fdrive-files` marker with it, as the API
/// does when it first accepts the files folder. Returns the id.
pub fn mark_files_folder(url: &str, root: &std::path::Path) -> String {
    let id: String = connect(url)
        .query_one(
            "INSERT INTO app.backup_configuration (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1 \
             RETURNING installation_id::text",
            &[],
        )
        .unwrap()
        .get(0);
    std::fs::write(root.join(fdrive_indexer::files_marker::FILES_MARKER), format!("{id}\n")).unwrap();
    id
}

pub fn all_features() -> FeatureValues {
    FeatureValues {
        thumbnails: true,
        text_search: true,
        search_ocr: false,
        semantic_search: true,
        image_search: true,
        pdf_ocr: false,
    }
}

pub fn features(values: FeatureValues) -> FeatureConfiguration {
    FeatureConfiguration { revision: 1, values }
}

/// Config for a test root at `root` with thumbnails in `thumbs`; `ml` is the fake server's URL.
pub fn config(url: &str, root: &std::path::Path, thumbs: &std::path::Path, ml: &str) -> Arc<Config> {
    let mut cfg = Config::from_vars(|_| None).unwrap();
    cfg.database_url = url.to_owned();
    cfg.roots = vec![("r".to_owned(), root.to_path_buf())];
    cfg.thumbs_dir = thumbs.to_path_buf();
    cfg.embed_url = format!("{ml}/text");
    cfg.tika_url = format!("{ml}/extract");
    cfg.image_embed_url = format!("{ml}/image");
    cfg.workers = 2;
    Arc::new(cfg)
}

/// A root context registered in the database, with the given features.
pub fn context(cfg: &Arc<Config>, values: FeatureValues) -> Arc<RootContext> {
    let (name, path) = cfg.roots[0].clone();
    mark_files_folder(&cfg.database_url, &path);
    let mut client = connect(&cfg.database_url);
    let root_id = fdrive_indexer::db::upsert_root(&mut client, &name).unwrap();
    Arc::new(RootContext::new(
        &name,
        root_id,
        path,
        Arc::clone(cfg),
        features(values),
    ))
}

/// Write the feature document into `app.settings`.
pub fn save_features(url: &str, values: FeatureValues) {
    let document = serde_json::json!({"version": 1, "revision": 2, "values": values_json(values)});
    connect(url)
        .execute(
            "INSERT INTO app.settings (key, value) VALUES ('features.configuration', $1) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            &[&document],
        )
        .unwrap();
}

pub fn values_json(values: FeatureValues) -> serde_json::Value {
    FeatureConfiguration { revision: 0, values }.as_json()["values"].clone()
}

pub mod fake_ml;
pub mod root_env;
