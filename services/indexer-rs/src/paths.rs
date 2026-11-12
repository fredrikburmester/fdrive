//! Pure path helpers: strings in, strings or booleans out.

/// Lowercase extension with its leading dot, as Python's `posixpath.splitext` gives it.
/// `.tar.gz` counts as one extension; a leading dot alone (`.bashrc`) is no extension.
pub fn ext_of(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".tar.gz") {
        return ".tar.gz".to_owned();
    }
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    let stem_start = base.len() - base.trim_start_matches('.').len();
    match base[stem_start..].rfind('.') {
        Some(dot) => base[stem_start + dot..].to_owned(),
        None => String::new(),
    }
}

/// The final component of a root-relative path.
pub fn basename(rel_path: &str) -> &str {
    rel_path.rsplit('/').next().unwrap_or(rel_path)
}

/// AppleDouble sidecars and OS junk files that are never worth indexing.
pub fn is_junk_name(name: &str, skip_names: &[&str]) -> bool {
    name.starts_with("._") || skip_names.contains(&name)
}

/// The `<root>/<rel>` key that settings-based glob rules match against.
pub fn root_relative_key(root: &str, rel_path: &str) -> String {
    format!("{root}/{rel_path}")
}

/// True when `rel_path` is `prefix` itself or lives below it.
pub fn is_under(rel_path: &str, prefix: &str) -> bool {
    prefix.is_empty() || rel_path == prefix || rel_path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/'))
}

/// Split a `/reindex` path into the exact path and its subtree prefix; `None` is the whole root.
pub fn reindex_scope(path: Option<&str>) -> Option<(String, String)> {
    path.map(|path| {
        let normalized = path.trim_matches('/').to_owned();
        let prefix = format!("{normalized}/");
        (normalized, prefix)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_match_python_splitext() {
        assert_eq!(ext_of("Report.PDF"), ".pdf");
        assert_eq!(ext_of("archive.tar.gz"), ".tar.gz");
        assert_eq!(ext_of("Makefile"), "");
        assert_eq!(ext_of(".bashrc"), "");
        assert_eq!(ext_of("..hidden.txt"), ".txt");
        assert_eq!(ext_of("x.env.example"), ".example");
        assert_eq!(ext_of("trailing."), ".");
        assert_eq!(ext_of("dir.d/file"), "");
    }

    #[test]
    fn junk_and_scope_helpers() {
        assert!(is_junk_name("._photo.jpg", &[".DS_Store"]));
        assert!(is_junk_name(".DS_Store", &[".DS_Store"]));
        assert!(!is_junk_name("photo.jpg", &[".DS_Store"]));
        assert_eq!(root_relative_key("sftpgo", "a/b"), "sftpgo/a/b");
        assert!(is_under("a/b/c", "a/b"));
        assert!(is_under("a/b", "a/b"));
        assert!(!is_under("a/bc", "a/b"));
        assert!(is_under("anything", ""));
        assert_eq!(basename("a/b/c.txt"), "c.txt");
        assert_eq!(basename("c.txt"), "c.txt");
        assert_eq!(reindex_scope(None), None);
        assert_eq!(reindex_scope(Some("/a/b/")), Some(("a/b".to_owned(), "a/b/".to_owned())));
    }
}
