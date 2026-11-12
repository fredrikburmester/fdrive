//! Text extraction and text embeddings. Extraction returns `(text, status)` and never
//! fails for a bad file: status is `indexed`, `no_text`, `empty`, `none`,
//! `error:<reason>` or `excluded:<reason>`.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use image::DynamicImage;
use serde_json::json;

use crate::chunking::{is_document, is_image, is_pdf, is_plain, normalize};
use crate::http::client;
use crate::rules::Globs;

pub const OCR_TIMEOUT: Duration = Duration::from_secs(180);
const PDF_MIN_CHARS: usize = 40;
const OTHER_MIN_CHARS: usize = 20;

pub type Extracted = (Option<String>, String);

fn keep(text: String, min_chars: usize) -> Extracted {
    if text.chars().count() < min_chars {
        (None, "no_text".to_owned())
    } else {
        (Some(text), "indexed".to_owned())
    }
}

fn open_pdf(path: &Path) -> Result<mupdf::pdf::PdfDocument> {
    let path = path.to_str().context("ValueError: path is not valid UTF-8")?;
    mupdf::pdf::PdfDocument::open(path).map_err(|e| anyhow::anyhow!("FileDataError: {e}"))
}

fn page_text(page: &mupdf::Page) -> Result<String> {
    use mupdf::TextPageFlags;
    let flags = TextPageFlags::PRESERVE_LIGATURES
        | TextPageFlags::PRESERVE_WHITESPACE
        | TextPageFlags::USE_CID_FOR_UNKNOWN_UNICODE;
    Ok(page.to_text_page(flags)?.to_text()?)
}

pub fn extract_pdf(path: &Path, max_pages: usize) -> Result<Extracted> {
    let doc = open_pdf(path)?;
    if doc.needs_password()? {
        return Ok((None, "error:encrypted".to_owned()));
    }
    let count = usize::try_from(doc.page_count()?).unwrap_or(0).min(max_pages);
    let mut parts = Vec::with_capacity(count);
    for i in 0..count {
        parts.push(page_text(&doc.load_page(i as i32)?)?);
    }
    Ok(keep(normalize(&parts.join("\n\n")), PDF_MIN_CHARS))
}

/// Render a PDF page to RGB at `dpi`.
pub fn render_page(page: &mupdf::Page, dpi: f32) -> Result<DynamicImage> {
    let scale = dpi / 72.0;
    let pixmap = page.to_pixmap(
        &mupdf::Matrix::new_scale(scale, scale),
        &mupdf::Colorspace::device_rgb(),
        false,
        true,
    )?;
    let (width, height, n) = (pixmap.width(), pixmap.height(), usize::from(pixmap.n()));
    let stride = usize::try_from(pixmap.stride()).unwrap_or(0);
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    for row in pixmap.samples().chunks(stride.max(1)).take(height as usize) {
        for pixel in row[..width as usize * n].chunks(n) {
            rgb.extend_from_slice(&pixel[..3]);
        }
    }
    let buffer = image::RgbImage::from_raw(width, height, rgb).context("ValueError: pixmap size mismatch")?;
    Ok(DynamicImage::ImageRgb8(buffer))
}

/// Read scanned pages with tesseract; pages with a text layer keep it. Never rewrites the file.
pub fn extract_pdf_ocr(path: &Path, max_pages: usize, langs: &str) -> Result<Extracted> {
    let doc = open_pdf(path)?;
    if doc.needs_password()? {
        return Ok((None, "error:encrypted".to_owned()));
    }
    let count = usize::try_from(doc.page_count()?).unwrap_or(0).min(max_pages);
    let mut parts = Vec::with_capacity(count);
    for i in 0..count {
        let page = doc.load_page(i as i32)?;
        let native = page_text(&page)?;
        if normalize(&native).chars().count() >= PDF_MIN_CHARS {
            parts.push(native);
            continue;
        }
        parts.push(ocr(&render_page(&page, 200.0)?, langs)?);
    }
    Ok(keep(normalize(&parts.join("\n\n")), PDF_MIN_CHARS))
}

