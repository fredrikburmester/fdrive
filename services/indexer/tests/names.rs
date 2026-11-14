//! The name index against a migrated database: built from the rows, searched with typos,
//! kept in step with the rows the indexer writes, and served at `/names/search`.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request};
use common::root_env::{Env, fv, wait_until};
use fdrive_indexer::db::{self, Db, FolderRow, NewFile};
use fdrive_indexer::indexer::{RootContext, scan_once, watch_folder, watch_mark_deleted, watch_rename};
use fdrive_indexer::names::{MAX_PENDING_PATHS, MAX_PLACES, MAX_WORDS, NameHit, NameIndex, NameSearch, Place};
use fdrive_indexer::server::{AppState, Jobs, router};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use unicode_normalization::UnicodeNormalization;

const WAIT: Duration = Duration::from_secs(20);
const DAY_NS: i64 = 86_400_000_000_000;

fn now_ns() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as i64
}

fn root(url: &str) -> i64 {
    db::upsert_root(&mut common::connect(url), "r").unwrap()
}

fn file(url: &str, root_id: i64, path: &str, age_days: i64) -> i64 {
    let name = path.rsplit('/').next().unwrap();
    db::upsert_file(
        &mut common::connect(url),
        &NewFile {
            root_id,
            path,
            name,
            ext: &fdrive_indexer::paths::ext_of(name),
            size: 1,
            mtime_ns: now_ns() - age_days * DAY_NS,
            sha256: &"a".repeat(64),
            mime: None,
        },
    )
    .unwrap()
}

fn folders(url: &str, root_id: i64, paths: &[(&str, i64)]) {
    let rows: Vec<FolderRow> = paths
        .iter()
        .map(|(path, age_days)| FolderRow {
            path: (*path).to_owned(),
            mtime_ns: now_ns() - age_days * DAY_NS,
        })
        .collect();
    db::sync_folders(&mut common::connect(url), root_id, &rows, None).unwrap();
}

fn start(url: &str, root_ids: &[i64]) -> Arc<NameIndex> {
    let names = NameIndex::start(Db::new(url), root_ids).unwrap();
    assert!(
        wait_until(WAIT, || names.ready() && names.caught_up()),
        "the name index never got ready"
    );
    names
}

fn settle(names: &NameIndex) {
    assert!(wait_until(WAIT, || names.caught_up()), "the name index never caught up");
}

fn place(root_id: i64, prefix: &str) -> Place {
    Place {
        root_id,
        prefix: prefix.to_owned(),
    }
}

fn search(names: &NameIndex, query: &str, scopes: Vec<Place>, exclude: Vec<Place>) -> (Vec<String>, Vec<String>) {
    let hits = names
        .search(&NameSearch {
            query: query.to_owned(),
            scopes,
            exclude,
            files: 20,
            folders: 20,
        })
        .unwrap()
        .expect("ready");
    let paths = |hits: Vec<NameHit>| hits.into_iter().map(|h| h.path).collect();
    (paths(hits.files), paths(hits.folders))
}

fn find(names: &NameIndex, root_id: i64, query: &str) -> (Vec<String>, Vec<String>) {
    search(names, query, vec![place(root_id, "")], vec![])
}

fn nfd(text: &str) -> String {
    text.nfd().collect()
}

