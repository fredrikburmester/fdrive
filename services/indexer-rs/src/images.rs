//! Decoding a source image into an upright RGB or RGBA picture: JPEG through jpeg-decoder at
//! a reduced DCT scale, HEIC/HEIF through libheif (which applies its own rotation), and
//! everything else through the image crate. Pillow's decompression-bomb rule is kept: a
//! picture over twice `MAX_IMAGE_PIXELS` is refused, except a JPEG whose reduced decode fits.

use std::fs::File;
use std::io::{BufReader, Cursor, Read};
use std::path::Path;

use anyhow::{Result, anyhow, bail};
use image::codecs::jpeg::JpegDecoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageError, ImageReader, Limits, RgbImage, RgbaImage};
use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

use crate::thumbs::{SIZES, resize_dimensions};

/// Pillow's `Image.MAX_IMAGE_PIXELS`. Pillow refuses sources over twice this many pixels.
pub const MAX_IMAGE_PIXELS: u64 = 89_478_485;

/// Brands of the ISO base media (HEIF) family that libheif reads.
const HEIF_BRANDS: [&[u8; 4]; 10] = [
    b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"mif1", b"msf1", b"avif", b"avis",
];
const AVIF_BRANDS: [&[u8; 4]; 2] = [b"avif", b"avis"];

/// An upright RGB or RGBA picture for the image at `path`. A JPEG decodes at the smallest
/// DCT scale that still covers a `longest_side` thumbnail; other formats ignore the hint.
pub fn open_image(path: &Path, longest_side: Option<u32>) -> Result<DynamicImage> {
    open_image_limited(path, longest_side, MAX_IMAGE_PIXELS)
}

/// `open_image` with Pillow's pixel limit replaced by `max_pixels`.
pub(crate) fn open_image_limited(path: &Path, longest_side: Option<u32>, max_pixels: u64) -> Result<DynamicImage> {
    let head = read_head(path)?;
    let head = head.as_slice();
    let picture = if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        open_jpeg(path, longest_side, max_pixels)?
    } else if let Some(brand) = heif_brand(head) {
        if AVIF_BRANDS.contains(&brand) {
            // The image crate decodes AVIF itself; libheif is the fallback for what it cannot read.
            match open_with_image_crate(path, max_pixels) {
                Ok(picture) => picture,
                Err(error) if is_bomb(&error) => return Err(error),
                Err(error) => open_heif(path, max_pixels).map_err(|_| error)?,
            }
        } else {
            open_heif(path, max_pixels)?
        }
    } else {
        open_with_image_crate(path, max_pixels)?
    };
    Ok(to_rgb_or_rgba(picture))
}

/// `picture` as RGB8, or RGBA8 when it has alpha at more than 8 bits; RGB8 and RGBA8 pass
/// through unchanged. Palette, grey and other modes become RGB8, as Pillow's
/// `convert("RGB")` does.
pub fn to_rgb_or_rgba(picture: DynamicImage) -> DynamicImage {
    match picture {
        DynamicImage::ImageRgb8(_) | DynamicImage::ImageRgba8(_) => picture,
        DynamicImage::ImageRgba16(_) | DynamicImage::ImageRgba32F(_) => DynamicImage::ImageRgba8(picture.to_rgba8()),
        other => DynamicImage::ImageRgb8(other.to_rgb8()),
    }
}

/// Pillow's message for a source over the limit; the part before ':' is the failure code.
fn bomb(pixels: u64, max_pixels: u64) -> anyhow::Error {
    anyhow!(
        "DecompressionBombError: Image size ({pixels} pixels) exceeds limit of {} pixels, \
         could be decompression bomb DOS attack.",
        max_pixels.saturating_mul(2)
    )
}

fn is_bomb(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("DecompressionBombError")
}

fn check_pixels(width: u32, height: u32, max_pixels: u64) -> Result<()> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > max_pixels.saturating_mul(2) {
        Err(bomb(pixels, max_pixels))
    } else {
        Ok(())
    }
}

