//! `db` against a real Postgres with the repository's migrations (ported from `test_db.py`).

mod common;

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use chrono::Utc;
use fdrive_indexer::db::{self, Db, ManifestRow, NewFile};
use fdrive_indexer::events::{EventKind, build};
use postgres::Client;
use postgres::fallible_iterator::FallibleIterator;

fn setup() -> (String, Client) {
    let url = common::database();
    let client = common::connect(&url);
    (url, client)
}

fn add(c: &mut Client, root_id: i64, path: &str, ext: &str, size: i64, mtime_ns: i64, sha: &str) -> i64 {
    let name = path.rsplit('/').next().unwrap();
    db::upsert_file(
        c,
        &NewFile {
            root_id,
            path,
            name,
            ext,
            size,
            mtime_ns,
            sha256: sha,
            mime: None,
        },
    )
    .unwrap()
}

fn manifest(c: &mut Client, root_id: i64) -> HashMap<String, ManifestRow> {
    db::scan_manifest(c, root_id).unwrap()
}

fn status(c: &mut Client, root_id: i64, path: &str) -> String {
    manifest(c, root_id)[path].status.clone()
}

fn row(size: i64, mtime_ns: i64, sha: &str, embedded: bool, failed: bool) -> ManifestRow {
    ManifestRow {
        size,
        mtime_ns,
        status: "pending".to_owned(),
        deleted: false,
        sha256: Some(sha.to_owned()),
        image_embedded: embedded,
        thumbnail_failed: failed,
    }
}

#[test]
fn connect_reads_the_schema_version() {
    let (url, _) = setup();
    let mut client = db::connect(&url, 1, |_| panic!("no retry needed")).unwrap();
    assert_eq!(db::read_schema_version(&mut client).unwrap(), Some(2));
}

#[test]
fn connect_retries_then_fails() {
    let sleeps = RefCell::new(Vec::new());
    let error = db::connect("postgres://nobody@127.0.0.1:1/nope", 3, |d| sleeps.borrow_mut().push(d))
        .err()
        .unwrap();
    assert!(error.to_string().contains("could not connect to postgres"));
    // Sleeps only between attempts.
    assert_eq!(*sleeps.borrow(), vec![Duration::from_secs(2); 2]);
    assert!(db::connect("postgres://nobody@127.0.0.1:1/nope", 0, |_| panic!("no sleep")).is_err());
}

#[test]
fn a_thread_connection_is_reopened_after_postgres_drops_it() {
    let (url, mut admin) = setup();
    let db = Db { url, retries: 1 };
    let pid: i32 = db
        .with(|c| Ok(c.query_one("SELECT pg_backend_pid()", &[])?.get(0)))
        .unwrap();
    assert_eq!(
        db.with(|c| Ok(c.query_one("SELECT pg_backend_pid()", &[])?.get::<_, i32>(0)))
            .unwrap(),
        pid,
        "the connection is reused"
    );
    admin.execute("SELECT pg_terminate_backend($1)", &[&pid]).unwrap();
    // The broken connection fails at most one call, then a fresh one takes over.
    let mut fresh = None;
    for _ in 0..3 {
        if let Ok(p) = db.with(|c| Ok(c.query_one("SELECT pg_backend_pid()", &[])?.get::<_, i32>(0))) {
            fresh = Some(p);
            break;
        }
    }
    assert_ne!(fresh.unwrap(), pid);
    let unreachable = Db {
        url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
        retries: 1,
    };
    assert!(unreachable.with(|_| Ok(())).is_err());
    assert_eq!(Db::new("x").retries, 30);
}

#[test]
fn upsert_root_is_idempotent_per_name() {
    let (_, mut c) = setup();
    let a = db::upsert_root(&mut c, "files").unwrap();
    assert_eq!(db::upsert_root(&mut c, "files").unwrap(), a);
    assert_ne!(db::upsert_root(&mut c, "photos").unwrap(), a);
}

#[test]
fn schema_wait_succeeds_at_once_when_ready() {
    let (url, _) = setup();
    let logs = RefCell::new(Vec::<String>::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::from_secs(10),
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|_| panic!("no wait needed"),
    )
    .unwrap();
    assert_eq!(version, Some(2));
    assert!(logs.borrow().is_empty());
}

#[test]
fn schema_wait_gives_up_after_the_timeout() {
    let (url, mut c) = setup();
    c.batch_execute(r#"DROP TABLE "idx"."schema_version""#).unwrap();
    assert_eq!(
        db::read_schema_version(&mut c).unwrap(),
        None,
        "a missing table reads as no version"
    );
    let logs = RefCell::new(Vec::<String>::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::ZERO,
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|_| {},
    )
    .unwrap();
    assert_eq!(version, None);
    let logs = logs.borrow();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("giving up") && logs[0].contains("last seen: None"));
}

