//! End-to-end encrypted folders (docs/plans/ENCRYPTION.md). Such a folder holds a
//! `.fdrive-encrypted` marker at its top, and every entry below it is stored under an encrypted
//! name, its bytes an age file. The indexer records each file's row there (size, times and the
//! digest of the bytes on disk) and reads nothing else from it: no EXIF, thumbnails, image
//! embeddings or text. A file put there from outside fdrive keeps its clear name and is skipped
//! the same way. Encrypted names stay out of the name index.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{PoisonError, RwLock};
use std::time::{Duration, Instant};

use rustix::fs::{AtFlags, Mode, OFlags, openat, statat};
use rustix::io::Errno;

/// The file at the top of an encrypted folder that holds its keys. Never indexed.
pub const MARKER: &str = ".fdrive-encrypted";

/// What every encrypted name starts with: the format's version.
pub const NAME_PREFIX: &str = "fe1-";

/// The `idx.files.error` of a file inside an encrypted folder, whose `text_status` is
/// `excluded`. The OCR service leaves rows with it out of its candidates.
pub const REASON: &str = "excluded:encrypted";

/// The shortest encrypted name after its prefix: a 12-byte nonce, a 16-byte tag and one byte of
/// name in unpadded base32. The longest holds a name of 128 bytes.
const MIN_NAME_CHARS: usize = 47;
const MAX_NAME_CHARS: usize = 250;

/// How long a folder's answer is reused before its marker is looked for again. A marker comes
/// and goes with its folder, so a change is rare, and the watcher forgets a folder it saw
/// deleted, moved or made at once.
pub const MARKER_RECHECK: Duration = Duration::from_secs(10);

/// The most folder answers kept. Past it they are all dropped and looked for again.
const MAX_FOLDERS: usize = 100_000;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// Whether a stored name has the shape of an encrypted name, as `isEncryptedName` in
/// `@fdrive/contracts` decides it: the prefix, then lowercase unpadded base32 of a length that
/// leaves fewer than five spare bits. Only a client can tell whether it decrypts.
pub fn is_encrypted_name(name: &str) -> bool {
    let Some(body) = name.strip_prefix(NAME_PREFIX) else {
        return false;
    };
    (MIN_NAME_CHARS..=MAX_NAME_CHARS).contains(&body.len())
        && matches!(body.len() % 8, 0 | 2 | 4 | 5 | 7)
        && body
            .bytes()
            .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
}

/// Which folders below a root hold a marker, each answer reused for `recheck`.
#[derive(Debug)]
pub struct Markers {
    recheck: Duration,
    /// Root-relative folder to when it was looked at and whether it held a marker.
    seen: RwLock<BTreeMap<String, (Instant, bool)>>,
}

impl Default for Markers {
    fn default() -> Self {
        Self::new(MARKER_RECHECK)
    }
}

impl Markers {
    pub fn new(recheck: Duration) -> Self {
        Self {
            recheck,
            seen: RwLock::new(BTreeMap::new()),
        }
    }

    /// Whether the entry at root-relative `rel_path` lies inside an encrypted folder: a part of
    /// its path is an encrypted name (an item put in Trash on its own keeps its encrypted name),
    /// or a folder between the root and it holds a marker. The root itself is never one.
    pub fn inside(&self, root: &Path, rel_path: &str) -> bool {
        let rel = rel_path.trim_matches('/');
        if rel.split('/').any(is_encrypted_name) {
            return true;
        }
        // Where each folder above the entry ends: `rel[..ends[i]]` is the folder.
        let ends: Vec<usize> = rel.match_indices('/').map(|(i, _)| i).collect();
        let now = Instant::now();
        let mut unknown = Vec::new();
        {
            let seen = self.seen.read().unwrap_or_else(PoisonError::into_inner);
            for (i, end) in ends.iter().enumerate() {
                match seen.get(&rel[..*end]) {
                    Some(&(at, marked)) if now.duration_since(at) < self.recheck => {
                        if marked {
                            return true;
                        }
                    }
                    _ => unknown.push(i),
                }
            }
        }
        if unknown.is_empty() {
            return false;
        }
        let found = look(root, rel, &ends, &unknown);
        let mut seen = self.seen.write().unwrap_or_else(PoisonError::into_inner);
        if seen.len() + found.len() > MAX_FOLDERS {
            seen.clear();
        }
        let mut inside = false;
        for (i, marked) in found {
            inside |= marked;
            seen.insert(rel[..ends[i]].to_owned(), (now, marked));
        }
        inside
    }

    /// Forget what is known about `rel` and the folders below it (everything for `""`), so the
    /// next look reads the disk.
    pub fn forget(&self, rel: &str) {
        let rel = rel.trim_matches('/');
        let mut seen = self.seen.write().unwrap_or_else(PoisonError::into_inner);
        if rel.is_empty() {
            seen.clear();
            return;
        }
        // Everything from `rel/` up to, not including, `rel0`: '0' follows '/'.
        let below: Vec<String> = seen
            .range(format!("{rel}/")..format!("{rel}0"))
            .map(|(folder, _)| folder.clone())
            .collect();
        for folder in below {
            seen.remove(&folder);
        }
        seen.remove(rel);
    }
}

