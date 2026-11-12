//! SigLIP 2 (`google/siglip2-large-patch16-256`): a vision tower and a text
//! tower that embed into one space.

use std::path::Path;
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use tokenizers::{Tokenizer, TruncationParams};

use super::{Runtime, require};
use crate::image::{ImageEmbedError, ImageEmbedder, decode_rgb, prepare_query, preprocess};

/// The fixed-resolution model's input edge, from its `preprocessor_config.json`.
const IMAGE_SIZE: u32 = 256;
/// The text tower has exactly this many positions. The tokenizer file pads
/// every query to it, and the last position is what the model pools.
const TEXT_LENGTH: usize = 64;
const DIM: usize = 1024;
/// One image per inference call. The quantized vision tower picks its number
/// ranges from everything in the call, so in a larger batch an image's vector
/// would depend on which other images it arrived with.
const BATCH_SIZE: usize = 1;
const OUTPUT: &str = "pooler_output";

pub struct SiglipEmbedder {
    model_id: &'static str,
    tokenizer: Tokenizer,
    vision: Mutex<Session>,
    text: Mutex<Session>,
}

impl SiglipEmbedder {
    pub fn load(runtime: &Runtime, dir: &Path, model_id: &'static str) -> Result<Self, String> {
        let mut tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|error| error.to_string())?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: TEXT_LENGTH,
                ..Default::default()
            }))
            .map_err(|error| error.to_string())?;
        let vision = runtime.session(&dir.join("onnx/vision_model_quantized.onnx"))?;
        require(&vision, &["pixel_values"], OUTPUT)?;
        let text = runtime.session(&dir.join("onnx/text_model.onnx"))?;
        require(&text, &["input_ids"], OUTPUT)?;
        Ok(Self {
            model_id,
            tokenizer,
            vision: Mutex::new(vision),
            text: Mutex::new(text),
        })
    }
}

/// Runs one single-input session and splits its pooled output into rows.
fn pooled<T>(
    session: &Mutex<Session>,
    input: &str,
    tensor: Tensor<T>,
    rows: usize,
) -> Result<Vec<Vec<f32>>, ImageEmbedError>
where
    T: ort::value::PrimitiveTensorElementType + std::fmt::Debug + 'static,
{
    let backend = |error: String| ImageEmbedError::Backend(error);
    let mut session = session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let outputs = session
        .run(ort::inputs![input => tensor])
        .map_err(|error| backend(error.to_string()))?;
    let output = outputs
        .get(OUTPUT)
        .ok_or_else(|| backend(format!("model returned no {OUTPUT}")))?;
    let (_, data) = output
        .try_extract_tensor::<f32>()
        .map_err(|error| backend(error.to_string()))?;
    if data.len() != rows * DIM {
        return Err(backend("model returned an unexpected shape".into()));
    }
    Ok(data.as_chunks::<DIM>().0.iter().map(|row| row.to_vec()).collect())
}

impl ImageEmbedder for SiglipEmbedder {
    fn model_id(&self) -> &str {
        self.model_id
    }

    fn dim(&self) -> usize {
        DIM
    }

    fn embed_images(&self, images: &[Vec<u8>]) -> Result<Vec<Vec<f32>>, ImageEmbedError> {
        let size = IMAGE_SIZE as usize;
        let mut vectors = Vec::with_capacity(images.len());
        for batch in images.chunks(BATCH_SIZE) {
            let mut pixels = Vec::with_capacity(batch.len() * 3 * size * size);
            for raw in batch {
                pixels.extend(preprocess(&decode_rgb(raw)?, IMAGE_SIZE));
            }
            let tensor = Tensor::from_array(([batch.len(), 3, size, size], pixels))
                .map_err(|error| ImageEmbedError::Backend(error.to_string()))?;
            vectors.extend(pooled(&self.vision, "pixel_values", tensor, batch.len())?);
        }
        Ok(vectors)
    }

    fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ImageEmbedError> {
        let backend = |error: String| ImageEmbedError::Backend(error);
        let encodings = self
            .tokenizer
            .encode_batch(texts.iter().map(|text| prepare_query(text)).collect::<Vec<_>>(), true)
            .map_err(|error| backend(error.to_string()))?;
        if encodings.iter().any(|encoding| encoding.get_ids().len() != TEXT_LENGTH) {
            return Err(backend(format!("tokenizer did not pad to {TEXT_LENGTH} tokens")));
        }
        let ids: Vec<i64> = encodings
            .iter()
            .flat_map(|encoding| encoding.get_ids().iter().map(|id| i64::from(*id)))
            .collect();
        let tensor =
            Tensor::from_array(([texts.len(), TEXT_LENGTH], ids)).map_err(|error| backend(error.to_string()))?;
        pooled(&self.text, "input_ids", tensor, texts.len())
    }
}
