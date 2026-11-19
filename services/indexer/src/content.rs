//! Thumbnails and image embeddings go with the last file that has their content. Both are keyed
//! by a file's sha256 rather than by its row, so two copies share them and a move keeps them.
//! Once no `idx.files` row has a key any more (a file deleted, swept by a scan or overwritten
//! with other bytes), the key is released: its `app.thumbnails` and `app.image_embeddings` rows
//! and its WebP files go. A row inside an encrypted folder holds no key, since nothing is made
//! from its bytes. Clearing the index releases nothing.

use std::collections::BTreeSet;
use std::path::Path;

use crate::db::{self, Db};
use crate::failures::describe;
use crate::log::log;
use crate::thumbs::{SIZES, storage_path};

/// Release every key in `keys` that no row holds, once the change that let it go has
/// committed. Returns how many were released. Failures are logged: a thumbnail left behind
/// costs disk space, never a file's indexing.
pub fn release(db: &Db, thumbs_dir: &Path, keys: &[String]) -> usize {
    if keys.iter().all(String::is_empty) {
        return 0;
    }
    let released = match db.with(|c| db::release_content(c, keys)) {
        Ok(released) => released,
        Err(e) => {
            log(&format!(
                "thumbnails: cannot release {} content keys: {}",
                keys.len(),
                describe(&e)
            ));
            return 0;
        }
    };
    if released.keys.is_empty() && released.thumbnails.is_empty() {
        return 0;
    }
    // Files a failed write left without a row go too, so both sizes are tried for every key.
    let files: BTreeSet<String> = released
        .keys
        .iter()
        .flat_map(|key| SIZES.map(|size| storage_path(key, size)))
        .chain(released.thumbnails.iter().cloned())
        .collect();
    match crate::fsx::open_dir_nofollow(thumbs_dir) {
        Ok(cache) => {
            for file in &files {
                if let Err(e) = crate::fsx::remove_below(&cache, file) {
                    log(&format!("thumbnails: cannot remove {file}: {}", describe(&e)));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log(&format!(
            "thumbnails: cannot open {} to remove {} files: {e}",
            thumbs_dir.display(),
            files.len()
        )),
    }
    released.keys.len()
}