/// The first bytes of the file at `path`, for telling formats apart by content.
fn read_head(path: &Path) -> Result<Vec<u8>> {
    let mut head = Vec::with_capacity(12);
    File::open(path)
        .and_then(|file| file.take(12).read_to_end(&mut head))
        .map_err(|e| anyhow!("OSError: {}: {e}", path.display()))?;
    Ok(head)
}

fn heif_brand(head: &[u8]) -> Option<&'static [u8; 4]> {
    if head.len() < 12 || &head[4..8] != b"ftyp" {
        return None;
    }
    HEIF_BRANDS.into_iter().find(|brand| head[8..12] == brand[..])
}

/// The DCT scale denominator (1, 2, 4 or 8) a JPEG decodes at, as Pillow's `draft` picks it.
/// A source over twice `max_pixels` is drafted to twice the largest thumbnail and allowed
/// only if that reduced decode is within the limit; a draft is never applied twice.
pub(crate) fn jpeg_scale(width: u32, height: u32, longest_side: Option<u32>, max_pixels: u64) -> Result<u32> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > max_pixels.saturating_mul(2) {
        let largest = SIZES.iter().copied().max().unwrap_or(1024);
        let (w, h) = resize_dimensions(width, height, largest);
        let scale = draft_scale(width, height, w.saturating_mul(2), h.saturating_mul(2));
        let scaled = u64::from(width.div_ceil(scale)) * u64::from(height.div_ceil(scale));
        if scaled > max_pixels.saturating_mul(2) {
            return Err(bomb(pixels, max_pixels));
        }
        return Ok(scale);
    }
    Ok(match longest_side {
        Some(side) => {
            let (w, h) = resize_dimensions(width, height, side);
            draft_scale(width, height, w, h)
        }
        None => 1,
    })
}

fn draft_scale(width: u32, height: u32, target_w: u32, target_h: u32) -> u32 {
    let scale = (width / target_w.max(1)).min(height / target_h.max(1));
    [8, 4, 2].into_iter().find(|&s| scale >= s).unwrap_or(1)
}

/// The EXIF orientation of a JPEG, read from its first APP1 Exif segment.
pub(crate) fn jpeg_orientation(data: &[u8]) -> Orientation {
    let mut at = 2;
    while at + 4 <= data.len() && data[at] == 0xFF {
        let marker = data[at + 1];
        if marker == 0xFF {
            at += 1; // fill byte
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            at += 2; // markers without a length
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            break;
        }
        let length = usize::from(u16::from_be_bytes([data[at + 2], data[at + 3]]));
        if length < 2 {
            break;
        }
        let end = (at + 2 + length).min(data.len());
        let body = &data[at + 4..end];
        if marker == 0xE1
            && let Some(chunk) = body.strip_prefix(b"Exif\0\0")
        {
            return Orientation::from_exif_chunk(chunk).unwrap_or(Orientation::NoTransforms);
        }
        at += 2 + length;
    }
    Orientation::NoTransforms
}

fn open_jpeg(path: &Path, longest_side: Option<u32>, max_pixels: u64) -> Result<DynamicImage> {
    let data = std::fs::read(path).map_err(|e| anyhow!("OSError: {}: {e}", path.display()))?;
    let orientation = jpeg_orientation(&data);
    let mut picture = match decode_scaled(&data, longest_side, max_pixels) {
        Ok(picture) => picture,
        Err(error) if is_bomb(&error) => return Err(error),
        // CMYK and lossless JPEGs, and recoverable corruption, go to the image crate's decoder.
        Err(error) => decode_jpeg_fallback(&data, max_pixels)
            .map_err(|fallback| if is_bomb(&fallback) { fallback } else { error })?,
    };
    picture.apply_orientation(orientation);
    Ok(picture)
}