#[test]
fn finds_names_typed_with_typos() {
    let url = common::database();
    let root_id = root(&url);
    folders(
        &url,
        root_id,
        &[("Work", 3), ("Work/Mikrolärande", 2), ("Work/InfraGuide loggbok", 4)],
    );
    file(&url, root_id, "Work/Kontextdokument.md", 5);
    file(&url, root_id, &nfd("Work/Lägerlåt 2024.pdf"), 5);
    let names = start(&url, &[root_id]);

    assert_eq!(find(&names, root_id, "Microlär").1, ["Work/Mikrolärande"]);
    assert_eq!(find(&names, root_id, "mikrolarande").1, ["Work/Mikrolärande"]);
    assert_eq!(find(&names, root_id, "infragide logbok").1, ["Work/InfraGuide loggbok"]);
    assert_eq!(find(&names, root_id, "Kontextdokumnet").0, ["Work/Kontextdokument.md"]);
    // A name macOS stored with decomposed accents reads like the letters typed.
    assert_eq!(find(&names, root_id, "lägerlåt").0, [nfd("Work/Lägerlåt 2024.pdf")]);
    // Two typos are too many for an eight-letter word, and a word under five letters allows none.
    assert!(find(&names, root_id, "lagerlat").0.is_empty());
    assert!(find(&names, root_id, "wrok").1.is_empty());
    // Names only: the folders above a row do not answer for it.
    assert_eq!(find(&names, root_id, "work").1, ["Work"]);
    // A one-letter word does not narrow a query with longer ones.
    assert_eq!(find(&names, root_id, "mikrolärande b").1, ["Work/Mikrolärande"]);
    // Words past the most one search matches are left for the API to check.
    let long = format!("{} zzzzz", ["mikrolärande"; MAX_WORDS].join(" "));
    assert_eq!(find(&names, root_id, &long).1, ["Work/Mikrolärande"]);
    assert!(
        names
            .search(&NameSearch {
                query: "mikrolärande".to_owned(),
                scopes: vec![place(root_id, ""); MAX_PLACES + 1],
                exclude: vec![],
                files: 1,
                folders: 1,
            })
            .is_err()
    );
}

#[test]
fn ranks_fewer_typos_first_then_newer() {
    let url = common::database();
    let root_id = root(&url);
    folders(
        &url,
        root_id,
        &[("Mikrolar", 0), ("Mikrolärande gammal", 3000), ("Mikrolärande ny", 1)],
    );
    let names = start(&url, &[root_id]);
    assert_eq!(
        find(&names, root_id, "mikrolär").1,
        ["Mikrolärande ny", "Mikrolärande gammal", "Mikrolar"]
    );
}

#[test]
fn searches_only_inside_the_scopes_and_outside_the_exclusions() {
    let url = common::database();
    let root_id = root(&url);
    let other = db::upsert_root(&mut common::connect(&url), "other").unwrap();
    folders(
        &url,
        root_id,
        &[
            ("alice", 1),
            ("alice/Budget", 1),
            ("alice/.trash/Budget", 1),
            ("bob/Budget", 1),
        ],
    );
    file(&url, root_id, "alice/Budget 2026.xlsx", 1);
    file(&url, root_id, "Budget.txt", 1);
    folders(&url, other, &[("alice/Budget", 1)]);
    let names = start(&url, &[root_id, other]);

    let (files, mut found) = search(&names, "budgte", vec![place(root_id, "/alice/")], vec![]);
    found.sort();
    assert_eq!(files, ["alice/Budget 2026.xlsx"]);
    assert_eq!(found, ["alice/.trash/Budget", "alice/Budget"]);
    let (_, found) = search(
        &names,
        "budget",
        vec![place(root_id, "alice")],
        vec![place(root_id, "alice/.trash")],
    );
    assert_eq!(found, ["alice/Budget"]);
    // A place may name the row itself.
    assert_eq!(
        search(&names, "budget", vec![place(root_id, "bob/Budget")], vec![]).1,
        ["bob/Budget"]
    );
    // A whole root, and leaving one out.
    assert_eq!(
        search(&names, "budget", vec![place(other, "")], vec![]).1,
        ["alice/Budget"]
    );
    assert!(
        search(&names, "budget", vec![place(other, "")], vec![place(other, "")])
            .1
            .is_empty()
    );
    assert!(search(&names, "budget", vec![], vec![]).1.is_empty());
}

#[test]
fn answers_with_nothing_for_an_empty_query_or_no_room() {
    let url = common::database();
    let root_id = root(&url);
    folders(&url, root_id, &[("Budget", 1)]);
    file(&url, root_id, "Budget.txt", 1);
    let names = start(&url, &[root_id]);
    assert_eq!(find(&names, root_id, " - "), (vec![], vec![]));
    let hits = names
        .search(&NameSearch {
            query: "budget".to_owned(),
            scopes: vec![place(root_id, "")],
            exclude: vec![],
            files: 1,
            folders: 0,
        })
        .unwrap()
        .unwrap();
    assert_eq!((hits.files.len(), hits.folders.len()), (1, 0));
    assert_eq!(hits.files[0].root_id, root_id);
}

