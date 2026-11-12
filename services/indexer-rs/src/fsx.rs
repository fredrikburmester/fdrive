//! Descriptor-relative file access below a root: no symlink below the root is followed,
//! and an opened file stays the same inode even if its directory entry is replaced.

use std::fs::File;
use std::io::{self, Read};
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

use rustix::fs::{AtFlags, FileType, Mode, OFlags, openat, statat};
use sha2::{Digest, Sha256};

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const FILE: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NONBLOCK);

/// Validate a canonical root-relative path (`/` or `/a/b`) and return its components.
pub fn path_parts(path: &str) -> Result<Vec<String>, &'static str> {
    if !path.starts_with('/')
        || path.chars().count() > 4096
        || path.contains('\\')
        || path.chars().any(char::is_control)
    {
        return Err("invalid path");
    }
    if path == "/" {
        return Ok(Vec::new());
    }
    let parts: Vec<String> = path[1..].split('/').map(str::to_owned).collect();
    if parts.iter().any(|p| p.is_empty() || p == "." || p == "..") {
        return Err("invalid path");
    }
    Ok(parts)
}

/// Open the directory at `parts` below `root`. The root itself is trusted and may be a symlink.
pub fn open_dir(root: &Path, parts: &[String]) -> io::Result<OwnedFd> {
    let mut fd = rustix::fs::open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    for part in parts {
        fd = openat(&fd, part.as_str(), DIRECTORY, Mode::empty())?;
    }
    Ok(fd)
}

/// A regular file below `root`, opened without following symlinks.
pub struct OpenedFile {
    pub file: File,
    pub size: u64,
}

impl OpenedFile {
    /// A path that reopens this exact descriptor, for tools that need a path.
    pub fn path(&self) -> PathBuf {
        descriptor_path(&self.file)
    }
}

pub fn descriptor_path(file: &impl AsFd) -> PathBuf {
    use std::os::fd::AsRawFd;
    let fd = file.as_fd().as_raw_fd();
    if Path::new("/proc/self/fd").is_dir() {
        PathBuf::from(format!("/proc/self/fd/{fd}"))
    } else {
        PathBuf::from(format!("/dev/fd/{fd}"))
    }
}

pub fn open_file(root: &Path, parts: &[String]) -> io::Result<OpenedFile> {
    let (name, dirs) = parts
        .split_last()
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
    let dir = open_dir(root, dirs)?;
    let fd = openat(&dir, name.as_str(), FILE, Mode::empty())?;
    regular(fd)
}

fn regular(fd: OwnedFd) -> io::Result<OpenedFile> {
    let stat = rustix::fs::fstat(&fd)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(io::Error::new(io::ErrorKind::NotFound, "not a regular file"));
    }
    Ok(OpenedFile {
        file: File::from(fd),
        size: stat.st_size as u64,
    })
}

/// Open an absolute path that must itself not be a symlink, refusing FIFOs and devices
/// without blocking on them.
pub fn open_regular(path: &Path) -> io::Result<OpenedFile> {
    let fd = rustix::fs::open(path, FILE, Mode::empty())?;
    regular(fd).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("not a regular file: {e}")))
}

pub fn sha256_of_file(file: &mut File) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 4 * 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

pub fn sha256_of(path: &Path) -> io::Result<String> {
    sha256_of_file(&mut open_regular(path)?.file)
}

/// The kind of a directory entry, never following a symlink.
pub fn entry_kind(dir: &impl AsFd, name: &str) -> &'static str {
    match statat(dir, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => match FileType::from_raw_mode(stat.st_mode) {
            FileType::Symlink => "symlink",
            FileType::Directory => "dir",
            FileType::RegularFile => "file",
            _ => "other",
        },
        Err(_) => "other",
    }
}