#[test]
fn schema_wait_waits_for_the_failure_history_migration() {
    let (url, mut c) = setup();
    c.batch_execute(r#"ALTER TABLE "idx"."processing_failures" RENAME TO migration_pending"#)
        .unwrap();
    let client = RefCell::new(c);
    let logs = RefCell::new(Vec::<String>::new());
    let sleeps = RefCell::new(Vec::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::from_secs(60),
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|d| {
            sleeps.borrow_mut().push(d);
            client
                .borrow_mut()
                .batch_execute(r#"ALTER TABLE "idx"."migration_pending" RENAME TO processing_failures"#)
                .unwrap();
        },
    )
    .unwrap();
    assert_eq!(version, Some(2));
    assert_eq!(*sleeps.borrow(), vec![Duration::from_secs(5)]);
    let logs = logs.borrow();
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("processing_failures, work and folders migrations") && logs[0].contains("last seen: 2"));
}

#[test]
fn schema_wait_waits_for_the_work_queue_migration() {
    let (url, mut c) = setup();
    c.batch_execute(r#"ALTER TABLE "idx"."work" RENAME TO work_pending"#)
        .unwrap();
    let client = RefCell::new(c);
    let logs = RefCell::new(Vec::<String>::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::from_secs(60),
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|_| {
            client
                .borrow_mut()
                .batch_execute(r#"ALTER TABLE "idx"."work_pending" RENAME TO work"#)
                .unwrap();
        },
    )
    .unwrap();
    assert_eq!(version, Some(2));
    assert_eq!(logs.borrow().len(), 1);
}

#[test]
fn schema_wait_waits_for_the_folders_migration() {
    let (url, mut c) = setup();
    c.batch_execute(r#"ALTER TABLE "idx"."folders" RENAME TO folders_pending"#)
        .unwrap();
    let client = RefCell::new(c);
    let logs = RefCell::new(Vec::<String>::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::from_secs(60),
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|_| {
            client
                .borrow_mut()
                .batch_execute(r#"ALTER TABLE "idx"."folders_pending" RENAME TO folders"#)
                .unwrap();
        },
    )
    .unwrap();
    assert_eq!(version, Some(2));
    assert_eq!(logs.borrow().len(), 1);
}

/// The root's folder rows, sorted by path byte by byte.
fn folder_rows(c: &mut Client, root_id: i64) -> Vec<(String, String, i64)> {
    let mut rows: Vec<(String, String, i64)> = c
        .query(
            r#"SELECT path, name, mtime_ns FROM "idx"."folders" WHERE root_id = $1::bigint"#,
            &[&root_id],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    rows.sort();
    rows
}

fn folders(paths: &[&str]) -> Vec<db::FolderRow> {
    paths
        .iter()
        .map(|p| db::FolderRow {
            path: (*p).to_owned(),
            mtime_ns: 7,
        })
        .collect()
}

#[test]
fn folder_rows_are_written_updated_and_swept_under_a_folder() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "r").unwrap();
    // A path found twice is written once.
    db::sync_folders(&mut c, root, &folders(&["a", "a/b", "a/b/c", "ab", "z", "a"]), None).unwrap();
    assert_eq!(folder_rows(&mut c, root).len(), 5);
    let started = db::now(&mut c).unwrap();
    // A walk of `a` that found only `a/b` with a new time drops `a/b/c`, never `a` itself or
    // `ab`, which only shares its first letter.
    let found = [db::FolderRow {
        path: "a/b".to_owned(),
        mtime_ns: 9,
    }];
    assert_eq!(db::sync_folders(&mut c, root, &found, Some(("a", started))).unwrap(), 1);
    assert_eq!(
        folder_rows(&mut c, root),
        [
            ("a".to_owned(), "a".to_owned(), 7),
            ("a/b".to_owned(), "b".to_owned(), 9),
            ("ab".to_owned(), "ab".to_owned(), 7),
            ("z".to_owned(), "z".to_owned(), 7)
        ]
    );
    // A walk of the whole root drops whatever it did not write.
    let started = db::now(&mut c).unwrap();
    assert_eq!(
        db::sync_folders(&mut c, root, &folders(&["a"]), Some(("", started))).unwrap(),
        3
    );
    assert_eq!(folder_rows(&mut c, root), [("a".to_owned(), "a".to_owned(), 7)]);
    // Another root's rows are never touched.
    let other = db::upsert_root(&mut c, "other").unwrap();
    db::sync_folders(&mut c, other, &folders(&["a"]), None).unwrap();
    let started = db::now(&mut c).unwrap();
    db::sync_folders(&mut c, root, &[], Some(("", started))).unwrap();
    assert!(folder_rows(&mut c, root).is_empty());
    assert_eq!(folder_rows(&mut c, other).len(), 1);
}

#[test]
fn folder_rows_follow_deletes_and_renames() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "r").unwrap();
    db::sync_folders(&mut c, root, &folders(&["a", "a/b", "a/b/c", "ab", "x", "x/b"]), None).unwrap();
    // A file's delete drops a folder row only at that exact path.
    db::mark_deleted(&mut c, root, "a/b", false).unwrap();
    let paths = |c: &mut Client| folder_rows(c, root).into_iter().map(|r| r.0).collect::<Vec<_>>();
    assert_eq!(paths(&mut c), ["a", "a/b/c", "ab", "x", "x/b"]);
    db::sync_folders(&mut c, root, &folders(&["a/b"]), None).unwrap();
    // A folder moved over `x` replaces the rows already there and keeps its own names.
    db::rename_paths(&mut c, root, "a", "x", true).unwrap();
    assert_eq!(
        folder_rows(&mut c, root)
            .into_iter()
            .map(|(p, n, _)| (p, n))
            .collect::<Vec<_>>(),
        [
            ("ab".to_owned(), "ab".to_owned()),
            ("x".to_owned(), "x".to_owned()),
            ("x/b".to_owned(), "b".to_owned()),
            ("x/b/c".to_owned(), "c".to_owned())
        ]
    );
    // A file's rename leaves folder rows alone.
    db::rename_paths(&mut c, root, "ab", "ac", false).unwrap();
    assert_eq!(paths(&mut c), ["ab", "x", "x/b", "x/b/c"]);
    // A folder's delete drops it and everything below it.
    db::mark_deleted(&mut c, root, "x", true).unwrap();
    assert_eq!(paths(&mut c), ["ab"]);
}

#[test]
fn schema_wait_waits_until_the_api_has_migrated() {
    let (url, mut c) = setup();
    c.batch_execute(r#"DELETE FROM "idx"."schema_version" WHERE version = 2"#)
        .unwrap();
    let client = RefCell::new(c);
    let logs = RefCell::new(Vec::<String>::new());
    let version = db::wait_for_schema_version(
        &Db::new(&url),
        2,
        Duration::from_secs(60),
        &|m| logs.borrow_mut().push(m.to_owned()),
        &|_| {
            client
                .borrow_mut()
                .batch_execute(r#"INSERT INTO "idx"."schema_version" (version) VALUES (2)"#)
                .unwrap();
        },
    )
    .unwrap();
    assert_eq!(version, Some(2));
    assert!(logs.borrow()[0].contains("last seen: 1"));
}

#[test]
fn schema_wait_reports_a_missing_database() {
    let db = Db {
        url: "postgres://nobody@127.0.0.1:1/nope".to_owned(),
        retries: 1,
    };
    assert!(db::wait_for_schema_version(&db, 1, Duration::ZERO, &|_| {}, &|_| {}).is_err());
}

#[test]
fn scan_manifest_shares_embeddings_by_content_key() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let other = db::upsert_root(&mut c, "photos").unwrap();
    add(&mut c, root, "embedded.jpg", ".jpg", 10, 1, "sha-embedded");
    add(&mut c, root, "copy.jpg", ".jpg", 10, 2, "sha-embedded");
    add(&mut c, root, "plain.jpg", ".jpg", 20, 3, "sha-plain");
    add(&mut c, other, "elsewhere.jpg", ".jpg", 30, 4, "sha-other");
    db::upsert_image_embedding(&mut c, "sha-embedded", "model-a", &[0.1; 1024]).unwrap();
    let expected: HashMap<String, ManifestRow> = [
        ("embedded.jpg", row(10, 1, "sha-embedded", true, false)),
        ("copy.jpg", row(10, 2, "sha-embedded", true, false)),
        ("plain.jpg", row(20, 3, "sha-plain", false, false)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(manifest(&mut c, root), expected);
}

#[test]
fn scan_manifest_flags_only_unresolved_thumbnail_failures_of_its_root() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let other = db::upsert_root(&mut c, "photos").unwrap();
    for path in ["failed.jpg", "resolved.jpg", "embedding.jpg", "elsewhere.jpg"] {
        add(&mut c, root, path, ".jpg", 1, 1, &format!("sha-{path}"));
    }
    c.batch_execute(&format!(
        "INSERT INTO idx.processing_failures (root_id, path, feature, code, message, operation_id, resolved_at) VALUES \
         ({root}, 'failed.jpg', 'thumbnails', 'E', 'm', 'op', NULL), \
         ({root}, 'resolved.jpg', 'thumbnails', 'E', 'm', 'op', now()), \
         ({root}, 'embedding.jpg', 'imageSearch', 'E', 'm', 'op', NULL), \
         ({other}, 'elsewhere.jpg', 'thumbnails', 'E', 'm', 'op', NULL)"
    ))
    .unwrap();
    let flags: HashMap<String, bool> = manifest(&mut c, root)
        .into_iter()
        .map(|(path, row)| (path, row.thumbnail_failed))
        .collect();
    let expected: HashMap<String, bool> = [
        ("failed.jpg", true),
        ("resolved.jpg", false),
        ("embedding.jpg", false),
        ("elsewhere.jpg", false),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(flags, expected);
}

#[test]
fn text_less_pdfs_move_to_ocr_only_when_live() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let other = db::upsert_root(&mut c, "photos").unwrap();
    for (r, path, ext, status) in [
        (root, "scan.pdf", ".pdf", "no_text"),
        (root, "photo.jpg", ".jpg", "no_text"),
        (root, "text.pdf", ".pdf", "indexed"),
        (root, "gone.pdf", ".pdf", "no_text"),
        (other, "other.pdf", ".pdf", "no_text"),
    ] {
        let id = add(&mut c, r, path, ext, 1, 1, "sha");
        db::update_file_status(&mut c, id, status, 0, None).unwrap();
    }
    db::mark_deleted(&mut c, root, "gone.pdf", false).unwrap();
    assert_eq!(db::mark_pdfs_skipped_by_ocr(&mut c, root).unwrap(), 1);
    let statuses: HashMap<String, String> = manifest(&mut c, root)
        .into_iter()
        .map(|(path, row)| (path, row.status))
        .collect();
    assert_eq!(statuses["scan.pdf"], "disabled:search_ocr");
    assert_eq!(statuses["photo.jpg"], "no_text");
    assert_eq!(statuses["text.pdf"], "indexed");
    assert_eq!(statuses["gone.pdf"], "no_text");
    assert_eq!(status(&mut c, other, "other.pdf"), "no_text");
    assert_eq!(db::mark_pdfs_skipped_by_ocr(&mut c, root).unwrap(), 0);
}

#[test]
fn upsert_resets_to_pending_and_drops_chunks() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let id = add(&mut c, root, "a.txt", ".txt", 10, 1, "sha1");
    db::insert_chunks(&mut c, id, &["hello".to_owned()], &[None]).unwrap();
    db::update_file_status(&mut c, id, "indexed", 5, Some("old")).unwrap();
    db::mark_deleted(&mut c, root, "a.txt", false).unwrap();
    assert_eq!(add(&mut c, root, "a.txt", ".txt", 20, 2, "sha2"), id);
    let row = db::file_row(&mut c, root, "a.txt").unwrap().unwrap();
    assert_eq!(
        (
            row.size,
            row.mtime_ns,
            row.status.as_str(),
            row.deleted,
            row.sha256.as_deref(),
            row.error
        ),
        (20, 2, "pending", false, Some("sha2"), None)
    );
    assert_eq!(db::count(&mut c, "idx.chunks").unwrap(), 0);
    assert!(db::file_row(&mut c, root, "missing.txt").unwrap().is_none());
}

#[test]
fn chunks_and_embeddings() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let id = add(&mut c, root, "a.txt", ".txt", 10, 1, "sha1");
    db::insert_chunks(&mut c, id, &[], &[]).unwrap();
    db::insert_chunks(
        &mut c,
        id,
        &["hello".to_owned(), "world".to_owned()],
        &[None, Some(vec![0.2; 384])],
    )
    .unwrap();
    let missing = db::chunks_missing_embeddings(&mut c, root, "a.txt").unwrap();
    assert_eq!(
        missing.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>(),
        vec!["hello"]
    );
    db::set_chunk_embeddings(&mut c, &[]).unwrap();
    let pairs: Vec<(i64, Vec<f32>)> = missing.iter().map(|(id, _)| (*id, vec![0.1; 384])).collect();
    db::set_chunk_embeddings(&mut c, &pairs).unwrap();
    assert!(db::chunks_missing_embeddings(&mut c, root, "a.txt").unwrap().is_empty());
}

#[test]
fn indexed_and_error_marks() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let id = add(&mut c, root, "a.txt", ".txt", 10, 1, "sha1");
    db::update_file_status(&mut c, id, "partial", 5, Some("embed:X")).unwrap();
    db::mark_file_indexed(&mut c, root, "a.txt").unwrap();
    let row = db::file_row(&mut c, root, "a.txt").unwrap().unwrap();
    assert_eq!((row.status.as_str(), row.error), ("indexed", None));
    db::mark_file_error(&mut c, root, "a.txt", "boom").unwrap();
    let row = db::file_row(&mut c, root, "a.txt").unwrap().unwrap();
    assert_eq!((row.status.as_str(), row.error.as_deref()), ("error", Some("boom")));
}

#[test]
fn mark_deleted_files_and_subtrees() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    assert!(db::mark_deleted(&mut c, root, "never.txt", false).unwrap().is_empty());
    let a = add(&mut c, root, "dir/a.txt", ".txt", 1, 1, "s1");
    add(&mut c, root, "dir/b.txt", ".txt", 1, 1, "s2");
    add(&mut c, root, "dir.txt", ".txt", 1, 1, "s3");
    add(&mut c, root, "dirx/c.txt", ".txt", 1, 1, "s4");
    db::insert_chunks(&mut c, a, &["x".to_owned()], &[None]).unwrap();
    // A file delete never touches the subtree of a same-named directory.
    assert!(db::mark_deleted(&mut c, root, "dir", false).unwrap().is_empty());
    assert_eq!(db::mark_deleted(&mut c, root, "dir", true).unwrap().len(), 2);
    let m = manifest(&mut c, root);
    assert!(m["dir/a.txt"].deleted && m["dir/b.txt"].deleted);
    assert!(!m["dir.txt"].deleted && !m["dirx/c.txt"].deleted);
    assert_eq!(db::count(&mut c, "idx.chunks").unwrap(), 0);
    // Already deleted rows are not deleted again.
    assert!(db::mark_deleted(&mut c, root, "dir", true).unwrap().is_empty());
    assert_eq!(db::mark_deleted(&mut c, root, "dir.txt", false).unwrap().len(), 1);
}