#[test]
fn follows_the_rows_it_is_told_about() {
    let url = common::database();
    let root_id = root(&url);
    folders(&url, root_id, &[("Projects", 1), ("Projects/Kvartalsrapport", 1)]);
    file(&url, root_id, "Projects/Kvartalsrapport/Q1.pdf", 1);
    let names = start(&url, &[root_id]);

    // A new file.
    let id = file(&url, root_id, "Projects/Offert Volvo.pdf", 0);
    names.touch(root_id, "/Projects/Offert Volvo.pdf", false);
    settle(&names);
    let hits = names
        .search(&NameSearch {
            query: "ofert".to_owned(),
            scopes: vec![place(root_id, "")],
            exclude: vec![],
            files: 5,
            folders: 5,
        })
        .unwrap()
        .unwrap();
    assert_eq!(hits.files.iter().map(|h| h.id).collect::<Vec<_>>(), [id]);

    // A folder renamed with everything in it.
    let mut c = common::connect(&url);
    db::move_paths(&mut c, root_id, "Projects/Kvartalsrapport", "Projects/Årsrapport", true).unwrap();
    names.touch(root_id, "Projects/Kvartalsrapport", true);
    names.touch(root_id, "Projects/Årsrapport", true);
    settle(&names);
    assert!(find(&names, root_id, "kvartalsrapprt").1.is_empty());
    assert_eq!(find(&names, root_id, "arsrapport").1, ["Projects/Årsrapport"]);
    let mut q1 = find(&names, root_id, "q1").0;
    q1.sort();
    assert_eq!(q1, ["Projects/Årsrapport/Q1.pdf"]);

    // A folder deleted with everything in it.
    db::delete_paths(&mut c, root_id, "Projects", true).unwrap();
    names.touch(root_id, "Projects", true);
    settle(&names);
    assert_eq!(find(&names, root_id, "rapport"), (vec![], vec![]));
    assert!(find(&names, root_id, "q1").0.is_empty());

    // A rebuild reads the whole root again, and so does a change at the top of it.
    folders(&url, root_id, &[("Semester", 1)]);
    names.touch(root_id, "/", true);
    settle(&names);
    assert_eq!(find(&names, root_id, "semestr").1, ["Semester"]);
}

#[test]
fn rebuilds_a_root_when_more_changes_wait_than_it_reads_one_by_one() {
    let url = common::database();
    let root_id = root(&url);
    let names = start(&url, &[root_id]);
    let paths: Vec<String> = (0..=MAX_PENDING_PATHS).map(|i| format!("Mapp {i}")).collect();
    let rows: Vec<FolderRow> = paths
        .iter()
        .map(|path| FolderRow {
            path: path.clone(),
            mtime_ns: now_ns(),
        })
        .collect();
    db::sync_folders(&mut common::connect(&url), root_id, &rows, None).unwrap();
    for path in &paths {
        names.touch(root_id, path, false);
    }
    settle(&names);
    let hits = names
        .search(&NameSearch {
            query: "mapp 2000".to_owned(),
            scopes: vec![place(root_id, "")],
            exclude: vec![],
            files: 0,
            folders: 5,
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        hits.folders.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
        ["Mapp 2000"]
    );
}

#[test]
fn waits_for_the_database_before_answering() {
    let closed = Db {
        url: "postgres://fdrive:fdrive@127.0.0.1:9/fdrive".to_owned(),
        retries: 1,
    };
    let names = NameIndex::start(closed, &[1]).unwrap();
    names.touch(1, "a", false);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!names.ready());
    assert!(!names.caught_up());
    assert_eq!(
        names
            .search(&NameSearch {
                query: "anything".to_owned(),
                scopes: vec![place(1, "")],
                exclude: vec![],
                files: 5,
                folders: 5,
            })
            .unwrap(),
        None
    );
}

// ---------------------------------------------------------------------------------------
// The indexer reports what it writes
// ---------------------------------------------------------------------------------------

fn with_names(env: &Env) -> (Arc<RootContext>, Arc<NameIndex>) {
    let ctx = env.ctx(fv(false, true, false, false, false));
    let names = start(&env.url, &[ctx.root_id]);
    assert!(ctx.names.set(Arc::clone(&names)).is_ok());
    (ctx, names)
}

