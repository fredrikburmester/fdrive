//! fdrive-indexer: walks the files folder, watches it for changes, extracts, chunks and
//! embeds text, builds thumbnails and image embeddings, and serves an internal HTTP API.
//! See `docs/INDEXER.md`.

pub mod activity;
pub mod backoff;
pub mod chunking;
pub mod config;
pub mod db;
pub mod extract;
pub mod failures;
pub mod features;
pub mod files_marker;
pub mod fsx;
pub mod http;
pub mod image_embed;
pub mod images;
pub mod indexer;
pub mod jobs;
pub mod journal;
pub mod locks;
pub mod log;
pub mod maintenance;
pub mod names;
pub mod paths;
pub mod photo;
pub mod promise;
pub mod raw;
pub mod rules;
pub mod runner;
pub mod server;
pub mod settings;
pub mod thumbs;
pub mod thumbs_io;
pub mod timestamps;
pub mod walk;
pub mod watcher;
pub mod work;