#[test]
fn rename_a_file_over_a_stale_destination() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    add(&mut c, root, "old.txt", ".txt", 1, 1, "sha1");
    add(&mut c, root, "new.txt", ".txt", 1, 1, "sha2");
    db::mark_deleted(&mut c, root, "new.txt", false).unwrap();
    assert_eq!(db::rename_paths(&mut c, root, "old.txt", "new.txt", false).unwrap(), 1);
    let m = manifest(&mut c, root);
    assert_eq!(m.keys().collect::<Vec<_>>(), vec!["new.txt"]);
    assert_eq!(m["new.txt"].sha256.as_deref(), Some("sha1"));
    assert!(!m["new.txt"].deleted);
    let name: String = c
        .query_one(r#"SELECT name FROM "idx"."files" WHERE path = 'new.txt'"#, &[])
        .unwrap()
        .get(0);
    assert_eq!(name, "new.txt");
    // Nothing to move: the destination stays as it is.
    assert_eq!(
        db::rename_paths(&mut c, root, "missing.txt", "new.txt", false).unwrap(),
        0
    );
    assert!(manifest(&mut c, root).contains_key("new.txt"));
}

#[test]
fn rename_a_directory_rekeys_its_subtree() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    add(&mut c, root, "dir/a.txt", ".txt", 1, 1, "s1");
    add(&mut c, root, "dir/sub/b.txt", ".txt", 1, 1, "s2");
    add(&mut c, root, "dirx/c.txt", ".txt", 1, 1, "s3");
    // A stale row where a moved file lands is replaced.
    add(&mut c, root, "moved/a.txt", ".txt", 1, 1, "stale");
    add(&mut c, root, "dir/gone.txt", ".txt", 1, 1, "s4");
    db::mark_deleted(&mut c, root, "dir/gone.txt", false).unwrap();
    assert_eq!(db::rename_paths(&mut c, root, "dir", "moved", true).unwrap(), 2);
    let m = manifest(&mut c, root);
    let mut paths: Vec<&String> = m.keys().collect();
    paths.sort();
    assert_eq!(
        paths,
        vec!["dir/gone.txt", "dirx/c.txt", "moved/a.txt", "moved/sub/b.txt"]
    );
    assert_eq!(m["moved/a.txt"].sha256.as_deref(), Some("s1"));
}

