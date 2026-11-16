//! Walking a root: every regular file below it, and every folder it descends into.
//!
//! On network and FUSE storage (Unraid's `/mnt/user` is one) every look at a folder or a file
//! is a round trip, so reading one folder at a time leaves the walk waiting on latency. While
//! the caller works through one folder, a few reader threads list and stat the folders that
//! come next. The callbacks still run on the caller's thread, in the order a walk of one folder
//! at a time calls them: a folder's files by lowercase name, then each of its folders the same
//! way, depth first.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crossbeam_channel::{Receiver, Sender};
use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags};

use crate::config::{SKIP_DIRS, SKIP_NAMES};
use crate::db::FolderRow;
use crate::indexer::FileStat;
use crate::log::log;
use crate::rules::{should_index_name, should_walk_dir};

/// Folders read at once besides the caller's own. Each read waits on the storage, not the
/// CPU, so a few in flight hide most of a slow filesystem's latency.
const READERS: usize = 8;

/// How many folders, in walk order, readers may list before the caller gets to them.
const AHEAD_PER_READER: usize = 4;

/// Yield `(abs, rel, stat)` for regular files below `root`, directories sorted by
/// lowercase name, skipping junk. `on_error` hears about unreadable entries.
pub fn walk(root: &Path, on_error: impl FnMut(), visit: impl FnMut(PathBuf, String, FileStat) -> bool) {
    walk_tree(root, on_error, |_| {}, visit);
}

/// `walk`, also reporting each folder below `root` it will descend into, before its contents.
pub fn walk_tree(
    root: &Path,
    on_error: impl FnMut(),
    on_folder: impl FnMut(FolderRow),
    visit: impl FnMut(PathBuf, String, FileStat) -> bool,
) {
    walk_with(READERS, root, on_error, on_folder, visit);
}

/// A folder the walk has found and not yet reported.
struct Pending {
    abs: PathBuf,
    rel: String,
    /// Whether a reader has it; otherwise the caller reads it when it comes up.
    dispatched: bool,
    listing: Option<Listing>,
}

impl Pending {
    fn new(abs: PathBuf, rel: String) -> Self {
        Self {
            abs,
            rel,
            dispatched: false,
            listing: None,
        }
    }
}

/// What one folder holds.
#[derive(Default)]
struct Listing {
    /// The folder's own modification time, for a folder below the root.
    mtime_ns: Option<i64>,
    /// Regular files: raw name, name and stat, by lowercase name.
    files: Vec<(OsString, String, FileStat)>,
    /// Folders the walk descends into: raw name and name, by lowercase name.
    dirs: Vec<(OsString, String)>,
    /// What could not be read, as log lines. Each makes the walk incomplete.
    errors: Vec<String>,
}

/// Sets the flag when the walk ends, however it ends, so readers stop.
struct Stop<'a>(&'a AtomicBool);