/// Decode at the smallest DCT scale that still covers the thumbnail, as Pillow's `draft`
/// does. MuPDF bundles its own libjpeg, so a second native one is not linked next to it.
fn decode_scaled(data: &[u8], longest_side: Option<u32>, max_pixels: u64) -> Result<DynamicImage> {
    use jpeg_decoder::{CodingProcess, Decoder, PixelFormat};
    let jpeg = |e: jpeg_decoder::Error| anyhow!("OSError: {e}");
    let mut decoder = Decoder::new(Cursor::new(data));
    decoder.read_info().map_err(jpeg)?;
    let info = decoder.info().ok_or_else(|| anyhow!("OSError: JPEG has no frame"))?;
    if info.pixel_format == PixelFormat::CMYK32 {
        bail!("OSError: CMYK JPEG");
    }
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    // A lossless JPEG has no DCT to scale.
    let scale = if info.coding_process == CodingProcess::Lossless {
        check_pixels(width, height, max_pixels)?;
        1
    } else {
        jpeg_scale(width, height, longest_side, max_pixels)?
    };
    if scale > 1 {
        let request = |side: u32| u16::try_from(side.div_ceil(scale)).unwrap_or(u16::MAX);
        decoder.scale(request(width), request(height)).map_err(jpeg)?;
    }
    let pixels = decoder.decode().map_err(jpeg)?;
    let info = decoder.info().ok_or_else(|| anyhow!("OSError: JPEG has no frame"))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    let wrong = || anyhow!("OSError: decoded JPEG has the wrong size");
    Ok(match info.pixel_format {
        PixelFormat::RGB24 => DynamicImage::ImageRgb8(RgbImage::from_raw(width, height, pixels).ok_or_else(wrong)?),
        PixelFormat::L8 => {
            DynamicImage::ImageLuma8(image::GrayImage::from_raw(width, height, pixels).ok_or_else(wrong)?)
        }
        PixelFormat::L16 => {
            let wide = pixels.as_chunks::<2>().0.iter().map(|b| u16::from_be_bytes(*b)).collect();
            DynamicImage::ImageLuma16(image::ImageBuffer::from_raw(width, height, wide).ok_or_else(wrong)?)
        }
        PixelFormat::CMYK32 => unreachable!("refused above"),
    })
}

fn decode_jpeg_fallback(data: &[u8], max_pixels: u64) -> Result<DynamicImage> {
    let mut decoder = JpegDecoder::new(Cursor::new(data)).map_err(image_error)?;
    decoder.set_limits(limits(max_pixels)).map_err(image_error)?;
    let (width, height) = decoder.dimensions();
    check_pixels(width, height, max_pixels)?;
    DynamicImage::from_decoder(decoder).map_err(image_error)
}

/// Memory the image crate may allocate: an 8-bit RGBA picture at the pixel limit plus room
/// for metadata such as PNG text chunks (kept compressed, at most 64 MiB each).
fn limits(max_pixels: u64) -> Limits {
    let mut limits = Limits::default();
    limits.max_alloc = Some(max_pixels.saturating_mul(8).saturating_add(64 * 1024 * 1024));
    limits
}

fn image_error(error: ImageError) -> anyhow::Error {
    match error {
        ImageError::Limits(e) => anyhow!("DecompressionBombError: {e}"),
        ImageError::Unsupported(e) => anyhow!("UnidentifiedImageError: {e}"),
        other => anyhow!("OSError: {other}"),
    }
}

fn open_with_image_crate(path: &Path, max_pixels: u64) -> Result<DynamicImage> {
    // The format comes from the content alone, as Pillow identifies files.
    let mut reader = File::open(path)
        .and_then(|file| ImageReader::new(BufReader::new(file)).with_guessed_format())
        .map_err(|e| anyhow!("OSError: {}: {e}", path.display()))?;
    if reader.format().is_none() {
        bail!("UnidentifiedImageError: cannot identify image file {}", path.display());
    }
    reader.limits(limits(max_pixels));
    let mut decoder = reader.into_decoder().map_err(image_error)?;
    let (width, height) = decoder.dimensions();
    check_pixels(width, height, max_pixels)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut picture = DynamicImage::from_decoder(decoder).map_err(image_error)?;
    picture.apply_orientation(orientation);
    Ok(picture)
}