#[test]
fn moves_are_recorded() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    db::insert_move(&mut c, root, "old.txt", "new.txt", "watcher").unwrap();
    let rows: Vec<(String, String, String)> = c
        .query(r#"SELECT src, dst, actor FROM "idx"."moves""#, &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(rows, vec![("old.txt".into(), "new.txt".into(), "watcher".into())]);
}

#[test]
fn events_are_stored_and_notified_with_the_same_payload() {
    let (url, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let mut listener = common::connect(&url);
    listener.batch_execute("LISTEN idx_events").unwrap();
    let event = build(EventKind::Moved, "files", "a.txt", Some("b.txt"));
    db::record_event(&mut c, root, &event).unwrap();
    db::record_event(&mut c, root, &build(EventKind::Created, "files", "c.txt", None)).unwrap();
    let rows: Vec<(String, String, Option<String>)> = c
        .query(r#"SELECT kind, path, target_path FROM "idx"."events" ORDER BY id"#, &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(
        rows,
        vec![
            ("moved".into(), "a.txt".into(), Some("b.txt".into())),
            ("created".into(), "c.txt".into(), None)
        ]
    );
    let mut notifications = listener.notifications();
    let mut iter = notifications.timeout_iter(Duration::from_secs(5));
    let first = iter.next().unwrap().unwrap();
    assert_eq!(first.channel(), "idx_events");
    let payload: serde_json::Value = serde_json::from_str(first.payload()).unwrap();
    assert_eq!(payload["kind"], "moved");
    assert_eq!(payload["root"], "files");
    assert_eq!(payload["path"], "a.txt");
    assert_eq!(payload["target_path"], "b.txt");
    assert_eq!(payload["at"], event.at);
    let second: serde_json::Value = serde_json::from_str(iter.next().unwrap().unwrap().payload()).unwrap();
    assert_eq!(
        (second["kind"].as_str(), second["target_path"].is_null()),
        (Some("created"), true)
    );
}

#[test]
fn prune_events_drops_only_old_rows() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let old = Utc::now() - chrono::Duration::days(30);
    c.execute(
        &format!(r#"INSERT INTO "idx"."events" (at, root_id, kind, path) VALUES ($1, {root}, 'created', 'old.txt')"#),
        &[&old],
    )
    .unwrap();
    db::record_event(&mut c, root, &build(EventKind::Created, "files", "new.txt", None)).unwrap();
    assert_eq!(db::prune_events(&mut c, 7).unwrap(), 1);
    let paths: Vec<String> = c
        .query(r#"SELECT path FROM "idx"."events""#, &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(paths, vec!["new.txt"]);
}

#[test]
fn scan_lifecycle_and_stats() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let empty = db::root_stats(&mut c, "files", root).unwrap();
    assert_eq!(
        empty,
        serde_json::json!({"root": "files", "counts_by_status": {}, "chunks": 0, "chunks_embedded": 0, "last_scan": null})
    );
    let f1 = add(&mut c, root, "a.txt", ".txt", 1, 1, "sha1");
    db::update_file_status(&mut c, f1, "indexed", 10, None).unwrap();
    db::insert_chunks(&mut c, f1, &["hello".into(), "x".into()], &[Some(vec![0.1; 384]), None]).unwrap();
    let f2 = add(&mut c, root, "b.txt", ".txt", 1, 1, "sha2");
    db::update_file_status(&mut c, f2, "error", 0, Some("boom")).unwrap();
    let f3 = add(&mut c, root, "c.txt", ".txt", 1, 1, "sha3");
    db::update_file_status(&mut c, f3, "error", 0, Some("deleted")).unwrap();
    db::mark_deleted(&mut c, root, "c.txt", false).unwrap();
    add(&mut c, root, "d.txt", ".txt", 1, 1, "sha4");
    let (scan_id, started_at) = db::start_scan(&mut c, root).unwrap();
    assert!(scan_id > 0 && started_at <= Utc::now());
    let unfinished = db::root_stats(&mut c, "files", root).unwrap();
    assert!(unfinished["last_scan"]["finished_at"].is_null());
    db::finish_scan(&mut c, scan_id, 5, 2, 1, 0).unwrap();
    let stats = db::root_stats(&mut c, "files", root).unwrap();
    assert_eq!(
        stats["counts_by_status"],
        serde_json::json!({"indexed": 1, "error": 1, "pending": 1})
    );
    assert_eq!(
        (stats["chunks"].as_i64(), stats["chunks_embedded"].as_i64()),
        (Some(2), Some(1))
    );
    let scan = &stats["last_scan"];
    assert_eq!(
        (
            scan["files_seen"].as_i64(),
            scan["files_changed"].as_i64(),
            scan["files_deleted"].as_i64(),
            scan["errors"].as_i64()
        ),
        (Some(5), Some(2), Some(1), Some(0))
    );
    assert!(scan["started_at"].as_str().unwrap().ends_with("+00:00"));
    assert!(scan["finished_at"].as_str().is_some());
    assert_eq!(db::pending_count(&mut c, root).unwrap(), 1);
    assert_eq!(
        db::errors_sample(&mut c, root, 20).unwrap(),
        vec![serde_json::json!({"path": "b.txt", "error": "boom"})]
    );
    assert!(db::errors_sample(&mut c, root, 0).unwrap().is_empty());
}

#[test]
fn sweep_spares_rows_written_after_the_scan_started() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    add(&mut c, root, "kept.txt", ".txt", 1, 1, "s1");
    let gone = add(&mut c, root, "vanished.txt", ".txt", 1, 1, "s2");
    db::insert_chunks(&mut c, gone, &["gone text".into()], &[None]).unwrap();
    add(&mut c, root, "old.txt", ".txt", 1, 1, "s3");
    // Postgres' now() is the transaction start; make sure the next write is later.
    std::thread::sleep(Duration::from_millis(5));
    let (_, started_at) = db::start_scan(&mut c, root).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    // The watcher recreated it after the walk passed its directory.
    add(&mut c, root, "recreated.txt", ".txt", 1, 1, "s4");
    let vanished: Vec<String> = ["vanished.txt", "old.txt", "recreated.txt", "never-indexed.txt"]
        .map(str::to_owned)
        .to_vec();
    assert_eq!(db::sweep_vanished(&mut c, root, &vanished, started_at).unwrap(), 2);
    let m = manifest(&mut c, root);
    assert!(m["vanished.txt"].deleted && m["old.txt"].deleted);
    assert!(!m["kept.txt"].deleted && !m["recreated.txt"].deleted);
    assert_eq!(db::count(&mut c, "idx.chunks").unwrap(), 0);
    assert_eq!(db::sweep_vanished(&mut c, root, &vanished, started_at).unwrap(), 0);
    assert_eq!(db::sweep_vanished(&mut c, root, &[], started_at).unwrap(), 0);
}

