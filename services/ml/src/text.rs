//! Text embeddings for semantic search. The HTTP contract is the subset of
//! Hugging Face's text-embeddings-inference that the indexer and API use.

use serde::Deserialize;

/// More inputs than this in one request is rejected, as TEI's default does.
pub const MAX_CLIENT_BATCH_SIZE: usize = 32;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TextEmbedError {
    #[error("`inputs` must have less than {max} tokens. Given: {given}")]
    TooLong { given: usize, max: usize },
    #[error("{0}")]
    Backend(String),
}

/// A loaded text embedding model. Returns one pooled, unnormalized vector
/// per input, in order.
pub trait TextEmbedder: Send + Sync {
    fn model_id(&self) -> &str;
    /// The most tokens one input may have, special tokens included.
    fn max_input_length(&self) -> usize;
    /// With `truncate`, a longer input is cut to `max_input_length`; without
    /// it, a longer input is `TextEmbedError::TooLong`.
    fn embed(&self, inputs: &[String], truncate: bool) -> Result<Vec<Vec<f32>>, TextEmbedError>;
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Inputs {
    One(String),
    Many(Vec<String>),
}

/// `POST /text/embed`. Fields TEI accepts beyond these are ignored.
#[derive(Debug, Deserialize)]
pub struct EmbedRequest {
    pub inputs: Inputs,
    #[serde(default)]
    pub truncate: bool,
    #[serde(default = "enabled")]
    pub normalize: bool,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, PartialEq, Eq)]
pub enum RequestError {
    Empty,
    BatchTooLarge(usize),
}

impl EmbedRequest {
    pub fn into_inputs(self) -> Result<Vec<String>, RequestError> {
        let inputs = match self.inputs {
            Inputs::One(text) => vec![text],
            Inputs::Many(texts) => texts,
        };
        if inputs.is_empty() || inputs.iter().any(String::is_empty) {
            return Err(RequestError::Empty);
        }
        if inputs.len() > MAX_CLIENT_BATCH_SIZE {
            return Err(RequestError::BatchTooLarge(inputs.len()));
        }
        Ok(inputs)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(body: serde_json::Value) -> EmbedRequest {
        serde_json::from_value(body).unwrap()
    }

    #[test]
    fn defaults_match_tei() {
        let parsed = request(json!({ "inputs": "hello" }));
        assert!(!parsed.truncate);
        assert!(parsed.normalize);
        assert_eq!(parsed.into_inputs().unwrap(), vec!["hello".to_string()]);
    }

    #[test]
    fn accepts_a_batch_and_ignores_unknown_fields() {
        let parsed =
            request(json!({ "inputs": ["a", "b"], "truncate": true, "normalize": false, "prompt_name": null }));
        assert!(parsed.truncate);
        assert!(!parsed.normalize);
        assert_eq!(parsed.into_inputs().unwrap().len(), 2);
    }

    #[test]
    fn rejects_empty_and_oversized_batches() {
        assert_eq!(request(json!({ "inputs": [] })).into_inputs(), Err(RequestError::Empty));
        assert_eq!(
            request(json!({ "inputs": ["a", ""] })).into_inputs(),
            Err(RequestError::Empty)
        );
        let many: Vec<String> = (0..=MAX_CLIENT_BATCH_SIZE).map(|i| i.to_string()).collect();
        assert_eq!(
            request(json!({ "inputs": many })).into_inputs(),
            Err(RequestError::BatchTooLarge(33))
        );
    }

    #[test]
    fn rejects_inputs_that_are_not_text() {
        assert!(serde_json::from_value::<EmbedRequest>(json!({ "inputs": [1, 2] })).is_err());
        assert!(serde_json::from_value::<EmbedRequest>(json!({})).is_err());
    }

    #[test]
    fn too_long_reads_like_tei() {
        let error = TextEmbedError::TooLong { given: 600, max: 512 };
        assert_eq!(error.to_string(), "`inputs` must have less than 512 tokens. Given: 600");
    }
}
