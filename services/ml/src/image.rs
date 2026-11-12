//! Image and query embeddings for image search. The HTTP contract is the one
//! the Python image-embed service defined.

use std::io::Cursor;

use image::{ImageReader, RgbImage};
use serde_json::Value;

pub const MAX_IMAGES: usize = 32;
pub const MAX_TEXTS: usize = 64;
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_TEXT_CHARS: usize = 512;
/// The indexer sends 256 px thumbnails. This still permits large originals
/// while bounding one decoded RGB image to about 48 MiB.
pub const MAX_IMAGE_PIXELS: u64 = 4096 * 4096;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ImageEmbedError {
    /// One part's bytes are not a readable image.
    #[error("undecodable image: {0}")]
    Decode(String),
    #[error("{0}")]
    Backend(String),
}

/// A loaded image/text model pair with a shared vector space. Returns one
/// unnormalized vector per input, in order.
pub trait ImageEmbedder: Send + Sync {
    fn model_id(&self) -> &str;
    fn dim(&self) -> usize;
    fn embed_images(&self, images: &[Vec<u8>]) -> Result<Vec<Vec<f32>>, ImageEmbedError>;
    fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, ImageEmbedError>;
}

/// A request the contract rejects, with the status it maps to.
#[derive(Debug, PartialEq, Eq)]
pub struct RequestError {
    pub status: u16,
    pub message: String,
}

impl RequestError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

pub fn validate_images(images: &[Vec<u8>]) -> Result<(), RequestError> {
    if images.is_empty() {
        return Err(RequestError::new(400, "at least one image is required"));
    }
    if images.len() > MAX_IMAGES {
        return Err(RequestError::new(
            413,
            format!("at most {MAX_IMAGES} images per request"),
        ));
    }
    if images.iter().any(|image| image.len() > MAX_IMAGE_BYTES) {
        return Err(RequestError::new(
            413,
            format!("an image part exceeds {MAX_IMAGE_BYTES} bytes"),
        ));
    }
    Ok(())
}

/// Reads and bounds the `inputs` of `POST /image/embed/text`.
pub fn parse_text_inputs(body: &Value) -> Result<Vec<String>, RequestError> {
    let Some(object) = body.as_object() else {
        return Err(RequestError::new(400, "request body must be a JSON object"));
    };
    let texts: Option<Vec<String>> = object
        .get("inputs")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().map(|item| item.as_str().map(str::to_owned)).collect());
    let Some(texts) = texts else {
        return Err(RequestError::new(400, "'inputs' must be a list of strings"));
    };
    if texts.is_empty() {
        return Err(RequestError::new(400, "at least one text is required"));
    }
    if texts.len() > MAX_TEXTS {
        return Err(RequestError::new(413, format!("at most {MAX_TEXTS} texts per request")));
    }
    if texts.iter().any(|text| text.chars().count() > MAX_TEXT_CHARS) {
        return Err(RequestError::new(
            413,
            format!("a text exceeds {MAX_TEXT_CHARS} characters"),
        ));
    }
    Ok(texts)
}

/// A query as the model expects it. SigLIP was trained on lowercased text,
/// and its tokenizer file does not lowercase by itself: left as typed, a
/// capital letter costs several points of first-hit rate, more so outside
/// English.
pub fn prepare_query(text: &str) -> String {
    text.to_lowercase()
}

/// Reads the header, rejects excessive dimensions, then allocates pixels.
pub fn decode_rgb(raw: &[u8]) -> Result<RgbImage, ImageEmbedError> {
    let decode = |error: image::ImageError| ImageEmbedError::Decode(error.to_string());
    let reader = || {
        ImageReader::new(Cursor::new(raw))
            .with_guessed_format()
            .map_err(|error| ImageEmbedError::Decode(error.to_string()))
    };
    let (width, height) = reader()?.into_dimensions().map_err(decode)?;
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_IMAGE_PIXELS {
        return Err(ImageEmbedError::Decode(format!(
            "image has {pixels} pixels; maximum is {MAX_IMAGE_PIXELS}"
        )));
    }
    Ok(reader()?.decode().map_err(decode)?.into_rgb8())
}

/// Fixed-point scale of the resize weights, as Pillow uses for 8-bit images.
const PRECISION_BITS: u32 = 32 - 8 - 2;

/// The source pixels and integer weights that make up each output pixel
/// along one axis of a bilinear resize.
struct Taps {
    /// Per output pixel: the first source pixel and that pixel's weights.
    spans: Vec<(usize, Vec<i32>)>,
}

