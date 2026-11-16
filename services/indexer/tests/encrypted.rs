//! Encrypted folders against a real filesystem, Postgres and a fake `ml` server: a file inside
//! one keeps its row and nothing made from its bytes, on every path that indexes it.

mod common;

use std::time::Duration;

use common::root_env::{Env, fv, jpeg_with_exif};
use fdrive_indexer::db;
use fdrive_indexer::encrypted::{MARKER, Markers, REASON};
use fdrive_indexer::indexer::{
    Embedded, backfill_media, crossed_encryption, embed_chunks, media_derivatives_missing, process_file, process_inner,
    scan_once, should_retry_unchanged, watch_index, watch_rename,
};

/// What every file inside an encrypted folder holds: an age file, here only its header.
const AGE: &[u8] = b"age-encryption.org/v1\n-> X25519 c2VhbGVk\nciphertext\n";

fn hex_sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A well-formed encrypted name; `seed` (a lowercase letter or 2-7) tells two apart.
fn sealed(seed: char) -> String {
    format!("fe1-{}", seed.to_string().repeat(48))
}

/// An encrypted folder at `rel`, its marker written as the API writes it.
fn encrypted_folder(env: &Env, rel: &str) {
    env.write(&format!("{rel}/{MARKER}"), br#"{"v":1}"#);
}

/// `(text_status, error, text_chars)` of the row at `rel`.
fn text(env: &Env, rel: &str) -> (String, Option<String>, i32) {
    let row = env
        .client()
        .query_one(
            "SELECT text_status, error, text_chars FROM idx.files WHERE path = $1",
            &[&rel],
        )
        .unwrap();
    (row.get(0), row.get(1), row.get(2))
}

fn chunks(env: &Env, rel: &str) -> i64 {
    env.client()
        .query_one(
            "SELECT count(*) FROM idx.chunks c JOIN idx.files f ON f.id = c.file_id WHERE f.path = $1",
            &[&rel],
        )
        .unwrap()
        .get(0)
}

/// The camera and width EXIF gave the row at `rel`.
fn photo(env: &Env, rel: &str) -> (Option<String>, Option<i32>) {
    let row = env
        .client()
        .query_one("SELECT camera, width FROM idx.files WHERE path = $1", &[&rel])
        .unwrap();
    (row.get(0), row.get(1))
}

fn kept_out(env: &Env, rel: &str) -> bool {
    text(env, rel) == ("excluded".to_owned(), Some(REASON.to_owned()), 0) && chunks(env, rel) == 0
}

#[test]
fn a_scan_keeps_only_the_row_of_a_file_inside_an_encrypted_folder() {
    let env = Env::new();
    let ctx = env.ctx(common::all_features());
    encrypted_folder(&env, "alice/Secret");
    let inside = format!("alice/Secret/{}", sealed('a'));
    let below = format!("alice/Secret/{}/{}", sealed('b'), sealed('c'));
    env.write(&inside, AGE);
    env.write(&below, AGE);
    // Strays: files put there from outside fdrive, under clear names.
    let picture = jpeg_with_exif();
    env.write("alice/Secret/stray.jpg", &picture);
    env.write("alice/Secret/notes.txt", b"a canary the index never reads");
    env.write("alice/plain.txt", b"plain words");

    let result = scan_once(&ctx);
    assert_eq!((result.seen, result.changed, result.errors), (5, 5, 0));
    let statuses = env.statuses(&ctx);
    assert!(
        !statuses.contains_key(&format!("alice/Secret/{MARKER}")),
        "the marker is never indexed"
    );
    for rel in [
        inside.as_str(),
        below.as_str(),
        "alice/Secret/stray.jpg",
        "alice/Secret/notes.txt",
    ] {
        assert_eq!(statuses[rel], REASON, "{rel}");
        assert!(kept_out(&env, rel), "{rel}");
    }
    assert_eq!(statuses["alice/plain.txt"], "indexed");
    // The row still records what storage usage, the journal and the Mac's version checks need.
    let row = env.row(&ctx, &inside);
    assert_eq!(
        (row.size, row.sha256.as_deref()),
        (AGE.len() as i64, Some(hex_sha(AGE).as_str()))
    );
    assert_eq!(env.row(&ctx, "alice/Secret/stray.jpg").sha256, Some(hex_sha(&picture)));
    // Nothing is made from the bytes.
    assert_eq!(photo(&env, "alice/Secret/stray.jpg"), (None, None));
    assert_eq!(env.thumbnail_files(), 0);
    assert_eq!((env.count("app.thumbnails"), env.count("app.image_embeddings")), (0, 0));
    let canary: i64 = env
        .client()
        .query_one("SELECT count(*) FROM idx.chunks WHERE text LIKE '%canary%'", &[])
        .unwrap()
        .get(0);
    assert_eq!(canary, 0);
    assert!(
        env.ml
            .seen()
            .iter()
            .all(|s| !String::from_utf8_lossy(&s.body).contains("canary")),
        "nothing inside reaches the ml server"
    );
    assert!(env.unresolved().is_empty());

    // The rows are final: the next scan leaves them alone.
    let again = scan_once(&ctx);
    assert_eq!((again.seen, again.changed, again.deleted), (5, 0, 0));
}

#[test]
fn the_watcher_a_text_retry_and_a_reindex_keep_them_out_too() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, true, true));
    encrypted_folder(&env, "Vault");
    let (path, stat) = env.write("Vault/scan.txt", b"watched words");
    assert_eq!(watch_index(&ctx, &path, "Vault/scan.txt", stat).status, "indexed");
    assert!(kept_out(&env, "Vault/scan.txt"));
    // A file seen again unchanged is left alone.
    assert!(!process_file(&ctx, &path, "Vault/scan.txt", stat).unwrap());
    process_inner(&ctx, &path, "Vault/scan.txt", stat, None, Some("textSearch")).unwrap();
    assert!(kept_out(&env, "Vault/scan.txt"));
    // Embeddings queued before it was kept out never mark it indexed.
    let sha = env.row(&ctx, "Vault/scan.txt").sha256;
    assert_eq!(
        embed_chunks(&ctx, "Vault/scan.txt", sha.as_deref()).unwrap(),
        Embedded::Superseded
    );
    assert!(kept_out(&env, "Vault/scan.txt"));
    // A reindex marks the row pending; the scan that follows keeps it out again.
    db::mark_pending(&mut env.client(), ctx.root_id, None).unwrap();
    assert_eq!(scan_once(&ctx).changed, 1);
    assert!(kept_out(&env, "Vault/scan.txt"));
    assert!(
        env.ml
            .seen()
            .iter()
            .all(|s| !String::from_utf8_lossy(&s.body).contains("watched"))
    );
}

