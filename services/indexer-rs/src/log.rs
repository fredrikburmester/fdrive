//! Diagnostic output: every line goes to stdout and, when `INDEXER_LOG_DIR` is set, to
//! `indexer.log` there, rotated at 10 MiB with four older files kept.

use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use file_rotate::compression::Compression;
use file_rotate::suffix::AppendCount;
use file_rotate::{ContentLimit, FileRotate};

static FILE: OnceLock<Mutex<Option<FileRotate<AppendCount>>>> = OnceLock::new();

fn open(directory: Option<&str>) -> Option<FileRotate<AppendCount>> {
    let directory = directory.filter(|d| !d.is_empty())?;
    if let Err(error) = std::fs::create_dir_all(directory) {
        println!("Persistent indexer logs unavailable: {error}");
        return None;
    }
    Some(FileRotate::new(
        Path::new(directory).join("indexer.log"),
        AppendCount::new(4),
        ContentLimit::BytesSurpassed(10 * 1024 * 1024),
        Compression::None,
        None,
    ))
}

pub fn line(message: &str) -> String {
    format!("{} {message}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z"))
}

pub fn log(message: &str) {
    let line = line(message);
    println!("{line}");
    let file = FILE.get_or_init(|| Mutex::new(open(std::env::var("INDEXER_LOG_DIR").ok().as_deref())));
    if let Ok(mut guard) = file.lock()
        && let Some(file) = guard.as_mut()
    {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_carry_an_offset_timestamp() {
        let line = line("hello");
        assert!(line.ends_with(" hello"));
        assert_eq!(&line[4..5], "-");
        assert!(line[..25].contains('T'));
    }

    #[test]
    fn rotates_into_five_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = open(dir.path().to_str()).unwrap();
        let block = "x".repeat(1024 * 1024);
        for _ in 0..60 {
            writeln!(file, "{block}").unwrap();
        }
        let count = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(count, 5);
        assert!(open(None).is_none());
        assert!(open(Some("")).is_none());
        log("smoke");
    }
}
