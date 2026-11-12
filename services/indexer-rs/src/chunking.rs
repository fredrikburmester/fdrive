//! Text normalisation, extension classes and chunking. Lengths and cut points count
//! Unicode code points, as the Python indexer did, so stored chunks keep their shape.

pub const PLAIN_EXTS: &[&str] = &[
    ".txt",
    ".md",
    ".markdown",
    ".csv",
    ".tsv",
    ".json",
    ".yaml",
    ".yml",
    ".xml",
    ".log",
    ".ini",
    ".cfg",
    ".conf",
    ".toml",
    ".tex",
    ".rst",
    ".org",
    ".srt",
    ".vtt",
    ".sh",
    ".zsh",
    ".bash",
    ".py",
    ".rb",
    ".php",
    ".pl",
    ".js",
    ".mjs",
    ".ts",
    ".tsx",
    ".jsx",
    ".java",
    ".kt",
    ".swift",
    ".m",
    ".mm",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cc",
    ".cs",
    ".go",
    ".rs",
    ".sql",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".less",
    ".vue",
    ".svelte",
    ".env.example",
];
pub const PDF_EXTS: &[&str] = &[".pdf"];
pub const IMAGE_EXTS: &[&str] = &[
    ".avif", ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".gif", ".heic", ".heif",
];
/// Office and other documents the `ml` server's extraction unit reads.
pub const DOCUMENT_EXTS: &[&str] = &[
    ".doc", ".docx", ".dot", ".dotx", ".xls", ".xlsx", ".xlsm", ".ppt", ".pptx", ".odt", ".ods", ".odp", ".rtf",
    ".epub", ".pages", ".numbers", ".key", ".eml", ".msg", ".vsd", ".vsdx", ".pub", ".wpd", ".mobi",
];
pub const SPREADSHEET_EXTS: &[&str] = &[".xlsx", ".xlsm", ".xls", ".numbers", ".ods", ".csv", ".tsv"];
pub const VIDEO_EXTS: &[&str] = &[".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"];
/// Camera raw formats. They get image thumbnails from the embedded preview but never
/// enter text extraction or OCR.
pub const RAW_EXTS: &[&str] = &[
    ".arw", ".sr2", ".srf", ".cr2", ".cr3", ".crw", ".nef", ".nrw", ".dng", ".raf", ".orf", ".rw2", ".pef",
];

pub fn is_plain(ext: &str) -> bool {
    PLAIN_EXTS.contains(&ext)
}
pub fn is_pdf(ext: &str) -> bool {
    PDF_EXTS.contains(&ext)
}
pub fn is_image(ext: &str) -> bool {
    IMAGE_EXTS.contains(&ext)
}
pub fn is_document(ext: &str) -> bool {
    DOCUMENT_EXTS.contains(&ext)
}
pub fn is_raw(ext: &str) -> bool {
    RAW_EXTS.contains(&ext)
}
pub fn is_video(ext: &str) -> bool {
    VIDEO_EXTS.contains(&ext)
}
pub fn is_textual(ext: &str) -> bool {
    is_plain(ext) || is_pdf(ext) || is_image(ext) || is_document(ext)
}

/// Python's `str.isspace`, which also counts the ASCII separators U+001C to U+001F.
pub fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

/// Python's `str.strip()`.
pub fn py_strip(text: &str) -> &str {
    text.trim_matches(is_py_space)
}

pub fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n").replace('\0', "");
    let mut collapsed = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\x0c' | '\x0b') {
            if !in_run {
                collapsed.push(' ');
            }
            in_run = true;
        } else {
            collapsed.push(c);
            in_run = false;
        }
    }
    let stripped = collapsed.split('\n').map(py_strip).collect::<Vec<_>>().join("\n");
    let mut out = String::with_capacity(stripped.len());
    let mut newlines = 0;
    for c in stripped.chars() {
        if c == '\n' {
            newlines += 1;
            if newlines <= 2 {
                out.push(c);
            }
        } else {
            newlines = 0;
            out.push(c);
        }
    }
    py_strip(&out).to_owned()
}