#[test]
fn an_item_trashed_on_its_own_is_kept_out_by_its_encrypted_name() {
    let env = Env::new();
    let ctx = env.ctx(fv(false, true, false, false, false));
    let alone = format!("alice/.trash/0b8f/{}", sealed('d'));
    let folder = format!("alice/.trash/0c9a/{}/stray.txt", sealed('e'));
    env.write(&alone, AGE);
    env.write(&folder, b"a stray below a trashed encrypted folder");
    env.write("alice/.trash/0d1b/clear.txt", b"an ordinary file in Trash");
    scan_once(&ctx);
    assert!(kept_out(&env, &alone));
    assert!(kept_out(&env, &folder));
    // Text search without embeddings: chunked, waiting for semantic search.
    assert_eq!(env.status(&ctx, "alice/.trash/0d1b/clear.txt"), "partial");
}

#[test]
fn a_file_renamed_across_the_edge_is_indexed_again() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, true, false, false, false));
    encrypted_folder(&env, "alice/Secret");
    let picture = jpeg_with_exif();
    env.write("alice/photo.jpg", &picture);
    env.write("alice/notes.txt", b"moving words");
    scan_once(&ctx);
    let sha = hex_sha(&picture);
    assert!(env.has_thumbnails(&sha));
    assert_eq!(chunks(&env, "alice/notes.txt"), 1);
    assert_eq!(photo(&env, "alice/photo.jpg").0.as_deref(), Some("Apple iPhone 15 Pro"));

    // Someone outside fdrive moves both in: the watcher moves the rows as they were.
    let rename = |from: &str, to: &str| {
        std::fs::rename(env.path(from), env.path(to)).unwrap();
        assert_eq!(watch_rename(&ctx, from, to, false), 1);
    };
    rename("alice/photo.jpg", "alice/Secret/photo.jpg");
    rename("alice/notes.txt", "alice/Secret/notes.txt");
    assert_eq!(env.status(&ctx, "alice/Secret/notes.txt"), "partial");
    assert!(crossed_encryption(&ctx, "alice/Secret/notes.txt", "partial"));
    assert!(!crossed_encryption(&ctx, "alice/Secret/notes.txt", REASON));
    // The next scan finds them inside and drops what was made from them.
    assert_eq!(scan_once(&ctx).changed, 2);
    for rel in ["alice/Secret/photo.jpg", "alice/Secret/notes.txt"] {
        assert!(kept_out(&env, rel), "{rel}");
    }
    assert_eq!(photo(&env, "alice/Secret/photo.jpg"), (None, None));
    assert!(!env.thumb_path(&sha, 256).exists() && !env.thumb_path(&sha, 1024).exists());
    assert_eq!(env.count("app.thumbnails"), 0);

    // Moved back out, they are indexed whole again.
    rename("alice/Secret/photo.jpg", "alice/photo.jpg");
    rename("alice/Secret/notes.txt", "alice/notes.txt");
    assert!(crossed_encryption(&ctx, "alice/notes.txt", REASON));
    assert_eq!(scan_once(&ctx).changed, 2);
    assert_eq!(env.status(&ctx, "alice/notes.txt"), "partial");
    assert_eq!(chunks(&env, "alice/notes.txt"), 1);
    assert!(env.has_thumbnails(&sha));
    assert_eq!(photo(&env, "alice/photo.jpg").0.as_deref(), Some("Apple iPhone 15 Pro"));
    assert_eq!(scan_once(&ctx).changed, 0);
}

