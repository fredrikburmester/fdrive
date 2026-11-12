//! Plain text from office documents.
//!
//! [`extract`] takes the raw bytes of a document, works out what it is from
//! the content alone, and returns its text. It replaces the part of Apache
//! Tika that fdrive's indexer used: the caller has no reliable file name or
//! media type to offer, so nothing here depends on one.

mod bytes;
mod dates;
mod doc;
mod eml;
mod epub;
mod html;
mod limits;
mod mobi;
mod msg;
mod odf;
mod ole;
mod ooxml;
mod ppt;
mod rtf;
mod sink;
mod strings;
mod xls;
mod xml;
mod zipdoc;

use std::fmt;

pub use limits::Limits;

use limits::Budget;
use ole::Ole;
use sink::Sink;
use zipdoc::Package;

/// Why a document yielded no text.
#[derive(Debug, thiserror::Error)]
pub enum ExtractError {
    /// The bytes are a format this crate does not read. Carries a short fixed label.
    #[error("unsupported document type: {0}")]
    Unsupported(&'static str),
    /// A recognized format that is encrypted.
    #[error("document is encrypted")]
    Encrypted,
    /// A recognized format whose content could not be parsed.
    #[error("malformed document: {0}")]
    Malformed(String),
}

/// The detected format, for logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    Docx,
    Xlsx,
    Pptx,
    Vsdx,
    Odt,
    Ods,
    Odp,
    Epub,
    Rtf,
    Eml,
    Doc,
    Xls,
    Ppt,
    Msg,
    Mobi,
    /// HTML saved under an office extension, as old exporters did.
    Html,
    /// Word 2003 XML, a single-file predecessor of `.docx`.
    WordXml,
}

impl Format {
    /// A short lowercase label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
            Self::Vsdx => "vsdx",
            Self::Odt => "odt",
            Self::Ods => "ods",
            Self::Odp => "odp",
            Self::Epub => "epub",
            Self::Rtf => "rtf",
            Self::Eml => "eml",
            Self::Doc => "doc",
            Self::Xls => "xls",
            Self::Ppt => "ppt",
            Self::Msg => "msg",
            Self::Mobi => "mobi",
            Self::Html => "html",
            Self::WordXml => "word-xml",
        }
    }
}

impl fmt::Display for Format {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The text of a document and what it was recognized as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    pub format: Format,
    pub text: String,
}

/// Extracts the text of the document in `bytes`.
///
/// Reaching `limits.max_text_chars` truncates the text and still succeeds.
/// Reaching a byte limit returns the text collected up to that point, or
/// [`ExtractError::Malformed`] when there is none.
pub fn extract(bytes: &[u8], limits: &Limits) -> Result<Extracted, ExtractError> {
    let mut budget = Budget::new(limits);
    let mut sink = Sink::new(limits.max_text_chars);
    let (format, result) = dispatch(bytes, &mut budget, &mut sink)?;
    match result {
        // A cut-off document often stops parsing mid-structure; what was read still counts.
        Err(ExtractError::Malformed(_)) if budget.exhausted() && sink.has_text() => {}
        Err(error) => return Err(error),
        Ok(()) if budget.exhausted() && !sink.has_text() => {
            return Err(ExtractError::Malformed("size limit reached before any text".into()));
        }
        Ok(()) => {}
    }
    Ok(Extracted {
        format,
        text: sink.finish(),
    })
}

/// The outcome of parsing a document whose format is already known.
type Parsed = (Format, Result<(), ExtractError>);

/// Detects the format and runs its parser. The outer error is a document that
/// was never read; the inner one a parser that failed part way.
fn dispatch(bytes: &[u8], budget: &mut Budget, sink: &mut Sink) -> Result<Parsed, ExtractError> {
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return zip(bytes, budget, sink);
    }
    if bytes.starts_with(ole::MAGIC) {
        return compound(bytes, budget, sink);
    }
    if bytes
        .get(mobi::MAGIC_AT..)
        .is_some_and(|rest| rest.starts_with(mobi::MAGIC))
    {
        return Ok((Format::Mobi, mobi::mobi(bytes, budget, sink)));
    }
    if bytes.starts_with(b"\xFFWPC") {
        return Err(ExtractError::Unsupported("wordperfect"));
    }
    if bytes.starts_with(b"%PDF") {
        return Err(ExtractError::Unsupported("pdf"));
    }
    let start = leading_text(bytes);
    if start.starts_with(b"{\\rtf") {
        rtf::rtf(budget.slice(start), sink);
        return Ok((Format::Rtf, Ok(())));
    }
    if start.starts_with(b"<") {
        return markup(bytes, budget, sink);
    }
    if eml::looks_like_mail(bytes) {
        return Ok((Format::Eml, eml::eml(budget.slice(bytes), sink)));
    }
    Err(ExtractError::Unsupported("unknown"))
}

/// `bytes` past a byte order mark and leading whitespace.
fn leading_text(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let skip = bytes.iter().take_while(|byte| byte.is_ascii_whitespace()).count();
    bytes.get(skip..).unwrap_or(bytes)
}