impl Drop for Stop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn walk_with(
    readers: usize,
    root: &Path,
    mut on_error: impl FnMut(),
    mut on_folder: impl FnMut(FolderRow),
    mut visit: impl FnMut(PathBuf, String, FileStat) -> bool,
) {
    let stopped = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (jobs, job_queue) = crossbeam_channel::unbounded::<(usize, PathBuf)>();
        let (done, answers) = crossbeam_channel::unbounded::<(usize, Listing)>();
        let _stop = Stop(&stopped);
        let (mut spawned, mut in_flight) = (0, 0);
        // Folders still to report, the next one last. A folder keeps its index until it is
        // reported, so a reader's answer names the folder by index.
        let mut stack = vec![Pending::new(root.to_path_buf(), String::new())];
        while let Some(head) = stack.len().checked_sub(1) {
            for index in (head.saturating_sub(readers * AHEAD_PER_READER)..head).rev() {
                let pending = &mut stack[index];
                if pending.dispatched {
                    continue;
                }
                if spawned < readers && spawned <= in_flight {
                    let (job_queue, done, stopped) = (job_queue.clone(), done.clone(), &stopped);
                    let reader = std::thread::Builder::new()
                        .name("walk".to_owned())
                        .spawn_scoped(scope, move || read(&job_queue, &done, stopped));
                    spawned += usize::from(reader.is_ok());
                }
                if spawned == 0 {
                    break;
                }
                pending.dispatched = jobs.send((index, pending.abs.clone())).is_ok();
                in_flight += usize::from(pending.dispatched);
            }
            let listing = if stack[head].dispatched {
                // This thread keeps a sender and every job is answered, so `recv` cannot fail.
                while stack[head].listing.is_none()
                    && let Ok((index, listing)) = answers.recv()
                {
                    in_flight -= 1;
                    stack[index].listing = Some(listing);
                }
                stack[head].listing.take().unwrap_or_else(|| Listing {
                    errors: vec![format!("skip dir {}: not read", stack[head].abs.display())],
                    ..Listing::default()
                })
            } else {
                list(&stack[head].abs, stack[head].rel.is_empty(), &stopped)
            };
            let Pending { abs, rel, .. } = stack.remove(head);
            if let Some(mtime_ns) = listing.mtime_ns {
                on_folder(FolderRow {
                    path: rel.clone(),
                    mtime_ns,
                });
            }
            for message in &listing.errors {
                log(message);
                on_error();
            }
            for (raw, name, stat) in listing.files {
                if !visit(abs.join(raw), child(&rel, &name), stat) {
                    return;
                }
            }
            let dirs = listing.dirs.into_iter().rev();
            stack.extend(dirs.map(|(raw, name)| Pending::new(abs.join(raw), child(&rel, &name))));
        }
    });
}

fn child(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_owned()
    } else {
        format!("{rel}/{name}")
    }
}

/// A reader thread: list folders until the walk ends.
fn read(job_queue: &Receiver<(usize, PathBuf)>, done: &Sender<(usize, Listing)>, stopped: &AtomicBool) {
    for (index, dir) in job_queue {
        if stopped.load(Ordering::Relaxed) || done.send((index, list(&dir, false, stopped))).is_err() {
            return;
        }
    }
}

/// `FileStat` for a raw stat, whose field types differ between platforms.
#[allow(clippy::unnecessary_cast)]
fn file_stat(stat: &rustix::fs::Stat) -> FileStat {
    FileStat {
        size: stat.st_size as u64,
        mtime_ns: stat.st_mtime as i64 * 1_000_000_000 + stat.st_mtime_nsec as i64,
    }
}

