//! Bounded, descriptor-relative directory listings for the API's scope verification.

use std::io;
use std::path::Path;

use serde::Serialize;

use crate::fsx::{entry_kind, open_dir, path_parts};

pub const MAX_ENTRIES: usize = 10_000;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct Listing {
    pub items: Vec<Entry>,
    pub overflow: bool,
}

/// Exactly `root` and `path` once each, a sane root name and a canonical path.
pub fn query(fields: &[(String, String)]) -> Result<(String, String), &'static str> {
    let names: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
    if fields.len() != 2 || !names.contains(&"root") || !names.contains(&"path") {
        return Err("root and path are required");
    }
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let (root, path) = (get("root"), get("path"));
    if root.is_empty() || root.chars().count() > 255 || root.chars().any(char::is_control) {
        return Err("invalid root");
    }
    path_parts(&path)?;
    Ok((root, path))
}

pub fn list(root: &Path, path: &str) -> io::Result<Listing> {
    let parts = path_parts(path).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let fd = open_dir(root, &parts)?;
    let mut dir = rustix::fs::Dir::read_from(&fd)?;
    let mut items = Vec::new();
    let mut overflow = false;
    while let Some(entry) = dir.read() {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "." || name == ".." {
            continue;
        }
        if items.len() == MAX_ENTRIES {
            overflow = true;
            break;
        }
        let kind = entry_kind(&fd, &name);
        items.push(Entry { name, kind });
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Listing { items, overflow })
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn q(pairs: &[(&str, &str)]) -> Result<(String, String), &'static str> {
        query(
            &pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn queries_are_strict() {
        assert_eq!(q(&[("root", "r"), ("path", "/a")]).unwrap(), ("r".into(), "/a".into()));
        assert!(q(&[("root", "r")]).is_err());
        assert!(q(&[("root", "r"), ("root", "s")]).is_err());
        assert!(q(&[("root", "r"), ("path", "/"), ("x", "y")]).is_err());
        assert!(q(&[("root", ""), ("path", "/")]).is_err());
        assert!(q(&[("root", "r\n"), ("path", "/")]).is_err());
        assert!(q(&[("root", &"r".repeat(256)), ("path", "/")]).is_err());
        assert!(q(&[("root", "r"), ("path", "/../x")]).is_err());
    }

    #[test]
    fn listings_report_kinds_sorted_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("b")).unwrap();
        std::fs::write(root.join("a.txt"), "").unwrap();
        symlink(root.join("b"), root.join("c")).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(root.join("d"))
                .status()
                .unwrap()
                .success()
        );
        let listing = list(root, "/").unwrap();
        let kinds: Vec<_> = listing.items.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(
            kinds,
            vec![("a.txt", "file"), ("b", "dir"), ("c", "symlink"), ("d", "other")]
        );
        assert!(!listing.overflow);
        // Linux reports ELOOP for a symlink opened with O_NOFOLLOW, macOS ENOTDIR.
        let errno = list(root, "/c").unwrap_err().raw_os_error();
        assert!(
            [rustix::io::Errno::LOOP, rustix::io::Errno::NOTDIR]
                .map(|e| Some(e.raw_os_error()))
                .contains(&errno)
        );
        assert!(list(root, "/a.txt").is_err());
        assert_eq!(list(root, "/missing").unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(list(root, "bad").unwrap_err().kind(), io::ErrorKind::InvalidInput);
        for i in 0..=MAX_ENTRIES {
            std::fs::write(root.join("b").join(format!("{i}")), "").unwrap();
        }
        let listing = list(root, "/b").unwrap();
        assert!(listing.overflow);
        assert_eq!(listing.items.len(), MAX_ENTRIES);
    }
}