/// Run the `tesseract` program on an image, with a hard timeout.
pub fn ocr(picture: &DynamicImage, langs: &str) -> Result<String> {
    let mut input = tempfile::Builder::new().suffix(".png").tempfile()?;
    picture.write_to(
        &mut std::io::BufWriter::new(input.as_file_mut()),
        image::ImageFormat::Png,
    )?;
    input.as_file_mut().flush()?;
    run_tool(
        Command::new("tesseract")
            .arg(input.path())
            .arg("stdout")
            .args(["-l", langs]),
        OCR_TIMEOUT,
    )
    .map(|out| String::from_utf8_lossy(&out).into_owned())
}

/// Run a program, killing it after `timeout`. Returns stdout, or an error with stderr.
pub fn run_tool(command: &mut Command, timeout: Duration) -> Result<Vec<u8>> {
    let program = command.get_program().to_string_lossy().into_owned();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (mut stdout, mut stderr) = (
        child.stdout.take().context("no stdout")?,
        child.stderr.take().context("no stderr")?,
    );
    let out = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let err = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!(
                "TimeoutExpired: {program} timed out after {} seconds",
                timeout.as_secs()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (out, err) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if !status.success() {
        let err = String::from_utf8_lossy(&err);
        let tail: String = err
            .chars()
            .rev()
            .take(1500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        bail!("CalledProcessError: {program} exited with {status}: {}", tail.trim());
    }
    Ok(out)
}

pub fn extract_image(path: &Path, langs: &str) -> Result<Extracted> {
    let picture = crate::images::open_image(path, Some(3000))?;
    let picture = if picture.width().max(picture.height()) > 3000 {
        picture.resize(3000, 3000, image::imageops::FilterType::CatmullRom)
    } else {
        picture
    };
    let picture = match picture {
        DynamicImage::ImageLuma8(_) | DynamicImage::ImageRgb8(_) => picture,
        other => DynamicImage::ImageRgb8(other.to_rgb8()),
    };
    Ok(keep(normalize(&ocr(&picture, langs)?), OTHER_MIN_CHARS))
}

/// Strict Windows-1252: the five bytes it leaves undefined are a decoding failure.
fn decode_cp1252(raw: &[u8]) -> Option<String> {
    if raw.iter().any(|b| matches!(b, 0x81 | 0x8d | 0x8f | 0x90 | 0x9d)) {
        return None;
    }
    let (text, _, had_errors) = encoding_rs::WINDOWS_1252.decode(raw);
    (!had_errors).then(|| text.into_owned())
}

/// UTF-8. When the read stopped at its limit, a sequence cut off at the very end is dropped.
fn decode_utf8(raw: &[u8], truncated: bool) -> Option<String> {
    match std::str::from_utf8(raw) {
        Ok(text) => Some(text.to_owned()),
        Err(error) if truncated && error.error_len().is_none() => {
            Some(String::from_utf8_lossy(&raw[..error.valid_up_to()]).into_owned())
        }
        Err(_) => None,
    }
}

fn decode_utf16(raw: &[u8]) -> Option<String> {
    let (encoding, body) = match raw {
        [0xff, 0xfe, rest @ ..] => (encoding_rs::UTF_16LE, rest),
        [0xfe, 0xff, rest @ ..] => (encoding_rs::UTF_16BE, rest),
        _ => return None,
    };
    let (text, had_errors) = encoding.decode_without_bom_handling(body);
    (!had_errors).then(|| text.into_owned())
}

/// Text in the first encoding that reads it: UTF-16 with a BOM, UTF-8, Windows-1252, Latin-1.
pub fn decode_text(raw: &[u8], truncated: bool) -> String {
    decode_utf16(raw)
        .or_else(|| decode_utf8(raw, truncated))
        .or_else(|| decode_cp1252(raw))
        .unwrap_or_else(|| raw.iter().map(|b| char::from(*b)).collect())
}

pub fn extract_plain(path: &Path, cap: usize) -> Result<Extracted> {
    let mut raw = Vec::new();
    let limit = cap * 2;
    std::fs::File::open(path)?.take(limit as u64).read_to_end(&mut raw)?;
    let text: String = normalize(&decode_text(&raw, raw.len() == limit))
        .chars()
        .take(cap)
        .collect();
    Ok(if text.is_empty() {
        (None, "empty".to_owned())
    } else {
        (Some(text), "indexed".to_owned())
    })
}

/// Office documents through the `ml` server's extraction unit (Tika's contract).
pub fn extract_document(path: &Path, url: &str) -> Result<Extracted> {
    let file = std::fs::File::open(path)?;
    let response = client()
        .put(format!("{url}/tika"))
        .header("Accept", "text/plain")
        .header("X-Tika-Skip-Embedded", "false")
        .body(reqwest::blocking::Body::new(file))
        .timeout(Duration::from_secs(180))
        .send()?;
    if response.status().as_u16() == 422 {
        return Ok((None, "error:unsupported".to_owned()));
    }
    let text = response.error_for_status()?.text()?;
    Ok(keep(normalize(&text), OTHER_MIN_CHARS))
}

/// Everything extraction needs, rebuilt when settings change.
#[derive(Debug, Clone)]
pub struct Extractor {
    pub root: String,
    pub text_max_bytes: u64,
    pub image_max_bytes: u64,
    pub max_pdf_pages: usize,
    pub plain_text_cap: usize,
    pub tesseract_langs: String,
    pub ocr_image_globs: Globs,
    pub tika_url: String,
}

impl Extractor {
    pub fn extract(&self, path: &Path, rel_path: &str, ext: &str, size: u64, search_ocr: bool) -> Extracted {
        match self.try_extract(path, rel_path, ext, size, search_ocr) {
            Ok(result) => result,
            Err(error) => {
                let message: String = format!("{error:#}").chars().take(200).collect();
                (None, format!("error:{message}"))
            }
        }
    }

    fn try_extract(&self, path: &Path, rel_path: &str, ext: &str, size: u64, search_ocr: bool) -> Result<Extracted> {
        let too_big = || Ok((None, "excluded:too_big".to_owned()));
        if is_pdf(ext) {
            if size > self.text_max_bytes {
                return too_big();
            }
            return if search_ocr {
                extract_pdf_ocr(path, self.max_pdf_pages, &self.tesseract_langs)
            } else {
                extract_pdf(path, self.max_pdf_pages)
            };
        }
        if is_image(ext) {
            if !self.ocr_image_globs.matches(&self.root, rel_path) {
                return Ok((None, "excluded:image_dir".to_owned()));
            }
            if size > self.image_max_bytes {
                return too_big();
            }
            return extract_image(path, &self.tesseract_langs);
        }
        if is_plain(ext) {
            return extract_plain(path, self.plain_text_cap);
        }
        if is_document(ext) {
            if size > self.text_max_bytes {
                return too_big();
            }
            return extract_document(path, &self.tika_url);
        }
        Ok((None, "none".to_owned()))
    }
}

pub fn embed_passages(texts: &[String], url: &str, batch: usize) -> Result<Vec<Vec<f32>>> {
    embed(texts.iter().map(|t| format!("passage: {t}")).collect(), url, batch)
}

fn embed(inputs: Vec<String>, url: &str, batch: usize) -> Result<Vec<Vec<f32>>> {
    let mut out = Vec::with_capacity(inputs.len());
    for group in inputs.chunks(batch.max(1)) {
        let response = client()
            .post(format!("{url}/embed"))
            .json(&json!({"inputs": group, "truncate": true, "normalize": true}))
            .timeout(Duration::from_secs(600))
            .send()?
            .error_for_status()?;
        let vectors: Vec<Vec<f32>> = response.json()?;
        if vectors.len() != group.len() {
            bail!(
                "ValueError: embedding service returned {} vectors for {} inputs",
                vectors.len(),
                group.len()
            );
        }
        out.extend(vectors);
    }
    Ok(out)
}

pub fn embed_health(url: &str, timeout: Duration) -> bool {
    client()
        .get(format!("{url}/health"))
        .timeout(timeout)
        .send()
        .is_ok_and(|r| r.status().as_u16() == 200)
}

/// Extraction of bytes the API already read through the person's own credentials. Never
/// resolves a storage path; errors never reveal the temporary file.
pub struct ContentExtractor {
    pub extractor: Extractor,
    pub admission: std::sync::Arc<tokio::sync::Semaphore>,
}

pub const MAX_CONTENT_BYTES: usize = 4 * 1024 * 1024;

impl ContentExtractor {
    pub fn new(max_pdf_pages: usize, plain_text_cap: usize, tesseract_langs: &str, tika_url: &str) -> Self {
        Self {
            extractor: Extractor {
                root: "mcp".to_owned(),
                text_max_bytes: MAX_CONTENT_BYTES as u64,
                image_max_bytes: MAX_CONTENT_BYTES as u64,
                max_pdf_pages,
                plain_text_cap,
                tesseract_langs: tesseract_langs.to_owned(),
                ocr_image_globs: Globs::new(&["*".to_owned()]),
                tika_url: tika_url.to_owned(),
            },
            admission: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }

    pub fn extract(&self, content: &[u8], name: &str, search_ocr: bool) -> serde_json::Value {
        let ext = crate::paths::ext_of(name);
        if is_image(&ext) && !search_ocr {
            return json!({"text": null, "status": "disabled"});
        }
        if !crate::chunking::is_textual(&ext) {
            return json!({"text": null, "status": "none"});
        }
        let written = tempfile::NamedTempFile::new().and_then(|mut file| file.write_all(content).map(|()| file));
        let (text, status) = match written {
            Ok(file) => self
                .extractor
                .extract(file.path(), name, &ext, content.len() as u64, search_ocr),
            Err(_) => (None, "error:io".to_owned()),
        };
        let status = if status.starts_with("error:") {
            "error".to_owned()
        } else {
            status
        };
        json!({"text": text, "status": status})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::fake::Server;

    pub fn tesseract_available() -> bool {
        Command::new("tesseract")
            .arg("--version")
            .output()
            .is_ok_and(|o| o.status.success())
    }

    /// A minimal PDF whose pages show the given text in Helvetica; an empty string gives a
    /// page without a text layer.
    pub fn pdf_bytes(pages: &[&str]) -> Vec<u8> {
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            String::new(),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut kids = Vec::new();
        for text in pages {
            let content = if text.is_empty() {
                String::new()
            } else {
                let escaped = text.replace('\\', "\\\\").replace('(', "\\(").replace(')', "\\)");
                format!("BT /F1 12 Tf 50 700 Td ({escaped}) Tj ET")
            };
            objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
            let content_id = objects.len();
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>"
            ));
            kids.push(format!("{} 0 R", objects.len()));
        }
        objects[1] = format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len());
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
                objects.len() + 1
            )
            .as_bytes(),
        );
        out
    }

    fn extractor(tika_url: &str) -> Extractor {
        Extractor {
            root: "r".into(),
            text_max_bytes: 1000,
            image_max_bytes: 100,
            max_pdf_pages: 600,
            plain_text_cap: 300_000,
            tesseract_langs: "eng".into(),
            ocr_image_globs: Globs::new(&["r/scans/*".to_owned()]),
            tika_url: tika_url.into(),
        }
    }

    #[test]
    fn decoding_tries_utf16_utf8_cp1252_latin1() {
        assert_eq!(decode_text(&[0xff, 0xfe, b'c', 0, 0xe9, 0], false), "cé");
        assert_eq!(decode_text(&[0xfe, 0xff, 0, b'c', 0, 0xe9], false), "cé");
        assert_eq!(decode_text("café".as_bytes(), false), "café");
        assert_eq!(decode_text(&[b'c', b'a', b'f', 0xe9], false), "café");
        assert_eq!(decode_text(&[0x80], false), "€");
        assert_eq!(
            decode_text(&[0x81], false),
            "\u{81}",
            "an undefined cp1252 byte falls through to latin-1"
        );
        assert_eq!(
            decode_text(&[b'a', 0xc3], true),
            "a",
            "a sequence cut by the read limit is dropped"
        );
        assert_eq!(decode_text(&[b'a', 0xc3], false), "aÃ");
        assert_eq!(decode_text(&[0xff, 0xfe, 0x00], false), "ÿþ\0");
    }

    #[test]
    fn plain_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "").unwrap();
        assert_eq!(extract_plain(&path, 10).unwrap(), (None, "empty".into()));
        std::fs::write(&path, "  hello   world  \r\n").unwrap();
        assert_eq!(
            extract_plain(&path, 300).unwrap(),
            (Some("hello world".into()), "indexed".into())
        );
        std::fs::write(&path, "abcdefghij").unwrap();
        assert_eq!(extract_plain(&path, 4).unwrap().0.unwrap(), "abcd");
    }

    #[test]
    fn routing_and_limits() {
        let server = Server::start();
        server.route("/tika", 200, &"word ".repeat(10));
        let e = extractor(&server.url);
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("a.docx");
        std::fs::write(&doc, b"PK").unwrap();
        assert_eq!(e.extract(&doc, "a.docx", ".docx", 2, false).1, "indexed");
        let seen = &server.seen()[0];
        assert_eq!((seen.method.as_str(), seen.body.as_slice()), ("PUT", b"PK".as_slice()));
        assert_eq!(seen.headers["x-tika-skip-embedded"], "false");
        assert_eq!(seen.headers["accept"], "text/plain");
        server.route("/tika", 200, "short");
        assert_eq!(e.extract(&doc, "a.docx", ".docx", 2, false), (None, "no_text".into()));
        server.route("/tika", 422, "");
        assert_eq!(e.extract(&doc, "a.docx", ".docx", 2, false).1, "error:unsupported");
        server.route("/tika", 500, "");
        assert!(e.extract(&doc, "a.docx", ".docx", 2, false).1.starts_with("error:"));
        assert_eq!(e.extract(&doc, "a.docx", ".docx", 5000, false).1, "excluded:too_big");
        assert_eq!(e.extract(&doc, "a.pdf", ".pdf", 5000, false).1, "excluded:too_big");
        assert_eq!(e.extract(&doc, "photos/a.png", ".png", 5, true).1, "excluded:image_dir");
        assert_eq!(e.extract(&doc, "scans/a.png", ".png", 500, true).1, "excluded:too_big");
        assert_eq!(e.extract(&doc, "a.bin", ".bin", 5, false).1, "none");
        assert!(
            e.extract(&dir.path().join("missing.txt"), "missing.txt", ".txt", 5, false)
                .1
                .starts_with("error:")
        );
        let mut empty_globs = extractor(&server.url);
        empty_globs.ocr_image_globs = Globs::new(&[]);
        assert_eq!(
            empty_globs.extract(&doc, "scans/a.png", ".png", 5, true).1,
            "excluded:image_dir"
        );
    }

    #[test]
    fn pdf_text_layers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        let long = "The quick brown fox jumps over the lazy dog again and again";
        std::fs::write(&path, pdf_bytes(&[long, "second page words"])).unwrap();
        let (text, status) = extractor("").extract(&path, "a.pdf", ".pdf", 10, false);
        assert_eq!(status, "indexed");
        assert!(text.unwrap().contains("lazy dog again and again\n\nsecond page words"));
        assert_eq!(extract_pdf(&path, 1).unwrap().0.unwrap(), long);
        std::fs::write(&path, pdf_bytes(&["tiny"])).unwrap();
        assert_eq!(extract_pdf(&path, 600).unwrap(), (None, "no_text".into()));
        std::fs::write(&path, b"%PDF-1.4 not really").unwrap();
        assert!(
            extractor("")
                .extract(&path, "a.pdf", ".pdf", 10, false)
                .1
                .starts_with("error:")
        );
    }

    #[test]
    fn pdf_ocr_keeps_text_layers_and_reads_blank_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.pdf");
        let long = "The quick brown fox jumps over the lazy dog again and again";
        std::fs::write(&path, pdf_bytes(&[long])).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert_eq!(
            extract_pdf_ocr(&path, 600, "eng").unwrap().0.unwrap(),
            long,
            "native text needs no OCR"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before, "the original is never rewritten");
        let page = open_pdf(&path).unwrap().load_page(0).unwrap();
        let rendered = render_page(&page, 200.0).unwrap();
        assert_eq!((rendered.width(), rendered.height()), (1700, 2200));
        if tesseract_available() {
            std::fs::write(&path, pdf_bytes(&[long, ""])).unwrap();
            assert_eq!(extract_pdf_ocr(&path, 600, "eng").unwrap().1, "indexed");
        }
    }

    #[test]
    fn embeddings_use_the_passage_prefix_and_batches() {
        let server = Server::start();
        server.respond("/embed", |seen| {
            let body: serde_json::Value = serde_json::from_slice(&seen.body).unwrap();
            let n = body["inputs"].as_array().unwrap().len();
            (200, serde_json::to_string(&vec![vec![0.25_f32; 3]; n]).unwrap())
        });
        let texts: Vec<String> = (0..5).map(|i| format!("t{i}")).collect();
        assert_eq!(embed_passages(&texts, &server.url, 2).unwrap().len(), 5);
        let bodies: Vec<serde_json::Value> = server
            .seen()
            .iter()
            .map(|s| serde_json::from_slice(&s.body).unwrap())
            .collect();
        assert_eq!(bodies.len(), 3);
        assert_eq!(bodies[0]["inputs"][0], "passage: t0");
        assert_eq!(bodies[0]["truncate"], true);
        server.route("/embed", 200, "[[1.0]]");
        assert!(embed_passages(&texts[..2], &server.url, 2).is_err());
        server.route("/embed", 413, "");
        assert!(embed_passages(&texts[..1], &server.url, 2).is_err());
        server.route("/health", 200, "");
        assert!(embed_health(&server.url, Duration::from_secs(1)));
        server.route("/health", 503, "");
        assert!(!embed_health(&server.url, Duration::from_secs(1)));
        assert!(!embed_health("http://127.0.0.1:1", Duration::from_secs(1)));
    }

    #[test]
    fn tools_time_out_and_report_stderr() {
        let error = run_tool(Command::new("sh").args(["-c", "sleep 5"]), Duration::from_millis(100)).unwrap_err();
        assert!(error.to_string().starts_with("TimeoutExpired"));
        let error = run_tool(
            Command::new("sh").args(["-c", "echo bad >&2; exit 3"]),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("CalledProcessError") && error.to_string().ends_with("bad"));
        assert_eq!(
            run_tool(Command::new("sh").args(["-c", "printf hi"]), Duration::from_secs(5)).unwrap(),
            b"hi"
        );
    }

    #[test]
    fn content_extraction_hides_paths() {
        let content = ContentExtractor::new(600, 300_000, "eng", "http://127.0.0.1:1");
        assert_eq!(content.extract(b"hello", "a.png", false)["status"], "disabled");
        assert_eq!(content.extract(b"hello", "a.bin", false)["status"], "none");
        assert_eq!(content.extract(b"hello world", "a.txt", false)["text"], "hello world");
        let failed = content.extract(b"x", "a.docx", false);
        assert_eq!(failed, json!({"text": null, "status": "error"}));
    }
}
