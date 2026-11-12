//! Thumbnail generation I/O: `images` for pictures, `raw` for camera raw previews, MuPDF
//! for PDF first pages, ffmpeg for a video frame. Decisions (which kind, target sizes,
//! whether to skip) live in the pure `thumbs`; this module only touches disk and
//! subprocesses. Failures are reported and never raised: one bad file must never fail the
//! scan.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use fast_image_resize::{FilterType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, ImageReader, RgbImage};
use mupdf::{Colorspace, Document, Matrix};

use crate::chunking::is_raw;
use crate::failures::describe;
use crate::images::{MAX_IMAGE_PIXELS, open_image_limited};
use crate::raw::open_raw;
use crate::thumbs::{Kind, SIZES, kind_for_ext, resize_dimensions, skip_reason, storage_path};

const WEBP_QUALITY: f32 = 82.0;
const MEDIA_TOOL_TIMEOUT: Duration = Duration::from_secs(60);
/// Characters of a media tool's stderr kept in a failure message.
const STDERR_TAIL: usize = 1500;

/// One thumbnail on disk: its size class, path relative to the thumbnails directory and
/// actual dimensions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Generated {
    pub size: u32,
    pub rel_path: String,
    pub width: u32,
    pub height: u32,
}

/// Every size with a thumbnail on disk after the call, plus why the rest are missing:
/// `error` when generating failed, `skipped` when the source has nothing to render.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Generation {
    pub thumbs: Vec<Generated>,
    pub error: Option<String>,
    pub skipped: Option<String>,
}

/// The source was read and has nothing to render, such as a video without a picture.
#[derive(Debug)]
struct NoThumbnail(&'static str);

impl std::fmt::Display for NoThumbnail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for NoThumbnail {}

/// What `generate` depends on outside the file itself, replaceable in tests.
struct Tools {
    max_pixels: u64,
    ffmpeg: OsString,
    ffprobe: OsString,
    timeout: Duration,
}

impl Default for Tools {
    fn default() -> Self {
        Self {
            max_pixels: MAX_IMAGE_PIXELS,
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
            timeout: MEDIA_TOOL_TIMEOUT,
        }
    }
}

/// Generate the missing thumbnail sizes for one file. With `force`, every size is deleted
/// (if present) and rewritten, which is how the rebuild pass regenerates thumbnails that
/// already exist; without it, an existing file for the same sha256 and size is kept and
/// only read back for its dimensions.
#[allow(clippy::too_many_arguments)]
pub fn generate(
    abs_path: &Path,
    ext: &str,
    sha256: &str,
    size_bytes: u64,
    thumbs_dir: &Path,
    max_bytes: u64,
    force: bool,
    log: &dyn Fn(&str),
) -> Generation {
    let request = Request {
        abs_path,
        ext,
        sha256,
        size_bytes,
        thumbs_dir,
        max_bytes,
        force,
    };
    generate_with(&request, log, &Tools::default())
}

struct Request<'a> {
    abs_path: &'a Path,
    ext: &'a str,
    sha256: &'a str,
    size_bytes: u64,
    thumbs_dir: &'a Path,
    max_bytes: u64,
    force: bool,
}

fn generate_with(request: &Request<'_>, log: &dyn Fn(&str), tools: &Tools) -> Generation {
    let Some(kind) = kind_for_ext(request.ext) else {
        return Generation::default();
    };
    let shown = request.abs_path.display();
    if let Some(reason) = skip_reason(request.size_bytes, request.max_bytes) {
        log(&format!("thumb: skip {shown}: {reason}"));
        return Generation::default();
    }
    let mut thumbs = Vec::new();
    let outcome = catch_unwind(AssertUnwindSafe(|| write_sizes(request, kind, tools, &mut thumbs)))
        .unwrap_or_else(|_| Err(anyhow!("PanicException: thumbnail generation panicked")));
    match outcome {
        Ok(()) => Generation {
            thumbs,
            ..Generation::default()
        },
        Err(error) => match error.downcast_ref::<NoThumbnail>() {
            Some(reason) => {
                log(&format!("thumb: skip {shown}: {reason}"));
                Generation {
                    thumbs,
                    skipped: Some(reason.to_string()),
                    error: None,
                }
            }
            None => {
                let reason = describe(&error);
                log(&format!(
                    "thumb: failed for {shown} ({}/{} sizes available): {reason}",
                    thumbs.len(),
                    SIZES.len()
                ));
                Generation {
                    thumbs,
                    error: Some(reason),
                    skipped: None,
                }
            }
        },
    }
}

