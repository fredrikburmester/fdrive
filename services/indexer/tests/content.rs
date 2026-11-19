//! Thumbnails and image embeddings go with the last file that has their content, against a
//! real filesystem, Postgres and a fake `ml` server.

mod common;

use common::root_env::{Env, fv, jpeg};
use fdrive_indexer::content::release;
use fdrive_indexer::db::Db;
use fdrive_indexer::encrypted::MARKER;
use fdrive_indexer::indexer::{process_file, scan_once, watch_delete, watch_rename};
use fdrive_indexer::thumbs::storage_path;

fn hex_sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Thumbnails and image search on.
fn media() -> fdrive_indexer::features::FeatureValues {
    fv(true, false, false, false, true)
}

/// Whether anything is left of `sha`: thumbnail files, thumbnail rows or an image embedding.
fn kept(env: &Env, sha: &str) -> (bool, i64, i64) {
    let count = |table: &str| -> i64 {
        env.client()
            .query_one(&format!("SELECT count(*) FROM {table} WHERE content_key = $1"), &[&sha])
            .unwrap()
            .get(0)
    };
    (
        env.thumb_path(sha, 256).exists() || env.thumb_path(sha, 1024).exists(),
        count("app.thumbnails"),
        count("app.image_embeddings"),
    )
}

const ALL: (bool, i64, i64) = (true, 2, 1);
const NONE: (bool, i64, i64) = (false, 0, 0);

#[test]
fn deleting_the_last_copy_releases_its_thumbnails_and_embedding() {
    let env = Env::new();
    let ctx = env.ctx(media());
    let picture = jpeg(80, 40, 7);
    env.write("a.jpg", &picture);
    env.write("copy.jpg", &picture);
    scan_once(&ctx);
    let sha = hex_sha(&picture);
    assert_eq!(kept(&env, &sha), ALL);
    // One copy goes: the other still has them.
    std::fs::remove_file(env.path("a.jpg")).unwrap();
    assert_eq!(watch_delete(&ctx, "a.jpg", false), 1);
    assert_eq!(kept(&env, &sha), ALL);
    // A move nothing saw: the scan indexes the new path before it sweeps the old one.
    env.write("dir/copy.jpg", &picture);
    std::fs::remove_file(env.path("copy.jpg")).unwrap();
    assert_eq!(scan_once(&ctx).deleted, 1);
    assert_eq!(kept(&env, &sha), ALL);
    // The last one goes with them, here with its folder.
    std::fs::remove_dir_all(env.path("dir")).unwrap();
    assert_eq!(watch_delete(&ctx, "dir", true), 1);
    assert_eq!(kept(&env, &sha), NONE);
}

#[test]
fn an_overwrite_with_other_bytes_releases_what_the_old_ones_had() {
    let env = Env::new();
    let ctx = env.ctx(media());
    let (first, second) = (jpeg(40, 40, 1), jpeg(40, 40, 2));
    let (path, stat) = env.write("a.jpg", &first);
    assert!(process_file(&ctx, &path, "a.jpg", stat).unwrap());
    assert_eq!(kept(&env, &hex_sha(&first)), ALL);
    std::thread::sleep(std::time::Duration::from_millis(20));
    let (path, stat) = env.write("a.jpg", &second);
    assert!(process_file(&ctx, &path, "a.jpg", stat).unwrap());
    assert_eq!(kept(&env, &hex_sha(&first)), NONE);
    assert_eq!(kept(&env, &hex_sha(&second)), ALL);
}