impl Taps {
    fn new(source: u32, target: u32) -> Self {
        let scale = f64::from(source) / f64::from(target);
        // Shrinking widens the triangle so every source pixel still counts.
        let filter_scale = scale.max(1.0);
        let spans = (0..target)
            .map(|index| {
                let center = (f64::from(index) + 0.5) * scale;
                let first = ((center - filter_scale + 0.5) as i64).max(0);
                let last = ((center + filter_scale + 0.5) as i64).min(i64::from(source));
                let weights: Vec<f64> = (first..last)
                    .map(|pixel| (1.0 - ((pixel as f64 - center + 0.5) / filter_scale).abs()).max(0.0))
                    .collect();
                let total: f64 = weights.iter().sum();
                let fixed = weights
                    .iter()
                    .map(|weight| {
                        let normalized = if total == 0.0 { *weight } else { weight / total };
                        (0.5 + normalized * f64::from(1u32 << PRECISION_BITS)) as i32
                    })
                    .collect();
                (first as usize, fixed)
            })
            .collect();
        Self { spans }
    }
}

/// Weighted sum of one channel, rounded and clamped to a byte.
fn blend(weights: &[i32], values: impl Iterator<Item = u8>) -> u8 {
    let sum = weights
        .iter()
        .zip(values)
        .fold(1i32 << (PRECISION_BITS - 1), |sum, (weight, value)| {
            sum.wrapping_add(weight.wrapping_mul(i32::from(value)))
        });
    (sum >> PRECISION_BITS).clamp(0, 255) as u8
}

/// Bilinear resize that reproduces Pillow's `Image.resize(..., BILINEAR)`
/// byte for byte: the same taps, the same fixed-point weights, and a
/// horizontal pass rounded to bytes before the vertical one. The Python
/// service resized with Pillow, and vectors already stored for a library
/// only stay comparable to new ones if small or large originals are resized
/// the same way.
pub fn resize_bilinear(image: &RgbImage, width: u32, height: u32) -> RgbImage {
    let (source_width, source_height) = image.dimensions();
    let horizontal = Taps::new(source_width, width);
    let mut rows = RgbImage::new(width, source_height);
    for y in 0..source_height {
        for (x, (first, weights)) in horizontal.spans.iter().enumerate() {
            let pixel = std::array::from_fn(|channel| {
                blend(
                    weights,
                    (0..weights.len()).map(|tap| image.get_pixel((first + tap) as u32, y).0[channel]),
                )
            });
            rows.put_pixel(x as u32, y, image::Rgb(pixel));
        }
    }
    let vertical = Taps::new(source_height, height);
    let mut resized = RgbImage::new(width, height);
    for (y, (first, weights)) in vertical.spans.iter().enumerate() {
        for x in 0..width {
            let pixel = std::array::from_fn(|channel| {
                blend(
                    weights,
                    (0..weights.len()).map(|tap| rows.get_pixel(x, (first + tap) as u32).0[channel]),
                )
            });
            resized.put_pixel(x, y as u32, image::Rgb(pixel));
        }
    }
    resized
}

/// The model's pixel input for one image: squashed to `size` by `size`,
/// scaled to [-1, 1], channels first.
pub fn preprocess(image: &RgbImage, size: u32) -> Vec<f32> {
    let resized = if image.dimensions() == (size, size) {
        image.clone()
    } else {
        resize_bilinear(image, size, size)
    };
    let plane = (size as usize) * (size as usize);
    let mut values = vec![0f32; 3 * plane];
    for (index, pixel) in resized.pixels().enumerate() {
        for channel in 0..3 {
            values[channel * plane + index] = f32::from(pixel.0[channel]) / 255.0 * 2.0 - 1.0;
        }
    }
    values
}

#[cfg(test)]
pub mod test_support {
    use std::io::Cursor;

    use image::{ImageFormat, Rgb, RgbImage};

    pub fn png(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        let mut bytes = Vec::new();
        RgbImage::from_pixel(width, height, Rgb(color))
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();
        bytes
    }
}

#[cfg(test)]
mod tests {
    use image::Rgb;
    use serde_json::json;

    use super::test_support::png;
    use super::*;

    #[test]
    fn image_bounds_follow_the_contract() {
        assert_eq!(validate_images(&[]).unwrap_err().status, 400);
        assert_eq!(
            validate_images(&vec![vec![0u8]; MAX_IMAGES + 1]).unwrap_err().status,
            413
        );
        assert_eq!(
            validate_images(&[vec![0u8; MAX_IMAGE_BYTES + 1]]).unwrap_err().status,
            413
        );
        assert!(validate_images(&[vec![0u8; MAX_IMAGE_BYTES]]).is_ok());
    }