#[test]
fn sweep_counts_each_row_once_across_batches() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    let total = db::SWEEP_BATCH + 2;
    c.execute(
        &format!(
            r#"INSERT INTO "idx"."files" (root_id, path, name, ext, size, mtime_ns, sha256, last_seen)
               SELECT {root}, 'f' || n || '.txt', 'f' || n || '.txt', '.txt', 1, 1, 'sha', now() - interval '1 hour'
               FROM generate_series(1, $1::int) n"#
        ),
        &[&(total as i32)],
    )
    .unwrap();
    db::mark_deleted(&mut c, root, "f1.txt", false).unwrap();
    let (_, started_at) = db::start_scan(&mut c, root).unwrap();
    let mut paths: Vec<String> = (1..=total).map(|n| format!("f{n}.txt")).collect();
    // Duplicates and unknown paths count nothing.
    paths.push("f2.txt".into());
    paths.push("unknown.txt".into());
    assert_eq!(
        db::sweep_vanished(&mut c, root, &paths, started_at).unwrap(),
        (total - 1) as i64
    );
}

#[test]
fn settings_are_read_as_json() {
    let (_, mut c) = setup();
    c.execute(
        r#"INSERT INTO "app"."settings" (key, value) VALUES ('indexer.workers', $1)"#,
        &[&serde_json::json!(8)],
    )
    .unwrap();
    assert_eq!(
        db::read_settings(&mut c).unwrap()["indexer.workers"],
        serde_json::json!(8)
    );
}