fn open_heif(path: &Path, max_pixels: u64) -> Result<DynamicImage> {
    let heif = |e: libheif_rs::HeifError| anyhow!("HeifError: {e}");
    let name = path
        .to_str()
        .ok_or_else(|| anyhow!("OSError: path is not UTF-8: {}", path.display()))?;
    let context = HeifContext::read_from_file(name).map_err(heif)?;
    let handle = context.primary_image_handle().map_err(heif)?;
    check_pixels(handle.width(), handle.height(), max_pixels)?;
    let alpha = handle.has_alpha_channel();
    let chroma = if alpha { RgbChroma::Rgba } else { RgbChroma::Rgb };
    // libheif applies the file's rotation, mirroring and crop while decoding.
    let decoded = LibHeif::new()
        .decode(&handle, ColorSpace::Rgb(chroma), None)
        .map_err(heif)?;
    let planes = decoded.planes();
    let plane = planes
        .interleaved
        .ok_or_else(|| anyhow!("HeifError: no interleaved plane"))?;
    let channels: usize = if alpha { 4 } else { 3 };
    if usize::from(plane.storage_bits_per_pixel) != 8 * channels {
        bail!("HeifError: unexpected {} bits per pixel", plane.storage_bits_per_pixel);
    }
    let row = plane.width as usize * channels;
    let mut pixels = Vec::with_capacity(row * plane.height as usize);
    for line in plane.data.chunks(plane.stride.max(1)).take(plane.height as usize) {
        pixels.extend_from_slice(line.get(..row).ok_or_else(|| anyhow!("HeifError: short row"))?);
    }
    let wrong = || anyhow!("HeifError: decoded image has the wrong size");
    Ok(if alpha {
        DynamicImage::ImageRgba8(RgbaImage::from_raw(plane.width, plane.height, pixels).ok_or_else(wrong)?)
    } else {
        DynamicImage::ImageRgb8(RgbImage::from_raw(plane.width, plane.height, pixels).ok_or_else(wrong)?)
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, Rgba};
    use libheif_rs::{Channel, CompressionFormat, EncoderQuality, Image as HeifImage};

    /// A JPEG of `picture`, with an APP1 Exif segment carrying `orientation` spliced in.
    pub(crate) fn jpeg_bytes(picture: &DynamicImage, orientation: Option<u16>) -> Vec<u8> {
        let mut out = Vec::new();
        picture.write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg).unwrap();
        match orientation {
            Some(code) => splice_exif(&out, code),
            None => out,
        }
    }

    pub(crate) fn splice_exif(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec(); // big-endian TIFF header, IFD at 8
        tiff.extend_from_slice(&1u16.to_be_bytes()); // one entry
        tiff.extend_from_slice(&0x0112u16.to_be_bytes());
        tiff.extend_from_slice(&3u16.to_be_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_be_bytes());
        tiff.extend_from_slice(&orientation.to_be_bytes());
        tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // padding, no next IFD
        let mut out = jpeg[..2].to_vec();
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&u16::try_from(tiff.len() + 8).unwrap().to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    /// Left half red, right half blue, so a rotation is observable.
    pub(crate) fn two_tone(width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, _| {
            if x < width / 2 {
                Rgb([255, 0, 0])
            } else {
                Rgb([0, 0, 255])
            }
        }))
    }

    pub(crate) fn solid(width: u32, height: u32, color: [u8; 3]) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb(color)))
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in data {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
        out
    }

    /// A zlib stream of stored (uncompressed) deflate blocks.
    fn zlib_stored(data: &[u8]) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = data.chunks(65_535).collect();
        for (i, block) in blocks.iter().enumerate() {
            out.push(u8::from(i + 1 == blocks.len()));
            let len = u16::try_from(block.len()).unwrap();
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&(!len).to_le_bytes());
            out.extend_from_slice(block);
        }
        let (mut a, mut b) = (1u32, 0u32);
        for &byte in data {
            a = (a + u32::from(byte)) % 65_521;
            b = (b + a) % 65_521;
        }
        out.extend_from_slice(&((b << 16) | a).to_be_bytes());
        out
    }

    /// A palette PNG whose every pixel is palette entry 1 (green).
    pub(crate) fn palette_png(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = width.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 3, 0, 0, 0]);
        out.extend(png_chunk(b"IHDR", &ihdr));
        out.extend(png_chunk(b"PLTE", &[0, 0, 0, 0, 255, 0]));
        let mut raw = Vec::new();
        for _ in 0..height {
            raw.push(0);
            raw.extend(std::iter::repeat_n(1u8, width as usize));
        }
        out.extend(png_chunk(b"IDAT", &zlib_stored(&raw)));
        out.extend(png_chunk(b"IEND", &[]));
        out
    }

    /// A PNG of `picture` with a zTXt chunk whose text inflates to `text_len` bytes.
    pub(crate) fn png_with_text(picture: &DynamicImage, text_len: usize) -> Vec<u8> {
        let mut png = Vec::new();
        picture.write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();
        let mut ztxt = b"XML:com.adobe.xmp\0\0".to_vec();
        ztxt.extend(zlib_stored(&vec![b'x'; text_len]));
        let iend = png.len() - 12;
        let mut out = png[..iend].to_vec();
        out.extend(png_chunk(b"zTXt", &ztxt));
        out.extend_from_slice(&png[iend..]);
        out
    }

    /// A HEIF file encoded by libheif; None when this libheif has no encoder for `format`.
    pub(crate) fn heif_bytes(width: u32, height: u32, alpha: bool, format: CompressionFormat) -> Option<Vec<u8>> {
        let lib = LibHeif::new();
        let mut encoder = lib.encoder_for_format(format).ok()?;
        encoder.set_quality(EncoderQuality::Lossy(90)).ok()?;
        let mut image = HeifImage::new(width, height, ColorSpace::Rgb(RgbChroma::C444)).ok()?;
        let mut channels = vec![Channel::R, Channel::G, Channel::B];
        if alpha {
            channels.push(Channel::Alpha);
        }
        for channel in channels {
            image.create_plane(channel, width, height, 8).ok()?;
        }
        let planes = image.planes_mut();
        for (plane, value) in [(planes.r, 10u8), (planes.g, 200), (planes.b, 30), (planes.a, 255)] {
            if let Some(plane) = plane {
                plane.data.fill(value);
            }
        }
        let mut context = HeifContext::new().ok()?;
        context.encode_image(&image, &mut encoder, None).ok()?;
        context.write_to_bytes().ok()
    }

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn jpeg_scale_follows_pillow_draft() {
        assert_eq!(jpeg_scale(4000, 2000, Some(1024), MAX_IMAGE_PIXELS).unwrap(), 2);
        assert_eq!(jpeg_scale(8000, 4000, Some(1024), MAX_IMAGE_PIXELS).unwrap(), 4);
        assert_eq!(jpeg_scale(9000, 9000, Some(256), MAX_IMAGE_PIXELS).unwrap(), 8);
        assert_eq!(jpeg_scale(1000, 500, Some(1024), MAX_IMAGE_PIXELS).unwrap(), 1);
        assert_eq!(jpeg_scale(4000, 2000, None, MAX_IMAGE_PIXELS).unwrap(), 1);
        // Over twice the limit: drafted to twice the largest thumbnail, the hint is ignored.
        assert_eq!(jpeg_scale(4096, 2048, Some(256), 2_000_000).unwrap(), 2);
        let error = jpeg_scale(4096, 2048, Some(1024), 500_000).unwrap_err().to_string();
        assert!(error.starts_with("DecompressionBombError: Image size (8388608 pixels) exceeds limit of 1000000"));
        assert_eq!(draft_scale(10, 10, 0, 0), 8);
    }

    #[test]
    fn jpeg_orientation_reads_the_exif_segment() {
        let plain = jpeg_bytes(&solid(16, 8, [1, 2, 3]), None);
        assert_eq!(jpeg_orientation(&plain), Orientation::NoTransforms);
        assert_eq!(jpeg_orientation(&splice_exif(&plain, 6)), Orientation::Rotate90);
        assert_eq!(jpeg_orientation(&splice_exif(&plain, 3)), Orientation::Rotate180);
        assert_eq!(jpeg_orientation(&splice_exif(&plain, 42)), Orientation::NoTransforms);
        // Fill bytes and parameterless markers are skipped; a broken length stops the scan.
        assert_eq!(
            jpeg_orientation(&[0xFF, 0xD8, 0xFF, 0xFF, 0xD0, 0xFF, 0xD9, 0, 0]),
            Orientation::NoTransforms
        );
        assert_eq!(
            jpeg_orientation(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 1, 0, 0]),
            Orientation::NoTransforms
        );
        assert_eq!(jpeg_orientation(&[0xFF, 0xD8]), Orientation::NoTransforms);
    }

    #[test]
    fn jpeg_applies_exif_orientation_and_reduces() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "a.jpg", &jpeg_bytes(&two_tone(400, 200), Some(6)));
        let picture = open_image(&path, Some(100)).unwrap();
        assert_eq!((picture.width(), picture.height()), (50, 100));
        let picture = open_image(&path, None).unwrap();
        assert_eq!((picture.width(), picture.height()), (200, 400));
        // Rotated clockwise: the red left half is now on top.
        let top = picture.to_rgb8().get_pixel(100, 10).0;
        assert!(top[0] > 200 && top[2] < 60, "{top:?}");
    }

    #[test]
    fn grey_jpeg_becomes_rgb() {
        let dir = tempfile::tempdir().unwrap();
        let grey = DynamicImage::ImageLuma8(image::GrayImage::from_pixel(32, 16, image::Luma([90])));
        let path = write(&dir, "grey.jpg", &jpeg_bytes(&grey, None));
        assert!(matches!(
            open_image(&path, Some(1024)).unwrap(),
            DynamicImage::ImageRgb8(_)
        ));
    }

    #[test]
    fn cmyk_jpeg_falls_back_to_the_image_crate() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "cmyk.jpg", include_bytes!("../tests/fixtures/cmyk.jpg"));
        let picture = open_image(&path, Some(256)).unwrap();
        assert_eq!((picture.width(), picture.height()), (32, 16));
        // The fallback keeps the same limit.
        assert!(is_bomb(&open_image_limited(&path, None, 100).unwrap_err()));
    }

    #[test]
    fn lossless_jpeg_decodes_at_full_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "lossless.jpg", include_bytes!("../tests/fixtures/lossless.jpg"));
        let picture = open_image(&path, Some(8)).unwrap();
        assert_eq!((picture.width(), picture.height()), (64, 32));
        assert!(is_bomb(&open_image_limited(&path, None, 100).unwrap_err()));
    }

    #[test]
    fn broken_and_unknown_files_fail() {
        let dir = tempfile::tempdir().unwrap();
        let broken = write(&dir, "broken.jpg", b"\xFF\xD8\xFF\xE0garbage");
        assert!(
            open_image(&broken, None)
                .unwrap_err()
                .to_string()
                .starts_with("OSError")
        );
        let unknown = write(&dir, "notes.png", b"definitely not an image");
        assert!(
            open_image(&unknown, None)
                .unwrap_err()
                .to_string()
                .starts_with("UnidentifiedImageError")
        );
        let missing = dir.path().join("missing.png");
        assert!(
            open_image(&missing, None)
                .unwrap_err()
                .to_string()
                .starts_with("OSError")
        );
        let truncated_png = write(&dir, "cut.png", &palette_png(8, 8)[..40]);
        assert!(open_image(&truncated_png, None).is_err());
        let bad_heic = write(&dir, "bad.heic", b"\0\0\0\x18ftypheic\0\0\0\0garbage");
        assert!(
            open_image(&bad_heic, None)
                .unwrap_err()
                .to_string()
                .starts_with("HeifError")
        );
        let bad_avif = write(&dir, "bad.avif", b"\0\0\0\x18ftypavif\0\0\0\0garbage");
        assert!(open_image(&bad_avif, None).is_err());
        assert_eq!(heif_brand(b"\0\0\0\x18ftypqt  "), None);
    }

    #[test]
    fn modes_convert_to_rgb_or_rgba() {
        let dir = tempfile::tempdir().unwrap();
        let palette = write(&dir, "p.png", &palette_png(30, 15));
        let picture = open_image(&palette, None).unwrap();
        assert!(matches!(picture, DynamicImage::ImageRgb8(_)));
        assert_eq!(picture.to_rgb8().get_pixel(0, 0).0, [0, 255, 0]);

        let rgba16 = DynamicImage::ImageRgba16(image::ImageBuffer::from_pixel(4, 4, Rgba([1000u16, 0, 0, 30000])));
        let path = dir.path().join("rgba16.png");
        rgba16.save(&path).unwrap();
        assert!(matches!(open_image(&path, None).unwrap(), DynamicImage::ImageRgba8(_)));

        let la = DynamicImage::ImageLumaA8(image::ImageBuffer::from_pixel(4, 4, image::LumaA([9u8, 9])));
        assert!(matches!(to_rgb_or_rgba(la), DynamicImage::ImageRgb8(_)));
        let rgba = DynamicImage::ImageRgba8(RgbaImage::new(2, 2));
        assert!(matches!(to_rgb_or_rgba(rgba), DynamicImage::ImageRgba8(_)));
    }

    #[test]
    fn other_formats_decode_through_the_image_crate() {
        let dir = tempfile::tempdir().unwrap();
        let picture = solid(40, 20, [10, 20, 30]);
        for (name, format) in [
            ("a.gif", ImageFormat::Gif),
            ("a.bmp", ImageFormat::Bmp),
            ("a.tiff", ImageFormat::Tiff),
            ("a.webp", ImageFormat::WebP),
        ] {
            let path = dir.path().join(name);
            picture.save_with_format(&path, format).unwrap();
            let opened = open_image(&path, Some(16)).unwrap();
            assert_eq!((opened.width(), opened.height()), (40, 20), "{name}");
        }
    }

    #[test]
    fn non_jpeg_over_the_limit_is_a_bomb() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        solid(200, 100, [0, 0, 0]).save(&path).unwrap();
        assert!(open_image_limited(&path, None, 10_000).is_ok());
        let error = open_image_limited(&path, None, 9_999).unwrap_err().to_string();
        assert!(
            error.starts_with("DecompressionBombError: Image size (20000 pixels)"),
            "{error}"
        );
        let limit = image::error::LimitError::from_kind(image::error::LimitErrorKind::InsufficientMemory);
        assert!(is_bomb(&image_error(ImageError::Limits(limit))));
        let hint = image::error::ImageFormatHint::Unknown;
        let unsupported = image::error::UnsupportedError::from_format_and_kind(
            hint.clone(),
            image::error::UnsupportedErrorKind::Format(hint),
        );
        assert!(
            image_error(ImageError::Unsupported(unsupported))
                .to_string()
                .starts_with("UnidentifiedImageError")
        );
    }

    #[test]
    fn png_text_chunks_do_not_fail_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            &dir,
            "icon.png",
            &png_with_text(&solid(64, 64, [255, 255, 0]), 4 * 1024 * 1024),
        );
        let picture = open_image(&path, Some(1024)).unwrap();
        assert_eq!((picture.width(), picture.height()), (64, 64));
    }

    #[test]
    fn heic_decodes_through_libheif() {
        let dir = tempfile::tempdir().unwrap();
        let Some(opaque) = heif_bytes(64, 48, false, CompressionFormat::Hevc) else {
            eprintln!("skipped: libheif has no HEVC encoder");
            return;
        };
        let path = write(&dir, "a.heic", &opaque);
        let picture = open_image(&path, None).unwrap();
        assert!(matches!(picture, DynamicImage::ImageRgb8(_)));
        assert_eq!((picture.width(), picture.height()), (64, 48));
        assert!(is_bomb(&open_image_limited(&path, None, 1000).unwrap_err()));
        let alpha = heif_bytes(64, 48, true, CompressionFormat::Hevc).unwrap();
        let path = write(&dir, "alpha.heic", &alpha);
        assert!(matches!(open_image(&path, None).unwrap(), DynamicImage::ImageRgba8(_)));
    }

    #[test]
    fn avif_decodes() {
        let dir = tempfile::tempdir().unwrap();
        let Some(bytes) = heif_bytes(32, 24, false, CompressionFormat::Av1) else {
            eprintln!("skipped: libheif has no AV1 encoder");
            return;
        };
        let path = write(&dir, "photo.avif", &bytes);
        let picture = open_image(&path, Some(1024)).unwrap();
        assert_eq!((picture.width(), picture.height()), (32, 24));
        assert!(is_bomb(&open_image_limited(&path, None, 100).unwrap_err()));
    }
}
