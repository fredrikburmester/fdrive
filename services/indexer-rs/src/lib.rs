//! fdrive-indexer: walks configured roots, watches them for changes, extracts, chunks and
//! embeds text, builds thumbnails and image embeddings, and serves an internal HTTP API.
//! See `docs/INDEXER.md`.

pub mod activity;
pub mod backoff;
pub mod chunking;
pub mod config;
pub mod db;
pub mod events;
pub mod failures;
pub mod features;
pub mod images;
pub mod jobs;
pub mod log;
pub mod paths;
pub mod promise;
pub mod raw;
pub mod rules;
pub mod settings;
pub mod thumbs;
pub mod thumbs_io;
pub mod watcher;