fn zip(bytes: &[u8], budget: &mut Budget, sink: &mut Sink) -> Result<Parsed, ExtractError> {
    let mut pkg = Package::open(bytes, budget)?;
    if let Some(format) = open_document(&mut pkg)? {
        if odf::is_encrypted(&mut pkg) {
            return Err(ExtractError::Encrypted);
        }
        let result = if format == Format::Epub {
            epub::epub(&mut pkg, sink)
        } else {
            odf::odf(&mut pkg, format == Format::Ods, sink)
        };
        return Ok((format, result));
    }
    if pkg.has("[Content_Types].xml") {
        let main = ooxml::main_part(&mut pkg)
            .or_else(|| {
                [
                    "word/document.xml",
                    "xl/workbook.xml",
                    "ppt/presentation.xml",
                    "visio/document.xml",
                ]
                .into_iter()
                .find(|part| pkg.has(part))
                .map(str::to_owned)
            })
            .ok_or(ExtractError::Unsupported("ooxml"))?;
        let lower = main.to_ascii_lowercase();
        return Ok(if lower.ends_with(".bin") {
            return Err(ExtractError::Unsupported("xlsb"));
        } else if lower.starts_with("word/") {
            (Format::Docx, ooxml::docx(&mut pkg, &main, sink))
        } else if lower.starts_with("xl/") {
            (Format::Xlsx, ooxml::xlsx(&mut pkg, &main, sink))
        } else if lower.starts_with("ppt/") {
            (Format::Pptx, ooxml::pptx(&mut pkg, &main, sink))
        } else if lower.starts_with("visio/") {
            (Format::Vsdx, ooxml::vsdx(&mut pkg, sink))
        } else {
            return Err(ExtractError::Unsupported("ooxml"));
        });
    }
    if pkg.has("META-INF/container.xml") {
        return Ok((Format::Epub, epub::epub(&mut pkg, sink)));
    }
    // Pages, Numbers and Keynote: protobuf archives today, XML before 2013.
    let iwork = pkg.names().iter().any(|name| {
        name.ends_with(".iwa")
            || matches!(
                name.as_str(),
                "Index.zip" | "index.apxl" | "index.xml" | "index.numbers"
            )
    });
    Err(ExtractError::Unsupported(if iwork { "iwork" } else { "zip" }))
}

/// The format a `mimetype` member declares, for OpenDocument and EPUB.
fn open_document(pkg: &mut Package<'_, '_>) -> Result<Option<Format>, ExtractError> {
    let Some(declared) = pkg.bytes("mimetype") else {
        return Ok(None);
    };
    let declared = String::from_utf8_lossy(&declared);
    let kind = declared.trim();
    if kind == "application/epub+zip" {
        return Ok(Some(Format::Epub));
    }
    // StarOffice 6 files predate OpenDocument but keep text the same way.
    let Some(family) = kind
        .strip_prefix("application/vnd.oasis.opendocument.")
        .or_else(|| kind.strip_prefix("application/vnd.sun.xml."))
    else {
        return Ok(None);
    };
    match family.split(['-', '.']).next() {
        Some("text" | "writer") => Ok(Some(Format::Odt)),
        Some("spreadsheet" | "calc") => Ok(Some(Format::Ods)),
        Some("presentation" | "impress") => Ok(Some(Format::Odp)),
        _ => Err(ExtractError::Unsupported("opendocument")),
    }
}

fn compound(bytes: &[u8], budget: &mut Budget, sink: &mut Sink) -> Result<Parsed, ExtractError> {
    let mut ole = Ole::open(bytes)?;
    // A password-protected `.docx` is an encrypted package inside a compound file.
    if ole.has("/EncryptedPackage") {
        return Err(ExtractError::Encrypted);
    }
    if ole.has("/WordDocument") {
        return Ok((Format::Doc, doc::doc(&mut ole, budget, sink)));
    }
    if ole.has("/Workbook") || ole.has("/Book") {
        return Ok((Format::Xls, xls::xls(&mut ole, budget, sink)));
    }
    if ole.has("/PowerPoint Document") {
        return Ok((Format::Ppt, ppt::ppt(&mut ole, budget, sink)));
    }
    if msg::is_message(&ole.children("/")) {
        return Ok((Format::Msg, msg::msg(&mut ole, budget, sink)));
    }
    Err(ExtractError::Unsupported(if ole.has("/VisioDocument") {
        "visio-binary"
    } else if ole.has("/Quill") {
        "publisher"
    } else {
        "ole"
    }))
}

/// Input that opens with `<`: Word 2003 XML, or HTML under an office extension.
fn markup(bytes: &[u8], budget: &mut Budget, sink: &mut Sink) -> Result<Parsed, ExtractError> {
    let head = String::from_utf8_lossy(bytes.get(..4096).unwrap_or(bytes)).to_ascii_lowercase();
    if head.contains("<w:worddocument") || (head.contains("progid=\"word.document\"") && head.contains("<?xml")) {
        let mut text = ooxml::FlowText::default();
        let result = xml::walk(budget.slice(bytes), |node| text.visit(node, sink))
            .map_err(|error| ExtractError::Malformed(format!("word xml: {error}")));
        return Ok((Format::WordXml, result));
    }
    if head.contains("<html") || head.contains("<!doctype html") {
        html::html_to_text(&String::from_utf8_lossy(budget.slice(bytes)), sink);
        return Ok((Format::Html, Ok(())));
    }
    Err(ExtractError::Unsupported("unknown"))
}