fn write_sizes(request: &Request<'_>, kind: Kind, tools: &Tools, thumbs: &mut Vec<Generated>) -> Result<()> {
    let present: Vec<bool> = SIZES
        .iter()
        .map(|&size| request.thumbs_dir.join(storage_path(request.sha256, size)).exists())
        .collect();
    let regenerate = |i: usize| request.force || !present[i];
    let largest = (0..SIZES.len()).filter(|&i| regenerate(i)).map(|i| SIZES[i]).max();
    let mut picture: Option<DynamicImage> = None;
    for (i, &size) in SIZES.iter().enumerate() {
        let rel_path = storage_path(request.sha256, size);
        let dest = request.thumbs_dir.join(&rel_path);
        if !regenerate(i) {
            let (width, height) =
                image::image_dimensions(&dest).map_err(|e| anyhow!("OSError: {}: {e}", dest.display()))?;
            thumbs.push(Generated {
                size,
                rel_path,
                width,
                height,
            });
            continue;
        }
        if present[i] {
            match std::fs::remove_file(&dest) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => bail!("OSError: {}: {e}", dest.display()),
                _ => {}
            }
        }
        let largest_picture = match &mut picture {
            Some(decoded) => &*decoded,
            slot @ None => {
                let largest = largest.unwrap_or(size);
                let source = decode_source(request, kind, largest, tools)?;
                // Scale once to the largest size needed; smaller sizes derive from that
                // instead of resampling the full-resolution source again.
                let fitted = fit(&source, largest)?;
                slot.insert(fitted.unwrap_or(source))
            }
        };
        let fitted = fit(largest_picture, size)?;
        let out = fitted.as_ref().unwrap_or(largest_picture);
        save_webp(out, &dest)?;
        thumbs.push(Generated {
            size,
            rel_path,
            width: out.width(),
            height: out.height(),
        });
    }
    Ok(())
}

fn decode_source(request: &Request<'_>, kind: Kind, largest: u32, tools: &Tools) -> Result<DynamicImage> {
    match kind {
        Kind::Image if is_raw(request.ext) => open_raw(request.abs_path, Some(largest)),
        Kind::Image => open_image_limited(request.abs_path, Some(largest), tools.max_pixels),
        Kind::Pdf => render_pdf_page(request.abs_path, 0, 72.0),
        Kind::Video => extract_video_frame(request.abs_path, tools),
    }
}

/// `picture` scaled down with bicubic (Catmull-Rom, as Pillow's default) so its longest
/// side is at most `size`; None when it already fits.
fn fit(picture: &DynamicImage, size: u32) -> Result<Option<DynamicImage>> {
    let (width, height) = resize_dimensions(picture.width(), picture.height(), size);
    if (width, height) == (picture.width(), picture.height()) {
        return Ok(None);
    }
    let mut resized = DynamicImage::new(width, height, picture.color());
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::CatmullRom));
    Resizer::new()
        .resize(picture, &mut resized, &options)
        .map_err(|e| anyhow!("ValueError: resize failed: {e}"))?;
    Ok(Some(resized))
}

/// Encode `picture` as lossy WebP next to `dest` and rename it into place, so a reader
/// never sees a partial file.
fn save_webp(picture: &DynamicImage, dest: &Path) -> Result<()> {
    let (width, height) = (picture.width(), picture.height());
    let encoded = match picture {
        DynamicImage::ImageRgba8(buffer) => webp::Encoder::from_rgba(buffer.as_raw(), width, height),
        DynamicImage::ImageRgb8(buffer) => webp::Encoder::from_rgb(buffer.as_raw(), width, height),
        other => return save_webp(&DynamicImage::ImageRgb8(other.to_rgb8()), dest),
    }
    .encode_simple(false, WEBP_QUALITY)
    .map_err(|e| anyhow!("OSError: WebP encoding failed: {e:?}"))?;
    let dir = dest
        .parent()
        .ok_or_else(|| anyhow!("OSError: {} has no parent", dest.display()))?;
    let io_error = |e: io::Error| anyhow!("OSError: {}: {e}", dest.display());
    std::fs::create_dir_all(dir).map_err(io_error)?;
    let mut temp = tempfile::Builder::new()
        .prefix(".thumb-")
        .suffix(".tmp")
        .tempfile_in(dir)
        .map_err(io_error)?;
    temp.write_all(&encoded).map_err(io_error)?;
    temp.persist(dest).map_err(|e| io_error(e.error))?;
    Ok(())
}

/// Page `page` (0-based) of the PDF at `path` rendered at `dpi` as RGB without alpha,
/// annotations included, as pymupdf's `get_pixmap` does (72 dpi is its default).
pub fn render_pdf_page(path: &Path, page: i32, dpi: f32) -> Result<DynamicImage> {
    let document = Document::open(path).map_err(|e| anyhow!("FileDataError: {e}"))?;
    let pages = document.page_count().map_err(|e| anyhow!("FileDataError: {e}"))?;
    if pages == 0 {
        bail!("ValueError: empty pdf");
    }
    if !(0..pages).contains(&page) {
        bail!("IndexError: page {page} not in document");
    }
    let mupdf_error = |e: mupdf::Error| anyhow!("RuntimeError: {e}");
    let loaded = document.load_page(page).map_err(mupdf_error)?;
    let scale = dpi / 72.0;
    let pixmap = loaded
        .to_pixmap(&Matrix::new_scale(scale, scale), &Colorspace::device_rgb(), false, true)
        .map_err(mupdf_error)?;
    if pixmap.n() != 3 {
        bail!("RuntimeError: unexpected {} components per pixel", pixmap.n());
    }
    let (width, height) = (pixmap.width(), pixmap.height());
    let row = width as usize * 3;
    let stride = usize::try_from(pixmap.stride()).unwrap_or(0).max(row).max(1);
    let mut pixels = Vec::with_capacity(row * height as usize);
    for line in pixmap.samples().chunks(stride).take(height as usize) {
        pixels.extend_from_slice(
            line.get(..row)
                .ok_or_else(|| anyhow!("RuntimeError: short pixmap row"))?,
        );
    }
    let buffer =
        RgbImage::from_raw(width, height, pixels).ok_or_else(|| anyhow!("RuntimeError: pixmap has the wrong size"))?;
    Ok(DynamicImage::ImageRgb8(buffer))
}

