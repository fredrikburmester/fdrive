//! The real model backends, on ONNX Runtime.
//!
//! Nothing here is exercised by the unit tests, which never load model
//! weights; the `TextEmbedder` and `ImageEmbedder` traits plus fakes cover
//! everything downstream. `tests/models.rs` probes these against the real
//! models when asked to.

mod e5;
mod siglip;

use std::path::Path;
use std::sync::Arc;

use ort::environment::{Environment, GlobalThreadPoolOptions};
use ort::session::Session;
use ort::session::builder::AutoDevicePolicy;
use tokio::runtime::Handle;

pub use self::e5::E5Embedder;
pub use self::siglip::SiglipEmbedder;
use crate::hub::{Hub, IMAGE_MODEL, TEXT_MODEL};
use crate::image::ImageEmbedder;
use crate::text::TextEmbedder;

/// What every model load needs: the shared ONNX Runtime environment and the
/// hub the weights come from.
pub struct Runtime {
    environment: Environment,
    hub: Hub,
    handle: Handle,
}

impl Runtime {
    /// One thread pool for every session, so `threads` bounds the CPU all
    /// models use together rather than each taking that many.
    pub fn new(hub: Hub, threads: usize, handle: Handle) -> Result<Self, String> {
        let pool = GlobalThreadPoolOptions::default()
            .with_intra_threads(threads)
            .and_then(|pool| pool.with_spin_control(false))
            .map_err(|error| error.to_string())?;
        let environment = ort::init()
            .with_name("fdrive-ml")
            .with_global_thread_pool(pool)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            environment,
            hub,
            handle,
        })
    }

    /// Blocking: downloads what is missing, then loads the model.
    pub fn load_text(&self) -> Result<Arc<dyn TextEmbedder>, String> {
        let dir = self
            .handle
            .block_on(self.hub.ensure(&TEXT_MODEL))
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(E5Embedder::load(self, &dir, TEXT_MODEL.id)?))
    }

    /// Blocking: downloads what is missing, then loads both towers.
    pub fn load_image(&self) -> Result<Arc<dyn ImageEmbedder>, String> {
        let dir = self
            .handle
            .block_on(self.hub.ensure(&IMAGE_MODEL))
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(SiglipEmbedder::load(self, &dir, IMAGE_MODEL.id)?))
    }

    /// CPU only, on every platform. Left to itself ONNX Runtime picks CoreML
    /// on a Mac, and vectors must not depend on where the server runs.
    fn session(&self, model: &Path) -> Result<Session, String> {
        let describe = |error: String| format!("{}: {error}", model.display());
        Session::builder(&self.environment)
            .map_err(|error| describe(error.to_string()))?
            .with_auto_device(AutoDevicePolicy::PreferCPU)
            .map_err(|error| describe(error.to_string()))?
            .commit_from_file(model)
            .map_err(|error| describe(error.to_string()))
    }
}

fn has_input(session: &Session, name: &str) -> bool {
    session.inputs().iter().any(|input| input.name() == name)
}

fn require(session: &Session, inputs: &[&str], output: &str) -> Result<(), String> {
    for name in inputs {
        if !has_input(session, name) {
            return Err(format!("model has no input named {name}"));
        }
    }
    if !session.outputs().iter().any(|outlet| outlet.name() == output) {
        return Err(format!("model has no output named {output}"));
    }
    Ok(())
}