#[test]
fn thumbnails_upsert_by_key_and_size() {
    let (_, mut c) = setup();
    db::upsert_thumbnail(&mut c, "sha1", 256, "sh/sha1.256.webp", 256, 128).unwrap();
    db::upsert_thumbnail(&mut c, "sha1", 1024, "sh/sha1.1024.webp", 1024, 512).unwrap();
    assert_eq!(db::count(&mut c, "app.thumbnails").unwrap(), 2);
    db::upsert_thumbnail(&mut c, "sha1", 256, "sh/other.webp", 300, 150).unwrap();
    assert_eq!(db::count(&mut c, "app.thumbnails").unwrap(), 2);
    let row = c
        .query_one(
            r#"SELECT storage_path, width, height FROM "app"."thumbnails" WHERE content_key = 'sha1' AND size = 256"#,
            &[],
        )
        .unwrap();
    assert_eq!(
        (row.get::<_, String>(0), row.get::<_, i32>(1), row.get::<_, i32>(2)),
        ("sh/other.webp".to_owned(), 300, 150)
    );
}

#[test]
fn media_files_skip_deleted_and_unhashed_rows() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    assert!(db::media_files(&mut c, root).unwrap().is_empty());
    add(&mut c, root, "a.png", ".png", 100, 1, "sha1");
    add(&mut c, root, "b.pdf", ".pdf", 200, 1, "sha2");
    add(&mut c, root, "import.png", ".png", 100, 1, "x");
    db::mark_deleted(&mut c, root, "b.pdf", false).unwrap();
    c.batch_execute(r#"UPDATE "idx"."files" SET sha256 = NULL WHERE path = 'import.png'"#)
        .unwrap();
    assert_eq!(
        db::media_files(&mut c, root).unwrap(),
        vec![("a.png".to_owned(), ".png".to_owned(), "sha1".to_owned(), 100)]
    );
    assert_eq!(db::file_content_key(&mut c, root, "import.png").unwrap(), None);
    assert_eq!(db::file_content_key(&mut c, root, "b.pdf").unwrap(), None);
    assert_eq!(
        db::file_content_key(&mut c, root, "a.png").unwrap().as_deref(),
        Some("sha1")
    );
}

