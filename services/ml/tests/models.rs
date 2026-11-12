//! Probes against the real models. Ignored by default because they download
//! several gigabytes; run them after changing a model pin, ONNX Runtime or
//! the tokenizer:
//!
//! ```sh
//! cargo test --release --test models -- --ignored
//! ```
//!
//! Files are kept in `FDRIVE_ML_MODELS_DIR` (default `target/models`).
//!
//! `tests/reference` holds vectors to compare against: the text ones came
//! from text-embeddings-inference, the image ones from this server on an
//! Apple M-series CPU. Regenerate the image ones after a deliberate model
//! change with `FDRIVE_ML_WRITE_REFERENCE=1`.

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

fn png(image: &image::RgbImage) -> Vec<u8> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .unwrap();
    bytes
}

fn solid_png(color: [u8; 3]) -> Vec<u8> {
    png(&image::RgbImage::from_pixel(64, 64, image::Rgb(color)))
}

/// Two generated pictures with structure for the model to respond to: one
/// already at the model's size, one that has to be resized.
fn reference_images() -> Vec<Vec<u8>> {
    let weave = image::RgbImage::from_fn(256, 256, |x, y| {
        image::Rgb([
            ((x * 3 + y * 5) % 256) as u8,
            ((x * x / 7 + y) % 256) as u8,
            ((x ^ y) % 256) as u8,
        ])
    });
    let sunset = image::RgbImage::from_fn(320, 200, |x, y| {
        image::Rgb([(x * 255 / 319) as u8, (y * 255 / 199) as u8, 128])
    });
    vec![png(&weave), png(&sunset)]
}

fn reference(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/reference")
        .join(name)
}

fn recorded_vectors(value: &serde_json::Value) -> Vec<Vec<f32>> {
    serde_json::from_value(value.clone()).unwrap()
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

    // The vectors text-embeddings-inference gave for the same inputs.
    let recorded: serde_json::Value = serde_json::from_slice(&std::fs::read(reference("text.json")).unwrap()).unwrap();
    let inputs: Vec<String> = serde_json::from_value(recorded["inputs"].clone()).unwrap();
    for (ours, theirs) in embedder
        .embed(&inputs, true)
        .unwrap()
        .iter()
        .zip(recorded_vectors(&recorded["vectors"]))
    {
        assert!(cosine(ours, &theirs) > 0.9999, "cosine {}", cosine(ours, &theirs));
    }

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

    let pictures = reference_images();
    let started = std::time::Instant::now();
    let embedded = embedder.embed_images(&pictures).unwrap();
    println!(
        "{:.0} ms per image",
        started.elapsed().as_secs_f64() * 1000.0 / pictures.len() as f64
    );
    if std::env::var_os("FDRIVE_ML_WRITE_REFERENCE").is_some() {
        let recorded = serde_json::json!({
            "source": format!("fdrive-ml on {} {}", std::env::consts::ARCH, std::env::consts::OS),
            "images": ["weave", "sunset"],
            "vectors": embedded,
        });
        std::fs::write(reference("image.json"), serde_json::to_string(&recorded).unwrap()).unwrap();
        return;
    }
    // The 8-bit tower does not compute the same on every CPU family: across
    // ARM and x86 the same photo came out with a cosine of about 0.98. A
    // result far below that means this CPU's code path loses precision.
    let recorded: serde_json::Value = serde_json::from_slice(&std::fs::read(reference("image.json")).unwrap()).unwrap();
    for (ours, theirs) in embedded.iter().zip(recorded_vectors(&recorded["vectors"])) {
        println!("cosine with the recorded vector: {:.4}", cosine(ours, &theirs));
        assert!(cosine(ours, &theirs) > 0.9, "cosine {}", cosine(ours, &theirs));
    }
}