    #[test]
    fn text_inputs_follow_the_contract() {
        assert_eq!(
            parse_text_inputs(&json!({ "inputs": ["blue chair"] })).unwrap(),
            vec!["blue chair".to_string()]
        );
        let bad_request = [
            json!([]),
            json!({}),
            json!({ "inputs": "x" }),
            json!({ "inputs": [1] }),
            json!({ "inputs": [] }),
        ];
        for body in bad_request {
            assert_eq!(parse_text_inputs(&body).unwrap_err().status, 400, "{body}");
        }
        let many: Vec<String> = vec!["x".into(); MAX_TEXTS + 1];
        assert_eq!(parse_text_inputs(&json!({ "inputs": many })).unwrap_err().status, 413);
        assert_eq!(
            parse_text_inputs(&json!({ "inputs": ["x".repeat(MAX_TEXT_CHARS + 1)] }))
                .unwrap_err()
                .status,
            413
        );
        // The bound counts characters, not bytes.
        assert!(parse_text_inputs(&json!({ "inputs": ["å".repeat(MAX_TEXT_CHARS)] })).is_ok());
    }

    #[test]
    fn queries_are_lowercased_in_every_script() {
        assert_eq!(prepare_query("Blue Chair"), "blue chair");
        assert_eq!(prepare_query("Öppna Butik i MALMÖ"), "öppna butik i malmö");
        assert_eq!(prepare_query("東京 Tower"), "東京 tower");
    }

    #[test]
    fn decodes_an_image_to_rgb() {
        let image = decode_rgb(&png(3, 2, [10, 20, 30])).unwrap();
        assert_eq!(image.dimensions(), (3, 2));
        assert_eq!(image.get_pixel(0, 0), &Rgb([10, 20, 30]));
    }

    #[test]
    fn rejects_bytes_that_are_not_an_image() {
        assert!(matches!(decode_rgb(b"not an image"), Err(ImageEmbedError::Decode(_))));
        let mut truncated = png(8, 8, [1, 2, 3]);
        truncated.truncate(40);
        assert!(matches!(decode_rgb(&truncated), Err(ImageEmbedError::Decode(_))));
    }

    #[test]
    fn rejects_an_image_with_too_many_pixels_before_decoding_it() {
        let error = decode_rgb(&png(4097, 4096, [0, 0, 0])).unwrap_err();
        assert_eq!(
            error,
            ImageEmbedError::Decode("image has 16781312 pixels; maximum is 16777216".into())
        );
    }

    /// The image the Pillow reference values below were generated from.
    fn pattern(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            Rgb([
                ((x * 37 + y * 11) % 256) as u8,
                ((x * 5 + y * 71) % 256) as u8,
                ((x * y * 13 + 7) % 256) as u8,
            ])
        })
    }

    #[test]
    fn resize_matches_pillow_byte_for_byte() {
        // `pattern(w, h).resize((tw, th), Image.BILINEAR).tobytes()` from Pillow 12.3.0.
        let enlarged: [u8; 96] = [
            0, 0, 7, 16, 2, 7, 39, 5, 7, 62, 8, 7, 86, 12, 7, 109, 15, 7, 132, 18, 7, 148, 20, 7, 7, 44, 7, 23, 46, 11,
            46, 49, 16, 69, 52, 21, 93, 56, 26, 116, 59, 31, 139, 62, 36, 155, 64, 40, 15, 98, 7, 31, 100, 15, 54, 103,
            26, 77, 106, 37, 101, 110, 48, 124, 113, 59, 147, 116, 71, 163, 118, 79, 22, 142, 7, 38, 144, 18, 61, 147,
            35, 84, 150, 51, 108, 154, 67, 131, 157, 83, 154, 160, 100, 170, 162, 111,
        ];
        assert_eq!(resize_bilinear(&pattern(5, 3), 8, 4).into_raw(), enlarged);

        let reduced: [u8; 18] = [
            63, 100, 33, 163, 114, 83, 103, 128, 102, 95, 123, 79, 175, 137, 128, 89, 151, 120,
        ];
        assert_eq!(resize_bilinear(&pattern(9, 7), 3, 2).into_raw(), reduced);

        let one_axis: [u8; 24] = [
            8, 51, 7, 45, 56, 16, 82, 61, 26, 119, 66, 35, 25, 162, 7, 62, 167, 37, 99, 172, 66, 136, 177, 96,
        ];
        assert_eq!(resize_bilinear(&pattern(4, 4), 4, 2).into_raw(), one_axis);
    }

    #[test]
    fn preprocess_scales_to_the_model_range_channels_first() {
        let image = RgbImage::from_pixel(5, 3, Rgb([255, 0, 51]));
        let values = preprocess(&image, 4);
        assert_eq!(values.len(), 3 * 16);
        assert!(values[..16].iter().all(|v| (*v - 1.0).abs() < 1e-6));
        assert!(values[16..32].iter().all(|v| (*v + 1.0).abs() < 1e-6));
        assert!(values[32..].iter().all(|v| (*v + 0.6).abs() < 1e-6));
        // An image already at the model's size is used as it is.
        assert_eq!(preprocess(&RgbImage::from_pixel(4, 4, Rgb([255, 0, 51])), 4), values);
    }
}
