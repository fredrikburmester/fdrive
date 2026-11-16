//! The `.fdrive-files` marker the API writes at the top of the files folder, naming the
//! installation the folder belongs to. A root without it, or with another installation's, is
//! a wrong mount (such as Compose's empty default when `FDRIVE_FILES_DIR` is unset): the
//! indexer neither scans, watches nor applies journaled changes there, so it never reads an
//! empty folder as every file deleted. The API decides when a folder may be adopted; the
//! indexer only reads the marker.

use std::path::Path;

/// The marker's file name, at the top of the root. Never indexed.
pub const FILES_MARKER: &str = ".fdrive-files";

pub const NO_INSTALLATION: &str = "the installation id is not recorded yet; the API records it when it starts";
pub const MISSING: &str =
    "the folder has no .fdrive-files marker; the API writes it once it accepts the folder (check FDRIVE_FILES_DIR)";
pub const UNADOPTED: &str = "the .fdrive-files marker is empty; the API fills it in once it accepts the folder";
pub const FOREIGN: &str = "the .fdrive-files marker names another fdrive installation (check FDRIVE_FILES_DIR)";
pub const UNREADABLE: &str = "the folder or its .fdrive-files marker cannot be read (check FDRIVE_FILES_DIR)";

/// Whether `root` holds this installation's marker: `Err` carries why not.
pub fn check(root: &Path, installation_id: Option<&str>) -> Result<(), &'static str> {
    let Some(id) = installation_id else {
        return Err(NO_INSTALLATION);
    };
    match std::fs::read_to_string(root.join(FILES_MARKER)) {
        Ok(text) => match text.trim() {
            "" => Err(UNADOPTED),
            found if found.eq_ignore_ascii_case(id) => Ok(()),
            _ => Err(FOREIGN),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(MISSING),
        Err(_) => Err(UNREADABLE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "6f1c7a52-3d3e-4b8e-9a51-0c2f4f3f9d10";

    #[test]
    fn only_this_installations_marker_passes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(check(root, Some(ID)), Err(MISSING));
        std::fs::write(root.join(FILES_MARKER), "\n").unwrap();
        assert_eq!(check(root, Some(ID)), Err(UNADOPTED));
        std::fs::write(root.join(FILES_MARKER), "0b8f4f0e-6a4c-4f6e-8d33-7f1e2a9c4b21\n").unwrap();
        assert_eq!(check(root, Some(ID)), Err(FOREIGN));
        std::fs::write(root.join(FILES_MARKER), format!(" {}\n", ID.to_uppercase())).unwrap();
        assert_eq!(check(root, Some(ID)), Ok(()));
        assert_eq!(check(root, None), Err(NO_INSTALLATION));
    }

    #[test]
    fn an_unreadable_marker_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(FILES_MARKER)).unwrap();
        assert_eq!(check(dir.path(), Some(ID)), Err(UNREADABLE));
    }
}
