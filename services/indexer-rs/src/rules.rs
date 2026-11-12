//! Pure decisions about whether a path is worth walking, watching or extracting.
//!
//! Glob rules match `<root>/<rel path>` the way Python's `fnmatch` did: `*` also crosses
//! `/`, matching is case-sensitive and a backslash is an ordinary character.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

use crate::paths::root_relative_key;

/// `"Photos, Videos/Raw,,"` becomes `["Photos", "Videos/Raw"]`.
pub fn split_prefixes(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|part| part.trim().trim_matches('/').to_owned())
        .filter(|part| !part.is_empty())
        .collect()
}

/// A compiled list of fnmatch-style patterns. Patterns that do not compile never match.
#[derive(Debug, Clone)]
pub struct Globs {
    patterns: Vec<String>,
    set: GlobSet,
}

impl Globs {
    pub fn new(patterns: &[String]) -> Self {
        let mut builder = GlobSetBuilder::new();
        for pattern in patterns {
            let glob = GlobBuilder::new(pattern).literal_separator(false).backslash_escape(false).build();
            if let Ok(glob) = glob {
                builder.add(glob);
            }
        }
        let set = builder.build().unwrap_or_else(|_| GlobSet::empty());
        Self { patterns: patterns.to_vec(), set }
    }

    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    pub fn matches(&self, root: &str, rel_path: &str) -> bool {
        self.set.is_match(root_relative_key(root, rel_path))
    }
}

impl PartialEq for Globs {
    fn eq(&self, other: &Self) -> bool {
        self.patterns == other.patterns
    }
}

pub fn should_walk_dir(name: &str, skip_dirs: &[&str]) -> bool {
    !skip_dirs.contains(&name)
}

pub fn should_index_name(name: &str, skip_names: &[&str]) -> bool {
    !(name.starts_with("._") || skip_names.contains(&name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn globs(patterns: &[&str]) -> Globs {
        Globs::new(&patterns.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>())
    }

    #[test]
    fn prefixes_are_trimmed() {
        assert_eq!(split_prefixes(" Photos/, /Videos/Raw ,,"), vec!["Photos", "Videos/Raw"]);
        assert!(split_prefixes("").is_empty());
    }

    #[test]
    fn globs_follow_fnmatch() {
        assert!(globs(&["**"]).matches("r", "a/b/c.jpg"));
        assert!(globs(&["r/*"]).matches("r", "a/b/c.jpg"), "a star crosses slashes like fnmatch");
        assert!(globs(&["r/Photos/*"]).matches("r", "Photos/2024/x.png"));
        assert!(!globs(&["r/Photos/*"]).matches("r", "PhotosArchive/x.png"));
        assert!(!globs(&["r/photos/*"]).matches("r", "Photos/x.png"), "case-sensitive");
        assert!(globs(&["*.tmp", "r/scans/?.png"]).matches("r", "scans/1.png"));
        assert!(globs(&["r/[!a]*"]).matches("r", "b.txt"));
        assert!(!globs(&["r/[!a]*"]).matches("r", "a.txt"));
        assert!(!globs(&[]).matches("r", "anything"));
        assert!(!globs(&["[unclosed"]).matches("r", "[unclosed"));
        assert_eq!(globs(&["a"]), globs(&["a"]));
        assert_eq!(globs(&["a", "b"]).patterns(), ["a", "b"]);
    }

    #[test]
    fn names_and_dirs() {
        assert!(!should_index_name("._x", &[]));
        assert!(!should_index_name("Thumbs.db", &["Thumbs.db"]));
        assert!(should_index_name("x", &["Thumbs.db"]));
        assert!(!should_walk_dir(".git", &[".git"]));
        assert!(should_walk_dir("src", &[".git"]));
    }
}