fn video_frame_filter() -> String {
    let largest = SIZES.iter().copied().max().unwrap_or(1024);
    format!("thumbnail,scale=w='min(iw,{largest})':h='min(ih,{largest})':force_original_aspect_ratio=decrease")
}

fn extract_video_frame(abs_path: &Path, tools: &Tools) -> Result<DynamicImage> {
    let frame = tempfile::Builder::new()
        .prefix("fdrive-frame-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| anyhow!("OSError: {e}"))?;
    let written = || std::fs::metadata(frame.path()).map(|m| m.len()).unwrap_or(0);
    write_video_frame(abs_path, frame.path(), "1.0", tools)?;
    if written() == 0 {
        // ffmpeg exits successfully without writing a frame when a clip ends before the seek point.
        write_video_frame(abs_path, frame.path(), "0.0", tools)?;
    }
    if written() == 0 {
        bail!("ValueError: ffmpeg wrote no video frame");
    }
    let picture = ImageReader::open(frame.path())
        .and_then(ImageReader::with_guessed_format)
        .map_err(|e| anyhow!("OSError: {e}"))?
        .decode()
        .map_err(|e| anyhow!("OSError: {e}"))?;
    Ok(DynamicImage::ImageRgb8(picture.to_rgb8()))
}

fn write_video_frame(abs_path: &Path, dest: &Path, at_seconds: &str, tools: &Tools) -> Result<()> {
    let filter = video_frame_filter();
    // Pick the frame first, then shrink it so a 4K frame is never encoded and decoded again
    // as a full-size PNG.
    let args = |input: OsString| -> Vec<OsString> {
        let mut args: Vec<OsString> = ["-nostdin", "-y", "-ss", at_seconds, "-i"].map(OsString::from).to_vec();
        args.push(input);
        args.extend(["-frames:v", "1", "-vf", filter.as_str()].map(OsString::from));
        args.push(dest.as_os_str().to_owned());
        args
    };
    match run_media_tool(&tools.ffmpeg, abs_path, args, tools.timeout) {
        Ok(_) => Ok(()),
        Err(ToolError::Failed { status, stderr }) => {
            if has_video_stream(abs_path, tools) == Some(false) {
                return Err(NoThumbnail("no video stream").into());
            }
            let stderr = String::from_utf8_lossy(&stderr);
            let skip = stderr.chars().count().saturating_sub(STDERR_TAIL);
            let tail: String = stderr.chars().skip(skip).collect();
            if tail.is_empty() {
                bail!("CalledProcessError: Command 'ffmpeg' returned non-zero exit status {status}.");
            }
            bail!("CalledProcessError: {tail}");
        }
        Err(error) => Err(error.into_error("ffmpeg", tools.timeout)),
    }
}

/// Whether ffprobe finds a video stream; None when it cannot read the container either.
fn has_video_stream(abs_path: &Path, tools: &Tools) -> Option<bool> {
    let args = |input: OsString| -> Vec<OsString> {
        let mut args: Vec<OsString> = [
            "-v",
            "error",
            "-select_streams",
            "v",
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
        ]
        .map(OsString::from)
        .to_vec();
        args.push(input);
        args
    };
    let stdout = run_media_tool(&tools.ffprobe, abs_path, args, tools.timeout).ok()?;
    Some(!String::from_utf8_lossy(&stdout).trim().is_empty())
}

#[derive(Debug)]
enum ToolError {
    Spawn(io::Error),
    Timeout,
    Failed { status: i32, stderr: Vec<u8> },
}

impl ToolError {
    fn into_error(self, name: &str, timeout: Duration) -> anyhow::Error {
        match self {
            ToolError::Spawn(e) if e.kind() == io::ErrorKind::NotFound => anyhow!("FileNotFoundError: {name}: {e}"),
            ToolError::Spawn(e) => anyhow!("OSError: {name}: {e}"),
            ToolError::Timeout => anyhow!(
                "TimeoutExpired: Command '{name}' timed out after {} seconds",
                timeout.as_secs_f64()
            ),
            ToolError::Failed { status, .. } => {
                anyhow!("CalledProcessError: Command '{name}' returned non-zero exit status {status}.")
            }
        }
    }
}

/// The path a media tool opens for `abs_path`, and its stdin. A descriptor path
/// (`/proc/self/fd/N`, `/dev/fd/N`) names a descriptor of this process that a child does
/// not inherit, so the file is handed to the child as its stdin and named as descriptor 0.
fn media_input(abs_path: &Path) -> io::Result<(OsString, Stdio)> {
    let text = abs_path.to_string_lossy();
    for prefix in ["/proc/self/fd/", "/dev/fd/"] {
        if let Some(fd) = text.strip_prefix(prefix)
            && !fd.is_empty()
            && fd.bytes().all(|b| b.is_ascii_digit())
        {
            let file = File::open(abs_path)?;
            return Ok((format!("{prefix}0").into(), Stdio::from(file)));
        }
    }
    Ok((abs_path.as_os_str().to_owned(), Stdio::null()))
}

/// Run a media tool on `abs_path` with a timeout and return its stdout.
fn run_media_tool(
    program: &OsString,
    abs_path: &Path,
    args: impl FnOnce(OsString) -> Vec<OsString>,
    timeout: Duration,
) -> Result<Vec<u8>, ToolError> {
    let (input, stdin) = media_input(abs_path).map_err(ToolError::Spawn)?;
    let mut child = Command::new(program)
        .args(args(input))
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(ToolError::Spawn)?;
    let drain = |stream: Option<Box<dyn Read + Send>>| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    match status {
        None => Err(ToolError::Timeout),
        Some(status) if status.success() => Ok(stdout),
        Some(status) => Err(ToolError::Failed {
            status: status.code().unwrap_or(-1),
            stderr,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::images::tests::{heif_bytes, jpeg_bytes, palette_png, png_with_text, solid, two_tone};
    use crate::raw::tests::{DngParts, write_dng};
    use libheif_rs::CompressionFormat;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    struct Run {
        generation: Generation,
        logs: Vec<String>,
    }

    fn run(src: &Path, ext: &str, sha: &str, thumbs: &Path, force: bool, tools: &Tools) -> Run {
        run_sized(
            src,
            ext,
            sha,
            std::fs::metadata(src).map(|m| m.len()).unwrap_or(0),
            10_000_000,
            thumbs,
            force,
            tools,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn run_sized(
        src: &Path,
        ext: &str,
        sha: &str,
        size_bytes: u64,
        max_bytes: u64,
        thumbs: &Path,
        force: bool,
        tools: &Tools,
    ) -> Run {
        let logs = RefCell::new(Vec::new());
        let log = |line: &str| logs.borrow_mut().push(line.to_owned());
        let request = Request {
            abs_path: src,
            ext,
            sha256: sha,
            size_bytes,
            thumbs_dir: thumbs,
            max_bytes,
            force,
        };
        let generation = generate_with(&request, &log, tools);
        Run {
            generation,
            logs: logs.into_inner(),
        }
    }

    fn dims(generation: &Generation) -> Vec<(u32, u32, u32)> {
        generation.thumbs.iter().map(|t| (t.size, t.width, t.height)).collect()
    }

    fn sizes(generation: &Generation) -> Vec<u32> {
        generation.thumbs.iter().map(|t| t.size).collect()
    }

    fn assert_webp_files(thumbs: &Path, generation: &Generation) {
        for thumb in &generation.thumbs {
            let path = thumbs.join(&thumb.rel_path);
            let bytes = std::fs::read(&path).unwrap();
            assert_eq!((&bytes[..4], &bytes[8..12]), (&b"RIFF"[..], &b"WEBP"[..]));
            assert_eq!(image::image_dimensions(&path).unwrap(), (thumb.width, thumb.height));
        }
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn jpeg(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
        write(dir, name, &jpeg_bytes(&solid(width, height, [200, 30, 30]), None))
    }

    /// A fake media tool: a shell script with `body`, which sees its arguments as "$@".
    fn script(dir: &Path, name: &str, body: &str) -> OsString {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.into_os_string()
    }

    fn fake_tools(dir: &Path, ffmpeg: &str, ffprobe: &str) -> Tools {
        Tools {
            ffmpeg: script(dir, "ffmpeg", ffmpeg),
            ffprobe: script(dir, "ffprobe", ffprobe),
            ..Tools::default()
        }
    }

    fn ffmpeg(args: &[&str]) -> bool {
        Command::new("ffmpeg")
            .args(["-v", "error", "-y"])
            .args(args)
            .output()
            .is_ok_and(|o| o.status.success())
    }

    fn has_ffmpeg() -> bool {
        let found = Command::new("ffmpeg").arg("-version").output().is_ok();
        if !found {
            eprintln!("skipped: ffmpeg is not installed");
        }
        found
    }

    #[test]
    fn image_writes_both_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 2000, 1000);
        let thumbs = dir.path().join("thumbs");
        let result = run(&src, ".jpg", "abc123", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 256, 128), (1024, 1024, 512)]);
        assert_eq!(result.generation.thumbs[0].rel_path, "ab/abc123.256.webp");
        assert_eq!(
            (result.generation.error, result.generation.skipped, result.logs.len()),
            (None, None, 0)
        );
        assert_webp_files(
            &thumbs,
            &generate(&src, ".jpg", "abc123", 1, &thumbs, 10, false, &|_| {}),
        );
    }

    #[test]
    fn large_jpeg_keeps_exact_sizes_and_exif_orientation() {
        let dir = tempfile::tempdir().unwrap();
        let src = write(
            dir.path(),
            "camera.jpg",
            &jpeg_bytes(&solid(4000, 2000, [255, 165, 0]), Some(6)),
        );
        let thumbs = dir.path().join("thumbs");
        let result = run(&src, ".jpg", "camerasha", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 128, 256), (1024, 512, 1024)]);
        assert_webp_files(&thumbs, &result.generation);
    }

    #[test]
    fn missing_small_size_leaves_existing_large_size() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 3000, 1500);
        let thumbs = dir.path().join("thumbs");
        let first = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default()).generation;
        let small = thumbs.join(&first.thumbs[0].rel_path);
        let large = thumbs.join(&first.thumbs[1].rel_path);
        std::fs::remove_file(&small).unwrap();
        let written = std::fs::metadata(&large).unwrap().modified().unwrap();

        let second = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default()).generation;

        assert_eq!(second, first);
        assert_eq!(std::fs::metadata(&large).unwrap().modified().unwrap(), written);
        assert_eq!(image::image_dimensions(&small).unwrap(), (256, 128));
    }

    #[test]
    fn existing_thumbnails_are_read_back_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 200, 100);
        let thumbs = dir.path().join("thumbs");
        let first = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default()).generation;
        assert_eq!(dims(&first), [(256, 200, 100), (1024, 200, 100)]);
        let before: Vec<Vec<u8>> = first
            .thumbs
            .iter()
            .map(|t| std::fs::read(thumbs.join(&t.rel_path)).unwrap())
            .collect();
        // Even an unreadable source is not opened again.
        std::fs::write(&src, b"gone").unwrap();
        let second = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default()).generation;
        assert_eq!(second, first);
        let after: Vec<Vec<u8>> = first
            .thumbs
            .iter()
            .map(|t| std::fs::read(thumbs.join(&t.rel_path)).unwrap())
            .collect();
        assert_eq!(after, before);
    }

    #[test]
    fn force_deletes_and_rewrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 200, 100);
        let thumbs = dir.path().join("thumbs");
        let first = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default()).generation;
        for thumb in &first.thumbs {
            std::fs::write(thumbs.join(&thumb.rel_path), b"stale").unwrap();
        }
        let second = run(&src, ".jpg", "sha1", &thumbs, true, &Tools::default()).generation;
        assert_eq!(second, first);
        assert_webp_files(&thumbs, &second);
        let leftovers = std::fs::read_dir(thumbs.join("sh")).unwrap().count();
        assert_eq!(leftovers, 2, "no temporary files are left behind");
    }

    #[test]
    fn unreadable_existing_thumbnail_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 200, 100);
        let thumbs = dir.path().join("thumbs");
        std::fs::create_dir_all(thumbs.join("sh")).unwrap();
        std::fs::write(thumbs.join(storage_path("sha1", 256)), b"stale").unwrap();
        let result = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default());
        assert!(result.generation.error.unwrap().starts_with("OSError"));
        assert_eq!(result.logs.len(), 1);
        assert!(result.logs[0].contains("(0/2 sizes available)"), "{}", result.logs[0]);
    }

    #[test]
    fn unwritable_thumbnail_directory_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "photo.jpg", 200, 100);
        let thumbs = write(dir.path(), "thumbs", b"a file, not a directory");
        let result = run(&src, ".jpg", "sha1", &thumbs, false, &Tools::default());
        assert!(result.generation.error.unwrap().starts_with("OSError"));
        assert!(result.generation.thumbs.is_empty());
    }

    #[test]
    fn heic_image_writes_both_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let Some(bytes) = heif_bytes(1200, 800, false, CompressionFormat::Hevc) else {
            eprintln!("skipped: libheif has no HEVC encoder");
            return;
        };
        let src = write(dir.path(), "photo.heic", &bytes);
        let thumbs = dir.path().join("thumbs");
        let result = run(&src, ".heic", "heicsha123", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 256, 171), (1024, 1024, 683)]);
        assert_webp_files(&thumbs, &result.generation);
    }

    #[test]
    fn avif_generates_thumbnails() {
        let dir = tempfile::tempdir().unwrap();
        let Some(bytes) = heif_bytes(32, 24, false, CompressionFormat::Av1) else {
            eprintln!("skipped: libheif has no AV1 encoder");
            return;
        };
        let src = write(dir.path(), "photo.avif", &bytes);
        let thumbs = dir.path().join("thumbs");
        let result = run(&src, ".avif", "avif-sha", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 32, 24), (1024, 32, 24)]);
    }

    #[test]
    fn palette_and_alpha_images_are_written() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = dir.path().join("thumbs");
        let palette = write(dir.path(), "palette.png", &palette_png(300, 150));
        let result = run(&palette, ".png", "palettesha", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 256, 128), (1024, 300, 150)]);

        let rgba = dir.path().join("alpha.png");
        DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(600, 300, image::Rgba([0, 0, 255, 128])))
            .save(&rgba)
            .unwrap();
        let result = run(&rgba, ".png", "alphasha", &thumbs, false, &Tools::default());
        assert_eq!(sizes(&result.generation), [256, 1024]);
        assert_webp_files(&thumbs, &result.generation);
    }

    #[test]
    fn unknown_extension_returns_empty_without_logging() {
        let dir = tempfile::tempdir().unwrap();
        let src = write(dir.path(), "notes.txt", b"hello");
        let result = run_sized(
            &src,
            ".txt",
            "sha1",
            5,
            1000,
            &dir.path().join("thumbs"),
            false,
            &Tools::default(),
        );
        assert_eq!(result.generation, Generation::default());
        assert!(result.logs.is_empty());
    }

    #[test]
    fn empty_file_logs_skip_without_decoding() {
        let dir = tempfile::tempdir().unwrap();
        let src = write(dir.path(), "empty.png", b"");
        let result = run_sized(
            &src,
            ".png",
            "empty",
            0,
            1000,
            &dir.path().join("thumbs"),
            false,
            &Tools::default(),
        );
        assert_eq!(result.generation, Generation::default());
        assert_eq!(result.logs, [format!("thumb: skip {}: empty file", src.display())]);
    }

    #[test]
    fn over_budget_returns_empty_without_decoding() {
        let dir = tempfile::tempdir().unwrap();
        // Not an image at all: decoding it would fail loudly.
        let src = write(dir.path(), "photo.jpg", b"not a jpeg");
        let result = run_sized(
            &src,
            ".jpg",
            "sha1",
            1_000_000,
            10,
            &dir.path().join("thumbs"),
            false,
            &Tools::default(),
        );
        assert_eq!(result.generation, Generation::default());
        assert_eq!(result.logs.len(), 1);
        assert!(result.logs[0].contains("over budget"));
    }

    #[test]
    fn pdf_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("doc.pdf");
        let mut document = mupdf::pdf::PdfDocument::new();
        document.new_page((400.0, 800.0)).unwrap();
        document.new_page((100.0, 100.0)).unwrap();
        document.save(pdf.to_str().unwrap()).unwrap();

        let thumbs = dir.path().join("thumbs");
        let result = run(&pdf, ".pdf", "pdfsha", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 128, 256), (1024, 400, 800)]);

        let page = render_pdf_page(&pdf, 0, 200.0).unwrap();
        // MuPDF rounds the scaled page box outwards, as pymupdf does.
        assert_eq!((page.width(), page.height()), (1112, 2223));
        assert!(matches!(page, DynamicImage::ImageRgb8(_)));
        assert_eq!(page.to_rgb8().get_pixel(5, 5).0, [255, 255, 255]);
        let second = render_pdf_page(&pdf, 1, 72.0).unwrap();
        assert_eq!((second.width(), second.height()), (100, 100));
        assert!(
            render_pdf_page(&pdf, 2, 72.0)
                .unwrap_err()
                .to_string()
                .starts_with("IndexError")
        );
        assert!(render_pdf_page(&pdf, -1, 72.0).is_err());
    }

    #[test]
    fn other_layouts_are_saved_as_rgb() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("ab").join("grey.webp");
        save_webp(&DynamicImage::ImageLuma8(image::GrayImage::new(10, 5)), &dest).unwrap();
        assert_eq!(image::image_dimensions(&dest).unwrap(), (10, 5));
        assert!(
            save_webp(&solid(2, 2, [0, 0, 0]), Path::new("/"))
                .unwrap_err()
                .to_string()
                .contains("no parent")
        );
    }

    #[test]
    fn empty_pdf_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = dir.path().join("empty.pdf");
        mupdf::pdf::PdfDocument::new().save(pdf.to_str().unwrap()).unwrap();
        assert_eq!(
            render_pdf_page(&pdf, 0, 72.0).unwrap_err().to_string(),
            "ValueError: empty pdf"
        );
    }

    #[test]
    fn corrupt_pdf_fails_gracefully() {
        let dir = tempfile::tempdir().unwrap();
        let pdf = write(dir.path(), "corrupt.pdf", b"not a real pdf at all");
        let result = run(
            &pdf,
            ".pdf",
            "sha",
            &dir.path().join("thumbs"),
            false,
            &Tools::default(),
        );
        assert!(result.generation.thumbs.is_empty());
        assert!(result.generation.error.unwrap().starts_with("FileDataError"));
        assert!(result.logs[0].starts_with(&format!("thumb: failed for {} (0/2 sizes available): ", pdf.display())));
    }

    #[test]
    fn video_frame_from_ffmpeg() {
        let dir = tempfile::tempdir().unwrap();
        let frame = dir.path().join("frame.png");
        solid(640, 360, [0, 128, 0]).save(&frame).unwrap();
        let video = write(dir.path(), "clip.mp4", b"not a real video, ffmpeg is faked");
        let body = format!(
            "for a in \"$@\"; do last=\"$a\"; done\ncp '{}' \"$last\"",
            frame.display()
        );
        let tools = fake_tools(dir.path(), &body, "exit 1");
        let result = run(&video, ".mp4", "videosha", &dir.path().join("thumbs"), false, &tools);
        assert_eq!(dims(&result.generation), [(256, 256, 144), (1024, 640, 360)]);
    }

    #[test]
    fn video_failure_without_ffprobe_answer_is_a_failure() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "clip.mp4", b"broken");
        let tools = fake_tools(dir.path(), "exit 1", "exit 1");
        let result = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools);
        assert!(result.generation.thumbs.is_empty());
        assert_eq!(
            result.generation.error.as_deref(),
            Some("CalledProcessError: Command 'ffmpeg' returned non-zero exit status 1.")
        );
        assert!(result.logs[0].contains("failed"));
    }

    #[test]
    fn video_without_any_frame_reports_why() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "empty-track.mp4", b"faked");
        let seeks = dir.path().join("seeks");
        let body = format!(
            "while [ \"$1\" != \"-ss\" ]; do shift; done\necho \"$2\" >> '{}'",
            seeks.display()
        );
        let tools = fake_tools(dir.path(), &body, "exit 1");
        let result = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools);
        assert!(result.generation.thumbs.is_empty());
        assert_eq!(std::fs::read_to_string(&seeks).unwrap(), "1.0\n0.0\n");
        assert_eq!(
            result.generation.error.as_deref(),
            Some("ValueError: ffmpeg wrote no video frame")
        );
    }

    #[test]
    fn video_failure_with_picture_track_is_not_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "clip.mp4", b"faked");
        let tools = fake_tools(dir.path(), "printf 'decoder failed' >&2\nexit 1", "echo 0");
        let result = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools);
        assert_eq!(result.generation.skipped, None);
        assert_eq!(
            result.generation.error.as_deref(),
            Some("CalledProcessError: decoder failed")
        );
    }

    #[test]
    fn video_stderr_is_cut_to_its_tail() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "clip.mp4", b"faked");
        let tools = fake_tools(
            dir.path(),
            "head -c 3000 /dev/zero | tr '\\0' 'e' >&2\nprintf 'END' >&2\nexit 1",
            "echo 0",
        );
        let error = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools)
            .generation
            .error
            .unwrap();
        assert_eq!(error.len(), "CalledProcessError: ".len() + STDERR_TAIL);
        assert!(error.ends_with("eeeEND"));
    }

    #[test]
    fn audio_only_video_per_ffprobe_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "voice.mp4", b"faked");
        let tools = fake_tools(dir.path(), "exit 1", "exit 0");
        let result = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools);
        assert_eq!(
            result.generation,
            Generation {
                skipped: Some("no video stream".into()),
                ..Generation::default()
            }
        );
        assert_eq!(
            result.logs,
            [format!("thumb: skip {}: no video stream", video.display())]
        );
    }

    #[test]
    fn media_tool_timeouts_and_missing_tools_fail() {
        let dir = tempfile::tempdir().unwrap();
        let video = write(dir.path(), "clip.mp4", b"faked");
        let tools = Tools {
            timeout: Duration::from_millis(200),
            ..fake_tools(dir.path(), "exec sleep 5", "exit 1")
        };
        let started = Instant::now();
        let error = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools)
            .generation
            .error
            .unwrap();
        assert!(
            error.starts_with("TimeoutExpired: Command 'ffmpeg' timed out"),
            "{error}"
        );
        assert!(started.elapsed() < Duration::from_secs(4));

        let missing = Tools {
            ffmpeg: dir.path().join("no-ffmpeg").into(),
            ..Tools::default()
        };
        let error = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &missing)
            .generation
            .error
            .unwrap();
        assert!(error.starts_with("FileNotFoundError: ffmpeg"), "{error}");
        let not_executable = write(dir.path(), "plain", b"");
        let denied = Tools {
            ffmpeg: not_executable.into(),
            ..Tools::default()
        };
        let error = run(&video, ".mp4", "sha", &dir.path().join("thumbs"), false, &denied)
            .generation
            .error
            .unwrap();
        assert!(error.starts_with("OSError: ffmpeg"), "{error}");
        assert!(
            ToolError::Failed {
                status: 2,
                stderr: vec![]
            }
            .into_error("x", MEDIA_TOOL_TIMEOUT)
            .to_string()
            .contains("status 2")
        );
    }

    #[test]
    fn descriptor_paths_reach_media_tools_as_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let src = write(dir.path(), "clip.mp4", b"the clip");
        let file = File::open(&src).unwrap();
        let path = crate::fsx::descriptor_path(&file);
        let (input, _) = media_input(&path).unwrap();
        assert!(input.to_string_lossy().ends_with("/fd/0"), "{input:?}");
        let (input, _) = media_input(Path::new("/dev/fd/x")).unwrap();
        assert_eq!(input, "/dev/fd/x");
        let (input, _) = media_input(Path::new("/dev/fd/")).unwrap();
        assert_eq!(input, "/dev/fd/");
        let copied = dir.path().join("copied");
        let body = format!(
            "while [ \"$1\" != \"-i\" ]; do shift; done\ncat \"$2\" > '{}'\nexit 1",
            copied.display()
        );
        let tools = fake_tools(dir.path(), &body, "exit 1");
        run(&path, ".mp4", "sha", &dir.path().join("thumbs"), false, &tools);
        assert_eq!(std::fs::read(&copied).unwrap(), b"the clip");
    }

    #[test]
    fn real_ffmpeg_short_audio_only_and_truncated_videos() {
        if !has_ffmpeg() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let thumbs = dir.path().join("thumbs");
        let short = dir.path().join("short.mp4");
        assert!(ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=0.5:size=320x240:rate=30",
            short.to_str().unwrap()
        ]));
        let result = run(&short, ".mp4", "shortsha", &thumbs, false, &Tools::default());
        assert_eq!(result.generation.error, None);
        assert_eq!(dims(&result.generation), [(256, 256, 192), (1024, 320, 240)]);

        let voice = dir.path().join("voice.mp4");
        assert!(ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "sine=duration=2",
            "-c:a",
            "aac",
            voice.to_str().unwrap()
        ]));
        let result = run(&voice, ".mp4", "voicesha", &thumbs, false, &Tools::default());
        assert_eq!(
            result.generation,
            Generation {
                skipped: Some("no video stream".into()),
                ..Generation::default()
            }
        );
        assert_eq!(
            result.logs,
            [format!("thumb: skip {}: no video stream", voice.display())]
        );

        let cut = dir.path().join("truncated.mp4");
        assert!(ffmpeg(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=30",
            cut.to_str().unwrap()
        ]));
        let bytes = std::fs::read(&cut).unwrap();
        std::fs::write(&cut, &bytes[..2048]).unwrap();
        let result = run(&cut, ".mp4", "cutsha", &thumbs, false, &Tools::default());
        assert_eq!((result.generation.thumbs.len(), result.generation.skipped), (0, None));
        assert!(result.generation.error.unwrap().starts_with("CalledProcessError"));

        // A descriptor path, as the indexer passes for files opened below a root.
        let file = File::open(&short).unwrap();
        let result = run(
            &crate::fsx::descriptor_path(&file),
            ".mp4",
            "fdsha",
            &thumbs,
            false,
            &Tools::default(),
        );
        assert_eq!(result.generation.error, None);
        assert_eq!(sizes(&result.generation), [256, 1024]);
    }

    #[test]
    fn jpeg_over_pillow_pixel_limit_decodes_reduced() {
        let dir = tempfile::tempdir().unwrap();
        let src = jpeg(dir.path(), "panorama.jpg", 4096, 2048);
        // 8.4 MP is over twice this limit; the JPEG drafted to 2048x1024 is not.
        let tools = Tools {
            max_pixels: 2_000_000,
            ..Tools::default()
        };
        let result = run(&src, ".jpg", "panosha", &dir.path().join("thumbs"), false, &tools);
        assert_eq!(result.generation.error, None);
        assert_eq!(dims(&result.generation), [(256, 256, 128), (1024, 1024, 512)]);
    }

    #[test]
    fn image_still_over_pixel_limit_fails() {
        let dir = tempfile::tempdir().unwrap();
        let jpeg_path = jpeg(dir.path(), "huge.jpg", 4096, 2048);
        let png_path = dir.path().join("huge.png");
        solid(4096, 2048, [0, 0, 0]).save(&png_path).unwrap();
        let tools = Tools {
            max_pixels: 500_000,
            ..Tools::default()
        };
        for (src, ext) in [(jpeg_path, ".jpg"), (png_path, ".png")] {
            let result = run(&src, ext, "bigsha", &dir.path().join("thumbs"), false, &tools);
            assert!(result.generation.thumbs.is_empty());
            assert!(
                result.generation.error.unwrap().starts_with("DecompressionBombError"),
                "{}",
                src.display()
            );
        }
    }

    #[test]
    fn png_with_large_compressed_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let src = write(
            dir.path(),
            "icon.png",
            &png_with_text(&solid(64, 64, [255, 255, 0]), 4 * 1024 * 1024),
        );
        let result = run(
            &src,
            ".png",
            "iconsha",
            &dir.path().join("thumbs"),
            false,
            &Tools::default(),
        );
        assert_eq!(result.generation.error, None);
        assert_eq!(sizes(&result.generation), [256, 1024]);
    }

    #[test]
    fn raw_extensions_go_through_rawler_not_the_image_decoder() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = dir.path().join("thumbs");
        // A perfectly good JPEG named .arw: the image decoder would read it, rawler does not.
        let disguised = jpeg(dir.path(), "DSC00001.ARW", 1616, 1080);
        let result = run(&disguised, ".arw", "rawsha", &thumbs, false, &Tools::default());
        assert!(result.generation.thumbs.is_empty());
        assert!(result.generation.error.unwrap().starts_with("RawError"));

        let dng = dir.path().join("photo.dng");
        let preview = two_tone(1024, 683);
        let raw = image::RgbImage::from_pixel(64, 32, image::Rgb([100, 100, 100]));
        write_dng(
            &dng,
            &DngParts {
                raw: Some(&raw),
                preview: Some(&preview),
                thumbnail: None,
                orientation: None,
            },
        );
        let result = run(&dng, ".dng", "dngsha", &thumbs, false, &Tools::default());
        assert_eq!(dims(&result.generation), [(256, 256, 171), (1024, 1024, 683)]);
        assert_webp_files(&thumbs, &result.generation);
    }
}