/// Look for the marker in the folders of `rel` at `wanted` (indexes into `ends`, ascending),
/// opening each part from the root without following a link. Stops at the first folder that
/// holds one. A folder that cannot be opened or read, and those below it, have no answer.
fn look(root: &Path, rel: &str, ends: &[usize], wanted: &[usize]) -> Vec<(usize, bool)> {
    let mut found = Vec::with_capacity(wanted.len());
    let Ok(mut dir) = crate::fsx::open_dir(root, &[]) else {
        return found;
    };
    let mut start = 0;
    for (i, end) in ends
        .iter()
        .enumerate()
        .take(wanted.last().map_or(0, |deepest| deepest + 1))
    {
        match openat(&dir, &rel[start..*end], DIRECTORY, Mode::empty()) {
            Ok(next) => dir = next,
            Err(_) => return found,
        }
        start = end + 1;
        if !wanted.contains(&i) {
            continue;
        }
        match statat(&dir, MARKER, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => {
                found.push((i, true));
                return found;
            }
            Err(Errno::NOENT) => found.push((i, false)),
            Err(_) => return found,
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A well-formed encrypted name with `chars` characters after the prefix.
    fn name(chars: usize) -> String {
        format!(
            "{NAME_PREFIX}{}",
            "a2".repeat(chars).chars().take(chars).collect::<String>()
        )
    }

    #[test]
    fn encrypted_names_have_the_contracts_shape() {
        for chars in [47, 48, 50, 52, 53, 55, 56, 248, 250] {
            assert!(is_encrypted_name(&name(chars)), "{chars}");
        }
        // Lengths that leave five or more spare bits, too short or too long.
        for chars in [46, 49, 51, 54, 57, 251, 0] {
            assert!(!is_encrypted_name(&name(chars)), "{chars}");
        }
        let valid = name(48);
        for clear in [
            valid.to_uppercase(),
            valid.replace("fe1-", "fe2-"),
            valid.replace('2', "1"),
            valid.replace('a', "8"),
            format!("{valid}.pdf"),
            format!("x{valid}"),
            "report.pdf".to_owned(),
            String::new(),
        ] {
            assert!(!is_encrypted_name(&clear), "{clear}");
        }
    }

    #[test]
    fn a_marker_above_or_an_encrypted_part_puts_an_entry_inside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("alice/Secret/inner")).unwrap();
        std::fs::create_dir_all(root.join("alice/Plain/inner")).unwrap();
        std::fs::write(root.join("alice/Secret").join(MARKER), "{}").unwrap();
        std::fs::write(root.join(MARKER), "{}").unwrap();
        let markers = Markers::default();
        assert!(markers.inside(root, "alice/Secret/stray.pdf"));
        assert!(markers.inside(root, "/alice/Secret/inner/stray.pdf/"));
        assert!(!markers.inside(root, "alice/Plain/inner/a.pdf"));
        // The folder itself is not inside, and a marker at the top of the root does not count.
        assert!(!markers.inside(root, "alice/Secret"));
        assert!(!markers.inside(root, "a.pdf"));
        assert!(!markers.inside(root, ""));
        // A part with an encrypted name is enough, wherever it lies and whether or not it exists.
        let encrypted = name(48);
        assert!(markers.inside(root, &format!("alice/.trash/0b8f/{encrypted}")));
        assert!(markers.inside(root, &format!("alice/.trash/0b8f/{encrypted}/stray.pdf")));
        // A folder that is gone, or a link on the way, has no marker.
        assert!(!markers.inside(root, "alice/Missing/x/a.pdf"));
        std::os::unix::fs::symlink(root.join("alice/Secret"), root.join("alice/Linked")).unwrap();
        assert!(!markers.inside(root, "alice/Linked/stray.pdf"));
        let gone = Markers::default();
        assert!(!gone.inside(&root.join("nowhere"), "alice/Secret/stray.pdf"));
    }

    #[test]
    fn answers_are_reused_until_they_expire_or_are_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        let markers = Markers::new(Duration::from_secs(3600));
        assert!(!markers.inside(root, "a/b/c/x.pdf"));
        std::fs::write(root.join("a/b").join(MARKER), "{}").unwrap();
        assert!(!markers.inside(root, "a/b/c/x.pdf"), "the answer is reused");
        markers.forget("a/b/c");
        assert!(
            !markers.inside(root, "a/b/c/x.pdf"),
            "forgetting below the marker changes nothing"
        );
        markers.forget("a/bc");
        markers.forget("a/b");
        assert!(markers.inside(root, "a/b/c/x.pdf"));
        std::fs::remove_file(root.join("a/b").join(MARKER)).unwrap();
        assert!(markers.inside(root, "a/b/x.pdf"), "the answer is reused");
        markers.forget("");
        assert!(!markers.inside(root, "a/b/x.pdf"));
        let fresh = Markers::new(Duration::ZERO);
        std::fs::write(root.join("a").join(MARKER), "{}").unwrap();
        assert!(fresh.inside(root, "a/b/x.pdf"));
        std::fs::remove_file(root.join("a").join(MARKER)).unwrap();
        assert!(
            !fresh.inside(root, "a/b/x.pdf"),
            "an expired answer is looked for again"
        );
    }

    #[test]
    fn too_many_answers_are_dropped_together() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let markers = Markers::new(Duration::from_secs(3600));
        {
            let mut seen = markers.seen.write().unwrap();
            for i in 0..MAX_FOLDERS {
                seen.insert(format!("f{i}"), (Instant::now(), true));
            }
        }
        std::fs::create_dir(root.join("plain")).unwrap();
        assert!(!markers.inside(root, "plain/a.pdf"));
        assert_eq!(markers.seen.read().unwrap().len(), 1);
    }
}
