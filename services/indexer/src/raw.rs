//! Camera raw (Sony ARW, Canon CR2/CR3, Nikon NEF, DNG, ...) thumbnail sources via rawler.
//!
//! Cameras embed a JPEG preview in every raw file, rendered by the camera itself. That
//! preview is what Finder, Lightroom's grid and phone galleries show, and reading it costs
//! a few MB of seeks rather than a full demosaic. So it is the thumbnail source. Only when
//! a file has no preview large enough does rawler develop the sensor data.
//!
//! rawler returns previews and developed images as stored, without the camera's
//! orientation, so the raw's EXIF orientation is applied here, exactly once.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use anyhow::{Result, anyhow};
use image::DynamicImage;
use image::metadata::Orientation;
use rawler::decoders::{Decoder, RawDecodeParams};
use rawler::imgop::develop::RawDevelop;
use rawler::rawsource::RawSource;

use crate::images::to_rgb_or_rgba;

/// `picture` turned upright for the EXIF orientation `code` (1-8); unchanged for 1, 0 or
/// an unknown code.
pub fn apply_orientation(mut picture: DynamicImage, code: u16) -> DynamicImage {
    if let Some(orientation) = u8::try_from(code).ok().and_then(Orientation::from_exif) {
        picture.apply_orientation(orientation);
    }
    picture
}

/// Whether a `width` x `height` preview is at least as large as the thumbnail it would be
/// scaled to. A tiny 160px index thumbnail does not cover a 1024px one.
pub fn preview_covers(width: u32, height: u32, longest_side: Option<u32>) -> bool {
    longest_side.is_none_or(|side| width.max(height) >= side)
}

/// An upright RGB image for the raw file at `path`, large enough for a `longest_side`
/// thumbnail when the file allows it: the embedded preview when it covers that size, else
/// a development of the sensor data, else whatever preview exists.
pub fn open_raw(path: &Path, longest_side: Option<u32>) -> Result<DynamicImage> {
    let source = RawSource::new(path).map_err(|e| anyhow!("OSError: {}: {e}", path.display()))?;
    let decoder = guarded(|| rawler::get_decoder(&source).map_err(raw_error))?;
    let params = RawDecodeParams::default();
    let tagged = guarded(|| decoder.raw_metadata(&source, &params).map_err(raw_error))
        .ok()
        .and_then(|metadata| metadata.exif.orientation);
    let preview = embedded_preview(decoder.as_ref(), &source, &params);
    let (picture, orientation) = match preview {
        Some(preview) if preview_covers(preview.width(), preview.height(), longest_side) => (preview, tagged),
        preview => match guarded(|| develop(decoder.as_ref(), &source, &params)) {
            Ok((developed, own)) => (developed, tagged.or(Some(own))),
            Err(error) => (preview.ok_or(error)?, tagged),
        },
    };
    Ok(apply_orientation(to_rgb_or_rgba(picture), orientation.unwrap_or(1)))
}

fn embedded_preview(decoder: &dyn Decoder, source: &RawSource, params: &RawDecodeParams) -> Option<DynamicImage> {
    let preview = guarded(|| decoder.preview_image(source, params).map_err(raw_error))
        .ok()
        .flatten();
    preview.or_else(|| {
        guarded(|| decoder.thumbnail_image(source, params).map_err(raw_error))
            .ok()
            .flatten()
    })
}

/// The sensor data demosaiced with the camera's white balance, and the orientation the
/// decoder found for it. rawler has no half-size development, so this is full size.
fn develop(decoder: &dyn Decoder, source: &RawSource, params: &RawDecodeParams) -> Result<(DynamicImage, u16)> {
    let raw = decoder.raw_image(source, params, false).map_err(raw_error)?;
    // Developing allocates three floats per pixel; refuse what Pillow's limit would refuse.
    crate::images::check_pixels(
        u32::try_from(raw.width).unwrap_or(u32::MAX),
        u32::try_from(raw.height).unwrap_or(u32::MAX),
        crate::images::MAX_IMAGE_PIXELS,
    )?;
    let developed = RawDevelop::default().develop_intermediate(&raw).map_err(raw_error)?;
    let picture = developed
        .to_dynamic_image()
        .ok_or_else(|| anyhow!("RawError: developed image has the wrong size"))?;
    Ok((picture, raw.orientation.to_u16()))
}

