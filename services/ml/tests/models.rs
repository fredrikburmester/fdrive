//! Probes against the real models. Ignored by default because they download
//! several gigabytes; run them after changing a model pin, ONNX Runtime or
//! the tokenizer:
//!
//! ```sh
//! cargo test --release --test models -- --ignored
//! ```
//!
//! Files are kept in `FDRIVE_ML_MODELS_DIR` (default `target/models`).

use std::path::PathBuf;

use fdrive_ml::hub::Hub;
use fdrive_ml::onnx::Runtime;

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm = |v: &[f32]| v.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (norm(a) * norm(b))
}

fn runtime(tokio: &tokio::runtime::Runtime) -> Runtime {
    let models = std::env::var("FDRIVE_ML_MODELS_DIR").map_or_else(|_| PathBuf::from("target/models"), PathBuf::from);
    let hub = Hub::new("https://huggingface.co", &models).unwrap();
    Runtime::new(hub, 4, tokio.handle().clone()).unwrap()
}

fn solid_png(color: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::RgbImage::from_pixel(64, 64, image::Rgb(color))
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

#[test]
#[ignore = "downloads the text model (about 490 MB)"]
fn text_model_ranks_the_matching_passage_first() {
    let tokio = tokio::runtime::Runtime::new().unwrap();
    let embedder = runtime(&tokio).load_text().unwrap();
    let inputs = [
        "query: how do I reset my password".to_string(),
        "passage: To reset your password, open Settings and choose Security.".to_string(),
        "passage: The recipe needs two cups of flour and one egg.".to_string(),
    ];
    let vectors = embedder.embed(&inputs, true).unwrap();
    assert_eq!(vectors.len(), 3);
    assert!(
        vectors
            .iter()
            .all(|vector| vector.len() == 384 && vector.iter().all(|value| value.is_finite()))
    );
    assert!(cosine(&vectors[0], &vectors[1]) > cosine(&vectors[0], &vectors[2]));

    // 600 words is far past 512 tokens: refused whole, embedded when cut.
    let long = vec!["passage: ".to_string() + &"word ".repeat(600)];
    assert!(embedder.embed(&long, false).is_err());
    assert_eq!(embedder.embed(&long, true).unwrap()[0].len(), 384);
}

#[test]
#[ignore = "downloads the image model (about 2.6 GB)"]
fn image_model_puts_queries_and_images_in_one_space() {
    let tokio = tokio::runtime::Runtime::new().unwrap();
    let embedder = runtime(&tokio).load_image().unwrap();
    let images = embedder
        .embed_images(&[solid_png([220, 20, 20]), solid_png([20, 20, 220])])
        .unwrap();
    let texts = embedder
        .embed_texts(&["a red square".to_string(), "a blue square".to_string()])
        .unwrap();
    for vector in images.iter().chain(&texts) {
        assert_eq!(vector.len(), 1024);
        assert!(vector.iter().all(|value| value.is_finite()));
    }
    assert!(cosine(&texts[0], &images[0]) > cosine(&texts[0], &images[1]));
    assert!(cosine(&texts[1], &images[1]) > cosine(&texts[1], &images[0]));

    // Capital letters must not change what a query finds.
    let cased = embedder.embed_texts(&["A Red Square".to_string()]).unwrap();
    assert!(cosine(&cased[0], &texts[0]) > 0.9999);
}