/// Unlink a regular file at `relative` below the directory `base`, through pinned
/// directories. A missing file is success.
pub fn remove_below(base: &OwnedFd, relative: &str) -> anyhow::Result<()> {
    if relative.split('/').any(|p| p.is_empty() || p == "." || p == "..") || relative.contains(['\0', '\\']) {
        anyhow::bail!("ValueError: unsafe thumbnail storage path");
    }
    let parts: Vec<&str> = relative.split('/').collect();
    let (name, dirs) = parts
        .split_last()
        .ok_or_else(|| anyhow::anyhow!("ValueError: unsafe thumbnail storage path"))?;
    let mut fd = rustix::io::dup(base)?;
    for part in dirs {
        fd = match openat(&fd, *part, DIRECTORY, Mode::empty()) {
            Ok(fd) => fd,
            Err(rustix::io::Errno::NOENT) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
    }
    match statat(&fd, *name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile => {
            anyhow::bail!("ValueError: thumbnail is not a regular file")
        }
        Ok(_) => match rustix::fs::unlinkat(&fd, *name, AtFlags::empty()) {
            Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
            Err(error) => Err(error.into()),
        },
        Err(rustix::io::Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Open every component of an absolute directory path without following symlinks.
pub fn open_dir_nofollow(path: &Path) -> io::Result<OwnedFd> {
    let mut fd = rustix::fs::open("/", DIRECTORY, Mode::empty())?;
    for part in path.components() {
        if let std::path::Component::Normal(part) = part {
            fd = openat(&fd, part, DIRECTORY, Mode::empty())?;
        }
    }
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;

    fn parts(path: &str) -> Vec<String> {
        path_parts(path).unwrap()
    }

    #[test]
    fn path_validation() {
        assert_eq!(parts("/"), Vec::<String>::new());
        assert_eq!(parts("/a/%2e%2e/b c"), vec!["a", "%2e%2e", "b c"]);
        for bad in ["", "a", "//", "/a/", "/./a", "/a/..", "/a\\b", "/a\0", "/a\x7f"] {
            assert!(path_parts(bad).is_err(), "{bad:?}");
        }
        assert!(path_parts(&format!("/{}", "a".repeat(4096))).is_err());
    }

    #[test]
    fn opening_never_follows_symlinks_below_the_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("docs/a.txt"), "hello").unwrap();
        symlink(dir.path().join("docs"), dir.path().join("link")).unwrap();
        symlink(dir.path().join("docs/a.txt"), dir.path().join("docs/b.txt")).unwrap();
        let mut opened = open_file(dir.path(), &parts("/docs/a.txt")).unwrap();
        assert_eq!(opened.size, 5);
        assert!(opened.path().to_string_lossy().contains("/fd/"));
        assert_eq!(
            sha256_of_file(&mut opened.file).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert!(open_file(dir.path(), &parts("/link/a.txt")).is_err());
        assert!(open_file(dir.path(), &parts("/docs/b.txt")).is_err());
        assert!(open_file(dir.path(), &parts("/docs")).is_err());
        assert!(open_file(dir.path(), &[]).is_err());
        assert_eq!(
            open_file(dir.path(), &parts("/missing")).err().unwrap().kind(),
            io::ErrorKind::NotFound
        );
        let fd = open_dir(dir.path(), &parts("/docs")).unwrap();
        assert_eq!(entry_kind(&fd, "a.txt"), "file");
        assert_eq!(entry_kind(&fd, "b.txt"), "symlink");
        let root = open_dir(dir.path(), &[]).unwrap();
        assert_eq!(entry_kind(&root, "docs"), "dir");
        assert_eq!(entry_kind(&root, "nothing"), "other");
    }

    #[test]
    fn hashing_refuses_fifos_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let fifo = dir.path().join("fifo");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        assert!(sha256_of(&fifo).unwrap_err().to_string().contains("not a regular file"));
        std::fs::write(dir.path().join("f"), "").unwrap();
        symlink(dir.path().join("f"), dir.path().join("l")).unwrap();
        assert!(sha256_of(&dir.path().join("l")).is_err());
        assert_eq!(sha256_of(&dir.path().join("f")).unwrap().len(), 64);
    }

    #[test]
    fn removal_is_pinned_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("ab")).unwrap();
        std::fs::write(dir.path().join("ab/x.webp"), "x").unwrap();
        std::fs::create_dir(dir.path().join("cd")).unwrap();
        symlink(dir.path().join("ab"), dir.path().join("linked")).unwrap();
        symlink(dir.path().join("ab/x.webp"), dir.path().join("cd/y.webp")).unwrap();
        // macOS keeps temporary directories behind the /var symlink.
        let base = open_dir_nofollow(&dir.path().canonicalize().unwrap()).unwrap();
        for bad in ["", "/etc/passwd", "../x", "a/../x", "a//b", "a\\b", "a\0", "./a"] {
            assert!(remove_below(&base, bad).is_err(), "{bad:?}");
        }
        assert!(remove_below(&base, "linked/x.webp").is_err());
        assert!(remove_below(&base, "cd/y.webp").is_err());
        assert!(remove_below(&base, "ab").is_err());
        remove_below(&base, "ab/missing.webp").unwrap();
        remove_below(&base, "zz/missing.webp").unwrap();
        remove_below(&base, "ab/x.webp").unwrap();
        assert!(!dir.path().join("ab/x.webp").exists());
        assert!(open_dir_nofollow(&dir.path().join("linked")).is_err());
    }
}