#[test]
fn image_embeddings_upsert_replaces_model() {
    let (_, mut c) = setup();
    assert_eq!(db::image_embedding_model(&mut c, "sha-a").unwrap(), None);
    db::upsert_image_embedding(&mut c, "sha-a", "model-a", &[0.1; 1024]).unwrap();
    assert_eq!(
        db::image_embedding_model(&mut c, "sha-a").unwrap().as_deref(),
        Some("model-a")
    );
    db::upsert_image_embedding(&mut c, "sha-a", "model-b", &[0.2; 1024]).unwrap();
    assert_eq!(
        db::image_embedding_model(&mut c, "sha-a").unwrap().as_deref(),
        Some("model-b")
    );
    assert_eq!(db::count(&mut c, "app.image_embeddings").unwrap(), 1);
}

#[test]
fn mark_pending_whole_root_and_subtree() {
    let (_, mut c) = setup();
    let root = db::upsert_root(&mut c, "files").unwrap();
    for path in ["dir/a.txt", "dir", "other.txt", "gone.txt"] {
        let id = add(&mut c, root, path, ".txt", 1, 1, "sha");
        db::update_file_status(&mut c, id, "indexed", 1, None).unwrap();
    }
    db::mark_deleted(&mut c, root, "gone.txt", false).unwrap();
    assert_eq!(db::mark_pending(&mut c, root, Some(("dir", "dir/"))).unwrap(), 2);
    assert_eq!(status(&mut c, root, "other.txt"), "indexed");
    assert_eq!(status(&mut c, root, "dir/a.txt"), "pending");
    assert_eq!(db::mark_pending(&mut c, root, None).unwrap(), 3);
    assert_eq!(status(&mut c, root, "gone.txt"), "indexed");
}