fn raw_error(error: rawler::RawlerError) -> anyhow::Error {
    anyhow!("RawError: {error}")
}

/// Run rawler code that may panic on unsupported input (`todo!`, `unimplemented!`) and turn
/// a panic into an error, so one bad file never takes the indexer down.
fn guarded<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|payload| {
        Err(anyhow!(
            "RawError: decoder panicked: {}",
            panic_message(payload.as_ref())
        ))
    })
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::images::tests::{solid, two_tone};
    use image::{Rgb, RgbImage};
    use rawler::dng::writer::DngWriter;
    use rawler::dng::{DNG_VERSION_V1_4, DngCompression};
    use rawler::tags::TiffCommonTag;

    pub(crate) struct DngParts<'a> {
        pub raw: Option<&'a RgbImage>,
        pub preview: Option<&'a DynamicImage>,
        pub thumbnail: Option<&'a DynamicImage>,
        pub orientation: Option<u16>,
    }

    /// A minimal DNG written by rawler: linear RGB sensor data, an optional JPEG preview
    /// (at most 1024 px wide, as rawler writes it) and an optional 240 px root thumbnail.
    pub(crate) fn write_dng(path: &Path, parts: &DngParts<'_>) {
        let file = std::fs::File::create(path).unwrap();
        let mut dng = DngWriter::new(std::io::BufWriter::new(file), DNG_VERSION_V1_4).unwrap();
        dng.root_ifd_mut().add_tag(TiffCommonTag::Make, "Test");
        dng.root_ifd_mut().add_tag(TiffCommonTag::Model, "Synthetic");
        if let Some(code) = parts.orientation {
            dng.root_ifd_mut().add_tag(TiffCommonTag::Orientation, code);
        }
        if let Some(thumbnail) = parts.thumbnail {
            dng.thumbnail(thumbnail).unwrap();
        }
        if let Some(raw) = parts.raw {
            let mut frame = dng.subframe(0);
            let (w, h) = (raw.width() as usize, raw.height() as usize);
            frame
                .rgb_image_u8(raw.as_raw(), w, h, DngCompression::Uncompressed, 1)
                .unwrap();
            frame.finalize().unwrap();
        }
        if let Some(preview) = parts.preview {
            let mut frame = dng.subframe(1);
            frame.preview(preview, 0.9).unwrap();
            frame.finalize().unwrap();
        }
        dng.close().unwrap();
    }

    fn sensor(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, _| {
            if x < width / 2 {
                Rgb([250, 10, 10])
            } else {
                Rgb([10, 10, 250])
            }
        })
    }

    fn top_left(picture: &DynamicImage) -> [u8; 3] {
        picture.to_rgb8().get_pixel(1, 1).0
    }

    #[test]
    fn orientation_codes_turn_pictures_upright() {
        // (code, top-left colour of a red|blue picture, portrait?)
        for (code, red, portrait) in [
            (1, true, false),
            (2, false, false),
            (3, false, false),
            (4, true, false),
            (5, true, true),
            (6, true, true),
            (7, false, true),
            (8, false, true),
            (0, true, false),
            (9, true, false),
            (300, true, false),
        ] {
            let turned = apply_orientation(two_tone(20, 10), code);
            assert_eq!(
                (turned.width(), turned.height()),
                if portrait { (10, 20) } else { (20, 10) },
                "{code}"
            );
            assert_eq!(top_left(&turned) == [255, 0, 0], red, "{code}");
        }
    }

    #[test]
    fn preview_covers_target_size() {
        assert!(preview_covers(1616, 1080, Some(1024)));
        assert!(preview_covers(1024, 683, Some(1024)));
        assert!(!preview_covers(160, 120, Some(1024)));
        assert!(preview_covers(160, 120, None));
    }

    #[test]
    fn panics_become_errors() {
        let error = guarded::<()>(|| panic!("not yet")).unwrap_err().to_string();
        assert_eq!(error, "RawError: decoder panicked: not yet");
        let owned = guarded::<()>(|| panic!("{}", String::from("owned")))
            .unwrap_err()
            .to_string();
        assert!(owned.ends_with("owned"));
        assert_eq!(panic_message(&42), "unknown panic");
    }

    #[test]
    fn uses_the_embedded_preview_and_the_raw_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.dng");
        let preview = two_tone(1000, 600);
        let raw = sensor(64, 32);
        write_dng(
            &path,
            &DngParts {
                raw: Some(&raw),
                preview: Some(&preview),
                thumbnail: None,
                orientation: Some(6),
            },
        );

        let picture = open_raw(&path, Some(1000)).unwrap();
        assert_eq!((picture.width(), picture.height()), (600, 1000));
        assert!(matches!(picture, DynamicImage::ImageRgb8(_)));
        let [r, _, b] = top_left(&picture);
        assert!(r > 200 && b < 60, "rotated clockwise once: red on top");
    }

    #[test]
    fn develops_when_the_preview_is_too_small() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.dng");
        let preview = solid(160, 120, [0, 255, 0]);
        let raw = sensor(300, 200);
        write_dng(
            &path,
            &DngParts {
                raw: Some(&raw),
                preview: Some(&preview),
                thumbnail: None,
                orientation: Some(8),
            },
        );

        let picture = open_raw(&path, Some(1024)).unwrap();
        assert_eq!((picture.width(), picture.height()), (200, 300));
        // Turned counter-clockwise once: the blue right half is now on top.
        let [r, _, b] = top_left(&picture);
        assert!(b > r, "{r} {b}");
        // Any preview covers when no size is asked for.
        let picture = open_raw(&path, None).unwrap();
        assert_eq!((picture.width(), picture.height()), (120, 160));
    }

    #[test]
    fn develops_when_there_is_no_preview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.dng");
        let raw = sensor(80, 50);
        write_dng(
            &path,
            &DngParts {
                raw: Some(&raw),
                preview: None,
                thumbnail: None,
                orientation: None,
            },
        );
        let picture = open_raw(&path, Some(1024)).unwrap();
        assert_eq!((picture.width(), picture.height()), (80, 50));
    }

    #[test]
    fn falls_back_to_a_small_preview_when_development_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.dng");
        let thumbnail = solid(240, 120, [0, 255, 0]);
        write_dng(
            &path,
            &DngParts {
                raw: None,
                preview: None,
                thumbnail: Some(&thumbnail),
                orientation: Some(1),
            },
        );
        let picture = open_raw(&path, Some(1024)).unwrap();
        assert_eq!((picture.width(), picture.height()), (240, 120));
    }

    #[test]
    fn fails_when_nothing_can_be_rendered() {
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.dng");
        write_dng(
            &empty,
            &DngParts {
                raw: None,
                preview: None,
                thumbnail: None,
                orientation: None,
            },
        );
        assert!(
            open_raw(&empty, Some(1024))
                .unwrap_err()
                .to_string()
                .starts_with("RawError")
        );
        let garbage = dir.path().join("garbage.arw");
        std::fs::write(&garbage, b"not really a raw file").unwrap();
        assert!(
            open_raw(&garbage, Some(1024))
                .unwrap_err()
                .to_string()
                .starts_with("RawError")
        );
        let missing = dir.path().join("missing.arw");
        assert!(
            open_raw(&missing, Some(1024))
                .unwrap_err()
                .to_string()
                .starts_with("OSError")
        );
    }
}