#[test]
fn a_scan_sweep_and_a_move_over_a_stale_row_release_content() {
    let env = Env::new();
    let ctx = env.ctx(media());
    let (gone, moved, replaced) = (jpeg(30, 30, 3), jpeg(30, 30, 4), jpeg(30, 30, 5));
    env.write("gone.jpg", &gone);
    env.write("x.jpg", &moved);
    env.write("y.jpg", &replaced);
    scan_once(&ctx);
    // Deleted while nothing watched: the scan's sweep releases it.
    std::fs::remove_file(env.path("gone.jpg")).unwrap();
    assert_eq!(scan_once(&ctx).deleted, 1);
    assert_eq!(kept(&env, &hex_sha(&gone)), NONE);
    // A rename over another file replaces that file's row, and what it had.
    std::fs::rename(env.path("x.jpg"), env.path("y.jpg")).unwrap();
    assert_eq!(watch_rename(&ctx, "x.jpg", "y.jpg", false), 1);
    assert_eq!(kept(&env, &hex_sha(&replaced)), NONE);
    assert_eq!(kept(&env, &hex_sha(&moved)), ALL);
    // So does a folder moved over another.
    let (inner, stale) = (jpeg(30, 30, 6), jpeg(30, 30, 8));
    env.write("from/p.jpg", &inner);
    env.write("to/p.jpg", &stale);
    scan_once(&ctx);
    std::fs::remove_dir_all(env.path("to")).unwrap();
    std::fs::rename(env.path("from"), env.path("to")).unwrap();
    assert_eq!(watch_rename(&ctx, "from", "to", true), 1);
    assert_eq!(kept(&env, &hex_sha(&stale)), NONE);
    assert_eq!(kept(&env, &hex_sha(&inner)), ALL);
}

#[test]
fn a_row_inside_an_encrypted_folder_holds_no_content() {
    let env = Env::new();
    let ctx = env.ctx(media());
    let picture = jpeg(50, 20, 9);
    let (path, stat) = env.write("photo.jpg", &picture);
    assert!(process_file(&ctx, &path, "photo.jpg", stat).unwrap());
    env.write(&format!("Vault/{MARKER}"), b"{}");
    // A copy put in the encrypted folder from outside fdrive, beside the original.
    let (path, stat) = env.write("Vault/photo.jpg", &picture);
    assert!(process_file(&ctx, &path, "Vault/photo.jpg", stat).unwrap());
    let sha = hex_sha(&picture);
    assert_eq!(kept(&env, &sha), ALL);
    std::fs::remove_file(env.path("photo.jpg")).unwrap();
    watch_delete(&ctx, "photo.jpg", false);
    assert!(env.has_row(&ctx, "Vault/photo.jpg"));
    assert_eq!(kept(&env, &sha), NONE);
}

#[test]
fn a_release_that_fails_is_logged_and_changes_nothing_else() {
    let env = Env::new();
    let ctx = env.ctx(media());
    let picture = jpeg(20, 20, 10);
    env.write("a.jpg", &picture);
    scan_once(&ctx);
    let sha = hex_sha(&picture);
    std::fs::remove_file(env.path("a.jpg")).unwrap();
    let mut c = env.client();
    c.execute("DELETE FROM idx.files", &[]).unwrap();
    // Nothing to release, and a database that does not answer: nothing happens.
    assert_eq!(release(&ctx.db, &env.thumbs, &[]), 0);
    assert_eq!(release(&ctx.db, &env.thumbs, &[String::new()]), 0);
    let offline = Db {
        url: "postgres://fdrive:fdrive@127.0.0.1:1/none".to_owned(),
        retries: 1,
    };
    assert_eq!(release(&offline, &env.thumbs, std::slice::from_ref(&sha)), 0);
    assert_eq!(kept(&env, &sha), ALL);
    // A file that cannot be removed is logged; the rows still go.
    let small = env.thumbs.join(storage_path(&sha, 256));
    std::fs::remove_file(&small).unwrap();
    std::fs::create_dir(&small).unwrap();
    assert_eq!(release(&ctx.db, &env.thumbs, std::slice::from_ref(&sha)), 1);
    assert!(small.is_dir());
    assert!(!env.thumb_path(&sha, 1024).exists());
    assert_eq!(kept(&env, &sha).1, 0);
    // A cache that is not a folder, or not there, only means no files to remove.
    let other = jpeg(20, 20, 11);
    let other_sha = hex_sha(&other);
    env.write("b.jpg", &other);
    scan_once(&ctx);
    c.execute("DELETE FROM idx.files", &[]).unwrap();
    let file = env.thumbs.with_extension("file");
    std::fs::write(&file, b"not a folder").unwrap();
    assert_eq!(release(&ctx.db, &file, std::slice::from_ref(&other_sha)), 1);
    assert_eq!(kept(&env, &other_sha), (true, 0, 0));
    // A key no row holds is released even with nothing left of it.
    assert_eq!(release(&ctx.db, &env.thumbs.join("missing"), &[sha]), 1);
}