/// Spreadsheets dump thousands of numbers; a few dozen chunks capture their labels.
pub fn max_chunks_for(ext: &str, default_max: usize) -> usize {
    if SPREADSHEET_EXTS.contains(&ext) {
        default_max.min(40)
    } else {
        default_max
    }
}

/// Position of the last `needle` in `chars[from..to]`, as Python's `str.rfind(needle, from, to)`.
fn rfind(chars: &[char], needle: char, from: usize, to: usize) -> Option<usize> {
    chars
        .get(from..to)?
        .iter()
        .rposition(|c| *c == needle)
        .map(|i| from + i)
}

/// Sliding window over normalised text, breaking at whitespace where possible.
pub fn chunk(text: &str, size: usize, overlap: usize, max_chunks: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n <= size {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![text.to_owned()]
        };
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < n && out.len() < max_chunks {
        let mut end = (start + size).min(n);
        if end < n {
            let from = (start + size).saturating_sub(300);
            let cut = rfind(&chars, '\n', from, end).max(rfind(&chars, ' ', from, end));
            if let Some(cut) = cut.filter(|cut| *cut > start + size / 2) {
                end = cut;
            }
        }
        let piece: String = chars[start..end].iter().collect();
        let piece = py_strip(&piece);
        if !piece.is_empty() {
            out.push(piece.to_owned());
        }
        if end >= n {
            break;
        }
        start = end.saturating_sub(overlap).max(start + 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_cleans_whitespace() {
        assert_eq!(normalize("a\r\nb\rc\0d"), "a\nb\ncd");
        assert_eq!(normalize("  x \t\x0b y  \n\n\n\n z "), "x y\n\nz");
        assert_eq!(normalize("\u{1c}a\u{1f}"), "a");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn extension_classes() {
        assert!(is_textual(".md") && is_plain(".md"));
        assert!(is_textual(".pdf") && is_pdf(".pdf"));
        assert!(is_textual(".heic") && is_image(".heic"));
        assert!(is_textual(".docx") && is_document(".docx"));
        assert!(!is_textual(".arw") && is_raw(".arw"));
        assert!(is_video(".mov") && !is_textual(".mov"));
        assert_eq!(max_chunks_for(".csv", 400), 40);
        assert_eq!(max_chunks_for(".xlsx", 10), 10);
        assert_eq!(max_chunks_for(".txt", 400), 400);
    }

    #[test]
    fn chunk_edges() {
        assert!(chunk("", 10, 2, 5).is_empty());
        assert_eq!(chunk("short", 10, 2, 5), vec!["short"]);
        assert!(chunk(&" ".repeat(30), 10, 2, 5).is_empty());
        assert_eq!(chunk(&"a".repeat(100), 10, 2, 3).len(), 3);
    }

    #[test]
    fn chunk_prefers_whitespace_in_the_last_300_characters() {
        let text = format!("{} {}", "a".repeat(1000), "b".repeat(800));
        let pieces = chunk(&text, 1200, 200, 400);
        assert_eq!(pieces[0], "a".repeat(1000));
        let early = format!("{} {}", "a".repeat(700), "b".repeat(800));
        assert_eq!(
            chunk(&early, 1200, 200, 400)[0].chars().count(),
            1200,
            "a cut before the last 300 is ignored"
        );
        assert!(pieces[1].starts_with('a') && pieces[1].ends_with('b'));
        let hard = "x".repeat(2500);
        let pieces = chunk(&hard, 1200, 200, 400);
        assert_eq!(
            pieces.iter().map(|p| p.chars().count()).collect::<Vec<_>>(),
            vec![1200, 1200, 500]
        );
    }

    #[test]
    fn chunk_counts_code_points() {
        let text = "å".repeat(1300);
        let pieces = chunk(&text, 1200, 200, 400);
        assert_eq!(pieces[0].chars().count(), 1200);
        assert_eq!(pieces[1].chars().count(), 300);
    }
}
