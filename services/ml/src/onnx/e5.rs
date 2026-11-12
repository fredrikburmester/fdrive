//! `intfloat/multilingual-e5-small`: mean-pooled sentence embeddings.

use std::path::Path;
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

use super::{Runtime, has_input, require};
use crate::text::{TextEmbedError, TextEmbedder};
use crate::vector::mean_pool;

/// The model's position embeddings stop here.
const MAX_INPUT_LENGTH: usize = 512;
const OUTPUT: &str = "last_hidden_state";

pub struct E5Embedder {
    model_id: &'static str,
    /// Encodes whole inputs, for reporting one that is too long.
    tokenizer: Tokenizer,
    /// Cuts inputs to `MAX_INPUT_LENGTH`, special tokens kept.
    truncating: Tokenizer,
    session: Mutex<Session>,
    token_types: bool,
}

impl E5Embedder {
    pub fn load(runtime: &Runtime, dir: &Path, model_id: &'static str) -> Result<Self, String> {
        let mut tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(|error| error.to_string())?;
        let pad_token = "<pad>";
        let pad_id = tokenizer.token_to_id(pad_token).ok_or("tokenizer has no <pad> token")?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            pad_id,
            pad_token: pad_token.into(),
            ..Default::default()
        }));
        let mut truncating = tokenizer.clone();
        truncating
            .with_truncation(Some(TruncationParams {
                max_length: MAX_INPUT_LENGTH,
                ..Default::default()
            }))
            .map_err(|error| error.to_string())?;

        let session = runtime.session(&dir.join("onnx/model.onnx"))?;
        require(&session, &["input_ids", "attention_mask"], OUTPUT)?;
        let token_types = has_input(&session, "token_type_ids");
        Ok(Self {
            model_id,
            tokenizer,
            truncating,
            session: Mutex::new(session),
            token_types,
        })
    }
}

impl TextEmbedder for E5Embedder {
    fn model_id(&self) -> &str {
        self.model_id
    }

    fn max_input_length(&self) -> usize {
        MAX_INPUT_LENGTH
    }

    fn embed(&self, inputs: &[String], truncate: bool) -> Result<Vec<Vec<f32>>, TextEmbedError> {
        let backend = |error: String| TextEmbedError::Backend(error);
        let tokenizer = if truncate { &self.truncating } else { &self.tokenizer };
        let encodings = tokenizer
            .encode_batch(inputs.to_vec(), true)
            .map_err(|error| backend(error.to_string()))?;

        let batch = encodings.len();
        let tokens = encodings.first().map_or(0, |encoding| encoding.get_ids().len());
        if !truncate {
            // Padding makes every row as long as the longest, so count the
            // real tokens of each.
            let given = encodings
                .iter()
                .map(|encoding| encoding.get_attention_mask().iter().filter(|mask| **mask == 1).count())
                .max()
                .unwrap_or(0);
            if given > MAX_INPUT_LENGTH {
                return Err(TextEmbedError::TooLong {
                    given,
                    max: MAX_INPUT_LENGTH,
                });
            }
        }

        let flatten = |pick: fn(&tokenizers::Encoding) -> &[u32]| -> Vec<i64> {
            encodings
                .iter()
                .flat_map(|encoding| pick(encoding).iter().map(|id| i64::from(*id)))
                .collect()
        };
        let mask = flatten(|encoding| encoding.get_attention_mask());
        let tensor =
            |data: Vec<i64>| Tensor::from_array(([batch, tokens], data)).map_err(|error| backend(error.to_string()));

        let mut feeds = ort::inputs![
            "input_ids" => tensor(flatten(|encoding| encoding.get_ids()))?,
            "attention_mask" => tensor(mask.clone())?,
        ];
        if self.token_types {
            feeds.push((
                "token_type_ids".into(),
                tensor(flatten(|encoding| encoding.get_type_ids()))?.into(),
            ));
        }

        let mut session = self.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let outputs = session.run(feeds).map_err(|error| backend(error.to_string()))?;
        let hidden = outputs
            .get(OUTPUT)
            .ok_or_else(|| backend(format!("model returned no {OUTPUT}")))?;
        let (shape, data) = hidden
            .try_extract_tensor::<f32>()
            .map_err(|error| backend(error.to_string()))?;
        let dim = shape.last().copied().unwrap_or(0) as usize;
        mean_pool(data, &mask, batch, tokens, dim).ok_or_else(|| backend("model returned an unexpected shape".into()))
    }
}