#[test]
fn follows_what_scans_and_the_watcher_write() {
    let env = Env::new();
    let (ctx, names) = with_names(&env);
    env.write("Kurser/Ljudfysik/Lab1.txt", b"lab");
    env.write("Kurser/Ljudfysik/Rapport.txt", b"rapport");
    scan_once(&ctx);
    settle(&names);
    assert_eq!(find(&names, ctx.root_id, "ljudfysk").1, ["Kurser/Ljudfysik"]);
    assert_eq!(find(&names, ctx.root_id, "raport").0, ["Kurser/Ljudfysik/Rapport.txt"]);

    std::fs::rename(env.path("Kurser/Ljudfysik"), env.path("Kurser/Akustik")).unwrap();
    watch_rename(&ctx, "Kurser/Ljudfysik", "Kurser/Akustik", true);
    settle(&names);
    assert!(find(&names, ctx.root_id, "ljudfysik").1.is_empty());
    assert_eq!(find(&names, ctx.root_id, "akustk").1, ["Kurser/Akustik"]);
    assert_eq!(find(&names, ctx.root_id, "raport").0, ["Kurser/Akustik/Rapport.txt"]);

    std::fs::remove_file(env.path("Kurser/Akustik/Rapport.txt")).unwrap();
    watch_mark_deleted(&ctx, "Kurser/Akustik/Rapport.txt", false);
    settle(&names);
    assert!(find(&names, ctx.root_id, "rapport").0.is_empty());

    std::fs::create_dir_all(env.path("Kurser/Akustik/Mätningar")).unwrap();
    watch_folder(&ctx, "Kurser/Akustik/Mätningar");
    settle(&names);
    assert_eq!(find(&names, ctx.root_id, "matningar").1, ["Kurser/Akustik/Mätningar"]);

    // A later scan finds a file deleted behind the watcher's back and sweeps its row.
    std::fs::remove_file(env.path("Kurser/Akustik/Lab1.txt")).unwrap();
    scan_once(&ctx);
    settle(&names);
    assert!(find(&names, ctx.root_id, "lab1").0.is_empty());
}

// ---------------------------------------------------------------------------------------
// `/names/search`
// ---------------------------------------------------------------------------------------

fn app(url: &str, names: Option<Arc<NameIndex>>) -> Arc<AppState> {
    Arc::new(AppState {
        contexts: vec![],
        watchers: Arc::default(),
        wakes: std::collections::HashMap::new(),
        db: Db::new(url),
        content: None,
        jobs: Jobs::default(),
        failure_retry_feature: Mutex::new("thumbnails".to_owned()),
        instance_id: "instance".to_owned(),
        names,
    })
}

fn post(state: &Arc<AppState>, body: &str) -> (u16, Value) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/names/search")
        .header("content-type", "application/json")
        .body(Body::from(body.to_owned()))
        .unwrap();
    runtime.block_on(async {
        let response = router(Arc::clone(state)).oneshot(request).await.unwrap();
        let status = response.status().as_u16();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    })
}

#[test]
fn serves_searches_once_the_index_is_ready() {
    let url = common::database();
    let root_id = root(&url);
    folders(&url, root_id, &[("alice/Mikrolärande", 2)]);
    let names = start(&url, &[root_id]);
    let state = app(&url, Some(names));
    let body =
        json!({"query": "Microlär", "scopes": [{"root_id": root_id, "prefix": "alice"}], "files": 5, "folders": 5});
    let (status, answer) = post(&state, &body.to_string());
    assert_eq!(status, 200);
    assert_eq!(answer["files"], json!([]));
    assert_eq!(answer["folders"][0]["path"], "alice/Mikrolärande");
    assert_eq!(answer["folders"][0]["root_id"], root_id);
    assert!(answer["folders"][0]["mtime_ns"].is_string());

    assert_eq!(post(&state, "{\"scopes\": []}").0, 400);
    let crowded = json!({"query": "x", "scopes": vec![json!({"root_id": root_id}); MAX_PLACES + 1]});
    assert_eq!(
        post(&state, &crowded.to_string()),
        (400, json!({"error": "too many places"}))
    );
    assert_eq!(post(&state, "not json").0, 400);
    assert_eq!(post(&app(&url, None), &body.to_string()).0, 503);

    let building = NameIndex::start(
        Db {
            url: "postgres://fdrive:fdrive@127.0.0.1:9/fdrive".to_owned(),
            retries: 1,
        },
        &[root_id],
    )
    .unwrap();
    let (status, answer) = post(&app(&url, Some(building)), &body.to_string());
    assert_eq!(
        (status, answer["error"].as_str()),
        (503, Some("name index is building"))
    );
}