#[test]
fn mark_pending_treats_the_prefix_literally() {
    for (exact, selected, sibling) in [
        ("percent%", "percent%/child.txt", "percent-any/child.txt"),
        ("under_", "under_/child.txt", "underx/child.txt"),
        ("slash\\", "slash\\/child.txt", "slash/child.txt"),
    ] {
        let (_, mut c) = setup();
        let root = db::upsert_root(&mut c, "files").unwrap();
        let other = db::upsert_root(&mut c, "photos").unwrap();
        for (r, path) in [(root, selected), (root, sibling), (other, selected)] {
            let id = add(&mut c, r, path, ".txt", 1, 1, "sha");
            db::update_file_status(&mut c, id, "indexed", 1, None).unwrap();
        }
        let prefix = format!("{exact}/");
        assert_eq!(
            db::mark_pending(&mut c, root, Some((exact, &prefix))).unwrap(),
            1,
            "{exact}"
        );
        assert_eq!(status(&mut c, root, selected), "pending");
        assert_eq!(status(&mut c, root, sibling), "indexed");
        assert_eq!(status(&mut c, other, selected), "indexed");
    }
}

#[test]
fn a_thread_that_used_its_connection_exits_cleanly() {
    let (url, _) = setup();
    let db = Db::new(&url);
    // The pooled client's runtime must drop before tokio's own thread-local is gone.
    let one = std::thread::spawn(move || db.with(|c| Ok(c.query_one("SELECT 1", &[])?.get::<_, i32>(0))).unwrap())
        .join()
        .unwrap();
    assert_eq!(one, 1);
}

#[test]
fn every_query_reports_a_missing_schema_as_an_error() {
    let (_, mut c) = setup();
    c.batch_execute("DROP SCHEMA idx CASCADE; DROP SCHEMA app CASCADE")
        .unwrap();
    let file = NewFile {
        root_id: 1,
        path: "a.txt",
        name: "a.txt",
        ext: ".txt",
        size: 1,
        mtime_ns: 1,
        sha256: "sha",
        mime: None,
    };
    let event = build(EventKind::Created, "r", "a.txt", None);
    let c = &mut c;
    assert!(db::upsert_root(c, "r").is_err());
    assert!(db::scan_manifest(c, 1).is_err());
    assert!(db::pending_count(c, 1).is_err());
    assert!(db::file_row(c, 1, "a").is_err());
    assert!(db::mark_pdfs_skipped_by_ocr(c, 1).is_err());
    assert!(db::upsert_file(c, &file).is_err());
    assert!(db::insert_chunks(c, 1, &["x".into()], &[None]).is_err());
    assert!(db::update_file_status(c, 1, "indexed", 0, None).is_err());
    assert!(db::chunks_missing_embeddings(c, 1, "a").is_err());
    assert!(db::set_chunk_embeddings(c, &[(1, vec![0.1; 384])]).is_err());
    assert!(db::mark_file_indexed(c, 1, "a").is_err());
    assert!(db::mark_file_error(c, 1, "a", "e").is_err());
    assert!(db::mark_deleted(c, 1, "a", false).is_err());
    assert!(db::rename_paths(c, 1, "a", "b", false).is_err());
    assert!(db::rename_paths(c, 1, "a", "b", true).is_err());
    assert!(db::insert_move(c, 1, "a", "b", "watcher").is_err());
    assert!(db::record_event(c, 1, &event).is_err());
    assert!(db::prune_events(c, 7).is_err());
    assert!(db::start_scan(c, 1).is_err());
    assert!(db::finish_scan(c, 1, 0, 0, 0, 0).is_err());
    assert!(db::sweep_vanished(c, 1, &["a".into()], Utc::now()).is_err());
    assert!(db::read_settings(c).is_err());
    assert!(db::upsert_thumbnail(c, "k", 256, "p", 1, 1).is_err());
    assert!(db::count(c, "idx.files").is_err());
    assert!(db::image_embedding_model(c, "k").is_err());
    assert!(db::file_content_key(c, 1, "a").is_err());
    assert!(db::upsert_image_embedding(c, "k", "m", &[0.1; 1024]).is_err());
    assert!(db::media_files(c, 1).is_err());
    assert!(db::root_stats(c, "r", 1).is_err());
    assert!(db::errors_sample(c, 1, 20).is_err());
    assert!(db::mark_pending(c, 1, None).is_err());
    assert!(db::mark_pending(c, 1, Some(("a", "a/"))).is_err());
    assert_eq!(db::read_schema_version(c).unwrap(), None);
}
