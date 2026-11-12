//! One server for fdrive's model inference and document text extraction.
//!
//! Three units share the process: text embeddings, image embeddings and
//! document extraction. Each keeps the HTTP contract of the service it
//! replaces under its own path prefix, so callers only change a base URL.

pub mod config;
pub mod features;
pub mod http;
pub mod hub;
pub mod image;
pub mod lifecycle;
pub mod onnx;
pub mod supervisor;
pub mod text;
pub mod vector;