/// List `dir`, the walk's root when `top` (which alone may be reached through a link). The
/// entry's own type says what a folder is, and what is neither file nor folder; only files
/// are looked at, for their size and time, relative to the open folder.
fn list(dir: &Path, top: bool, stopped: &AtomicBool) -> Listing {
    let mut listing = Listing::default();
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    let flags = if top { flags } else { flags | OFlags::NOFOLLOW };
    let opened = rustix::fs::open(dir, flags, Mode::empty()).and_then(|fd| {
        let mtime_ns = if top {
            None
        } else {
            Some(file_stat(&rustix::fs::fstat(&fd)?).mtime_ns)
        };
        Ok((Dir::new(fd)?, mtime_ns))
    });
    let mut entries = match opened {
        Ok((entries, mtime_ns)) => {
            listing.mtime_ns = mtime_ns;
            entries
        }
        Err(e) => {
            // A folder that cannot be read is still a folder the walk found.
            listing.mtime_ns = std::fs::symlink_metadata(dir)
                .ok()
                .filter(|m| !top && m.is_dir())
                .map(|m| FileStat::of(&m).mtime_ns);
            listing.errors.push(format!("skip dir {}: {e}", dir.display()));
            return listing;
        }
    };
    while let Some(entry) = entries.read() {
        if stopped.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                listing.errors.push(format!("skip dir {}: {e}", dir.display()));
                break;
            }
        };
        let raw = entry.file_name().to_bytes();
        if raw == b"." || raw == b".." {
            continue;
        }
        let name = String::from_utf8_lossy(raw).into_owned();
        if !should_index_name(&name, SKIP_NAMES) {
            continue;
        }
        let raw = OsStr::from_bytes(raw).to_owned();
        let (kind, stat) = match entry.file_type() {
            FileType::Directory => (FileType::Directory, None),
            FileType::RegularFile | FileType::Unknown => {
                let stat = entries
                    .fd()
                    .and_then(|fd| rustix::fs::statat(fd, entry.file_name(), AtFlags::SYMLINK_NOFOLLOW));
                match stat {
                    Ok(stat) => (FileType::from_raw_mode(stat.st_mode), Some(file_stat(&stat))),
                    Err(e) => {
                        listing.errors.push(format!("skip {}: {e}", dir.join(&raw).display()));
                        continue;
                    }
                }
            }
            // Links, pipes, sockets and devices are never indexed or followed.
            _ => continue,
        };
        match (kind, stat) {
            (FileType::RegularFile, Some(stat)) => listing.files.push((raw, name, stat)),
            (FileType::Directory, _) if should_walk_dir(&name, SKIP_DIRS) => listing.dirs.push((raw, name)),
            _ => {}
        }
    }
    listing.files.sort_by_cached_key(|(_, name, _)| name.to_lowercase());
    listing.dirs.sort_by_cached_key(|(_, name)| name.to_lowercase());
    listing
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// What a walk reported, in the order it reported it.
    #[derive(Debug, Default, PartialEq)]
    struct Seen {
        files: Vec<(PathBuf, String, FileStat)>,
        folders: Vec<(String, i64)>,
        errors: usize,
    }

    fn walked(readers: usize, root: &Path, stop_after: usize) -> Seen {
        let mut seen = Seen::default();
        let mut files = Vec::new();
        let mut folders = Vec::new();
        walk_with(
            readers,
            root,
            || seen.errors += 1,
            |folder| folders.push((folder.path, folder.mtime_ns)),
            |abs, rel, stat| {
                files.push((abs, rel, stat));
                files.len() < stop_after
            },
        );
        seen.files = files;
        seen.folders = folders;
        seen
    }

    /// Folders a few levels deep and of uneven size, so readers finish out of order.
    fn tree(root: &Path) {
        for a in 0..6 {
            for b in 0..(a * 3) {
                let dir = root.join(format!("Dir {a}/sub {b}"));
                std::fs::create_dir_all(dir.join("deeper/deepest")).unwrap();
                for f in 0..(b % 5) {
                    std::fs::write(dir.join(format!("f{f}.txt")), "x".repeat(f)).unwrap();
                }
                std::fs::write(dir.join("deeper/deepest/z.bin"), [a as u8, b as u8]).unwrap();
            }
            std::fs::write(root.join(format!("Top {a}.txt")), "top").unwrap();
        }
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::create_dir_all(root.join("Dir 2/node_modules/pkg")).unwrap();
        std::fs::write(root.join("Dir 2/node_modules/pkg/index.js"), "skipped").unwrap();
        std::fs::write(root.join("Dir 3/._resource"), "skipped").unwrap();
        std::os::unix::fs::symlink(root.join("Dir 3"), root.join("Dir 4/link")).unwrap();
        std::os::unix::fs::symlink(root.join("Top 1.txt"), root.join("Dir 4/file-link")).unwrap();
        std::os::unix::net::UnixListener::bind(root.join("Dir 5/socket")).unwrap();
    }

    #[test]
    fn readers_report_what_one_folder_at_a_time_reports_in_the_same_order() {
        let dir = tempfile::tempdir().unwrap();
        tree(dir.path());
        let alone = walked(0, dir.path(), usize::MAX);
        // 6 top files, 45 subfolders' 80 files and their 45 deepest files; 5 folders on top,
        // three in each subfolder and `empty`.
        assert_eq!(alone.files.len(), 6 + 80 + 45);
        assert_eq!(alone.folders.len(), 5 + 45 * 3 + 1);
        assert_eq!(alone.errors, 0);
        assert_eq!(alone.files[0].1, "Top 0.txt");
        assert_eq!(alone.files[6].1, "Dir 1/sub 0/deeper/deepest/z.bin");
        assert!(alone.files.iter().all(|(abs, rel, _)| *abs == dir.path().join(rel)));
        assert!(alone.folders.iter().all(|(_, mtime_ns)| *mtime_ns > 0));
        for readers in [1, 2, READERS] {
            assert_eq!(walked(readers, dir.path(), usize::MAX), alone, "{readers} readers");
        }
    }

    #[test]
    fn stopping_ends_the_walk_with_readers_ahead() {
        let dir = tempfile::tempdir().unwrap();
        tree(dir.path());
        let all = walked(0, dir.path(), usize::MAX);
        for stop_after in [1, 7, 40] {
            let seen = walked(READERS, dir.path(), stop_after);
            assert_eq!(seen.files, all.files[..stop_after], "stop after {stop_after}");
        }
    }

    #[test]
    fn an_unreadable_folder_is_reported_and_makes_the_walk_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["a", "b", "c"] {
            std::fs::create_dir_all(root.join(name).join("inner")).unwrap();
            std::fs::write(root.join(name).join("inner/x.txt"), "x").unwrap();
        }
        std::fs::set_permissions(root.join("b"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let seen = walked(READERS, root, usize::MAX);
        let alone = walked(0, root, usize::MAX);
        std::fs::set_permissions(root.join("b"), std::fs::Permissions::from_mode(0o755)).unwrap();
        if seen.errors == 0 {
            return; // Running as root: permissions do not apply.
        }
        let rels: Vec<&str> = seen.files.iter().map(|(_, rel, _)| rel.as_str()).collect();
        assert_eq!(rels, ["a/inner/x.txt", "c/inner/x.txt"]);
        // `b` was found, so it is reported, with its time, though nothing in it could be read.
        let folders: Vec<&str> = seen.folders.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(folders, ["a", "a/inner", "b", "c", "c/inner"]);
        assert_eq!(seen.errors, 1);
        assert_eq!(seen, alone);
    }

    #[test]
    fn a_folder_gone_before_it_is_read_makes_the_walk_incomplete() {
        let dir = tempfile::tempdir().unwrap();
        let listing = list(&dir.path().join("gone"), false, &AtomicBool::new(false));
        assert_eq!(listing.mtime_ns, None);
        assert_eq!(listing.errors.len(), 1, "{:?}", listing.errors);
        assert!(listing.errors[0].starts_with("skip dir "), "{:?}", listing.errors);
    }

    #[test]
    fn only_the_root_may_be_a_link() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("real")).unwrap();
        std::fs::write(dir.path().join("real/a.txt"), "a").unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        let through = walked(READERS, &dir.path().join("link"), usize::MAX);
        assert_eq!(through.files[0].1, "a.txt");
        let listing = list(&dir.path().join("link"), false, &AtomicBool::new(false));
        assert!(listing.files.is_empty() && listing.mtime_ns.is_none());
        assert_eq!(listing.errors.len(), 1);
    }

    #[test]
    fn names_that_are_not_utf8_keep_their_bytes_in_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let raw = OsStr::from_bytes(b"caf\xe9.txt");
        if std::fs::write(dir.path().join(raw), "x").is_err() {
            return; // The filesystem only takes UTF-8 names.
        }
        let seen = walked(READERS, dir.path(), usize::MAX);
        assert_eq!(seen.files.len(), 1);
        assert_eq!(seen.files[0].0, dir.path().join(raw));
        assert_eq!(seen.files[0].1, "caf\u{fffd}.txt");
    }
}
