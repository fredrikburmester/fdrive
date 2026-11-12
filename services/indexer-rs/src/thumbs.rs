//! Thumbnail decisions: which files get one, where it is stored and how large it is.

use crate::chunking::{is_image, is_pdf, is_raw, is_video};

pub const SIZES: [u32; 2] = [256, 1024];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Image,
    Pdf,
    Video,
}

pub fn kind_for_ext(ext: &str) -> Option<Kind> {
    if is_image(ext) || is_raw(ext) {
        Some(Kind::Image)
    } else if is_pdf(ext) {
        Some(Kind::Pdf)
    } else if is_video(ext) {
        Some(Kind::Video)
    } else {
        None
    }
}

pub fn skip_reason(size_bytes: u64, max_bytes: u64) -> Option<String> {
    if size_bytes == 0 {
        Some("empty file".to_owned())
    } else if size_bytes > max_bytes {
        Some(format!("{size_bytes} bytes over budget {max_bytes}"))
    } else {
        None
    }
}

/// Path relative to `THUMBS_DIR`: `<sha[:2]>/<sha>.<size>.webp`.
pub fn storage_path(sha256: &str, size: u32) -> String {
    format!("{}/{sha256}.{size}.webp", &sha256[..2.min(sha256.len())])
}

/// New dimensions with the longest side at most `target`, never upscaled, never zero.
pub fn resize_dimensions(width: u32, height: u32, target: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width.max(1), height.max(1));
    }
    let longest = width.max(height);
    if longest <= target {
        return (width, height);
    }
    let scale = f64::from(target) / f64::from(longest);
    let scaled = |side: u32| ((f64::from(side) * scale).round() as u32).max(1);
    (scaled(width), scaled(height))
}

pub fn normalize_scope(path: Option<&str>) -> String {
    path.map(|p| p.trim_matches('/').to_owned()).unwrap_or_default()
}

pub fn is_thumbnail_candidate(ext: &str, rel_path: &str, scope: &str) -> bool {
    kind_for_ext(ext).is_some() && crate::paths::is_under(rel_path, scope)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_paths() {
        assert_eq!(kind_for_ext(".heic"), Some(Kind::Image));
        assert_eq!(kind_for_ext(".cr3"), Some(Kind::Image));
        assert_eq!(kind_for_ext(".pdf"), Some(Kind::Pdf));
        assert_eq!(kind_for_ext(".mkv"), Some(Kind::Video));
        assert_eq!(kind_for_ext(".txt"), None);
        assert_eq!(storage_path("abcdef", 256), "ab/abcdef.256.webp");
        assert_eq!(skip_reason(0, 10).as_deref(), Some("empty file"));
        assert_eq!(skip_reason(11, 10).as_deref(), Some("11 bytes over budget 10"));
        assert_eq!(skip_reason(10, 10), None);
    }

    #[test]
    fn resizing_never_upscales() {
        assert_eq!(resize_dimensions(4000, 2000, 1024), (1024, 512));
        assert_eq!(resize_dimensions(1616, 1080, 256), (256, 171));
        assert_eq!(resize_dimensions(100, 50, 256), (100, 50));
        assert_eq!(resize_dimensions(0, 5, 256), (1, 5));
        assert_eq!(resize_dimensions(10000, 1, 256), (256, 1));
    }

    #[test]
    fn scopes() {
        assert_eq!(normalize_scope(None), "");
        assert_eq!(normalize_scope(Some("/photos/")), "photos");
        assert!(is_thumbnail_candidate(".png", "photos/a.png", "photos"));
        assert!(!is_thumbnail_candidate(".png", "photos2/a.png", "photos"));
        assert!(!is_thumbnail_candidate(".txt", "photos/a.txt", ""));
    }
}