#[test]
fn a_marker_that_appears_or_goes_is_seen_once_its_answer_expires() {
    let env = Env::new();
    let ctx = env.ctx_with(fv(false, true, false, false, false), |ctx| {
        ctx.markers = Markers::new(Duration::ZERO);
    });
    let (path, stat) = env.write("Docs/a.txt", b"some words");
    assert!(process_file(&ctx, &path, "Docs/a.txt", stat).unwrap());
    assert_eq!(env.status(&ctx, "Docs/a.txt"), "partial");
    encrypted_folder(&env, "Docs");
    // Unchanged, but inside now: indexed again, and kept out.
    assert!(process_file(&ctx, &path, "Docs/a.txt", stat).unwrap());
    assert!(kept_out(&env, "Docs/a.txt"));
    assert!(!process_file(&ctx, &path, "Docs/a.txt", stat).unwrap());
    std::fs::remove_file(env.path(&format!("Docs/{MARKER}"))).unwrap();
    assert!(process_file(&ctx, &path, "Docs/a.txt", stat).unwrap());
    assert_eq!(env.status(&ctx, "Docs/a.txt"), "partial");
    assert_eq!(chunks(&env, "Docs/a.txt"), 1);
}

#[test]
fn nothing_is_made_for_a_stray_by_a_media_backfill() {
    let env = Env::new();
    let ctx = env.ctx(fv(true, false, false, false, true));
    encrypted_folder(&env, "Vault");
    let picture = jpeg_with_exif();
    let (path, stat) = env.write("Vault/stray.jpg", &picture);
    env.seed(&ctx, "Vault/stray.jpg", &hex_sha(&picture), "none");
    let row = db::scan_manifest(&mut env.client(), ctx.root_id).unwrap()["Vault/stray.jpg"].clone();
    assert!(!media_derivatives_missing(
        &ctx,
        "Vault/stray.jpg",
        stat.size,
        &row,
        true
    ));
    assert!(backfill_media(&ctx, &path, "Vault/stray.jpg", stat).unwrap());
    assert_eq!(env.thumbnail_files(), 0);
    assert_eq!(env.ml.count(common::fake_ml::IMAGE_EMBED), 0);
    // Only leaving the folder changes a row kept out.
    let features = common::all_features();
    assert!(!should_retry_unchanged(REASON, &features));
}
