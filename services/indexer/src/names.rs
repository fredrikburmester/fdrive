//! The name index: the name of every live file and folder row in a Tantivy index held in
//! memory, so search finds a name typed with a typo or two. Postgres stays the source of
//! truth. Each root is built from `idx.files` and `idx.folders` when the indexer starts and
//! again after every completed scan, and every name row the indexer writes is reported here
//! (`NameIndex::touch`), so the index follows the tables within a moment. See
//! docs/INDEXER.md.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use postgres::Client;
use postgres::fallible_iterator::FallibleIterator;
use serde::{Deserialize, Serialize, Serializer};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, BoostQuery, ConstScoreQuery, FuzzyTermQuery, Occur, Query, TermQuery};
use tantivy::schema::{FAST, Field, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions, Value};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, SegmentReader, TantivyDocument, Term};
use unicode_normalization::UnicodeNormalization;

use crate::db::Db;
use crate::failures::describe;
use crate::log::log;
use crate::paths::basename;

/// A root with more changed paths than this waiting is rebuilt whole instead, as during the
/// first scan of a large library.
pub const MAX_PENDING_PATHS: usize = 2_000;
/// How long after a change the index waits for the ones that follow it, so a burst of
/// changes is one commit.
pub const SETTLE: Duration = Duration::from_millis(100);
/// The most hits of each kind one search returns.
pub const MAX_HITS: usize = 200;
/// The writer's indexing memory; Tantivy's minimum for one thread.
const WRITER_MEMORY: usize = 15_000_000;
/// The longest the index waits before trying a failed update again.
const MAX_RETRY: Duration = Duration::from_secs(60);

const FILE: &str = "file";
const FOLDER: &str = "folder";

/// Typos allowed in a query word of `chars` characters: none below five, one up to eight,
/// two from nine. `nameMatch` in packages/core counts the same way.
pub fn typo_budget(chars: usize) -> u8 {
    match chars {
        0..=4 => 0,
        5..=8 => 1,
        _ => 2,
    }
}

/// The share of its score a name keeps however old it is, and the days after which it has
/// lost half of what recency adds: `RECENCY_FLOOR` and `RECENCY_HALF_LIFE_DAYS` in
/// packages/core, which ranks what this returns.
const RECENCY_FLOOR: f64 = 0.4;
const RECENCY_HALF_LIFE_DAYS: f64 = 180.0;
const NS_PER_DAY: f64 = 86_400e9;

/// The factor a hit's score is multiplied by for its age, as `recencyWeight` computes it.
pub fn recency(mtime_ns: i64, now_ns: i64) -> f64 {
    let age_days = (now_ns.saturating_sub(mtime_ns).max(0) as f64) / NS_PER_DAY;
    RECENCY_FLOOR + (1.0 - RECENCY_FLOOR) * 0.5_f64.powf(age_days / RECENCY_HALF_LIFE_DAYS)
}

fn now_ns() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_nanos()).unwrap_or(i64::MAX))
}

/// A place the index is asked about: a root, and a root-relative folder or file in it (`""`
/// for the whole root).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Place {
    pub root_id: i64,
    #[serde(default)]
    pub prefix: String,
}

/// One search: the query as typed, where to look, what to leave out, and how many hits of
/// each kind to return.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct NameSearch {
    pub query: String,
    #[serde(default)]
    pub scopes: Vec<Place>,
    #[serde(default)]
    pub exclude: Vec<Place>,
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub folders: usize,
}

fn as_string<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

/// One file or folder row whose name answered a search. `mtime_ns` is a string in JSON, since
/// nanoseconds since 1970 do not fit a JSON number.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NameHit {
    pub id: i64,
    pub root_id: i64,
    pub path: String,
    #[serde(serialize_with = "as_string")]
    pub mtime_ns: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct NameHits {
    pub files: Vec<NameHit>,
    pub folders: Vec<NameHit>,
}

#[derive(Clone, Copy)]
struct Fields {
    kind: Field,
    id: Field,
    root: Field,
    path: Field,
    /// `<root id>:<path>`, for finding a row's document and a place that names it.
    key: Field,
    /// `<root id>:` and `<root id>:<folder>` for every folder above the row, for places.
    dirs: Field,
    /// The name, words lowercased.
    name: Field,
    mtime: Field,
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let words = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer("default")
            .set_index_option(IndexRecordOption::Basic),
    );
    let fields = Fields {
        kind: builder.add_text_field("kind", STRING),
        id: builder.add_i64_field("id", STORED),
        root: builder.add_i64_field("root", STORED),
        path: builder.add_text_field("path", STORED),
        key: builder.add_text_field("key", STRING),
        dirs: builder.add_text_field("dirs", STRING),
        name: builder.add_text_field("name", words),
        mtime: builder.add_i64_field("mtime", FAST | STORED),
    };
    (builder.build(), fields)
}

fn key(root_id: i64, path: &str) -> String {
    format!("{root_id}:{path}")
}

/// The `dirs` terms of a row at `path`: its root and every folder above it.
fn dir_terms(root_id: i64, path: &str) -> Vec<String> {
    std::iter::once(key(root_id, ""))
        .chain(path.match_indices('/').map(|(i, _)| key(root_id, &path[..i])))
        .collect()
}

/// `query` as a condition that adds nothing to a hit's score, which only the name decides.
fn filter(query: Box<dyn Query>) -> Box<dyn Query> {
    Box::new(ConstScoreQuery::new(query, 0.0))
}

fn nfc(text: &str) -> String {
    text.nfc().collect()
}

/// A change reported to the index.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Touch {
    /// Read the rows at `path` again, and with `subtree` those below it too.
    Path { root_id: i64, path: String, subtree: bool },
    /// Read every row of the root again.
    Rebuild(i64),
}

/// What a root is waiting for: paths to read again, or a rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    Paths(BTreeMap<String, bool>),
    Rebuild,
}

fn add(pending: &mut HashMap<i64, Pending>, touch: Touch) {
    match touch {
        Touch::Rebuild(root_id) => {
            pending.insert(root_id, Pending::Rebuild);
        }
        Touch::Path { root_id, path, subtree } => {
            let entry = pending
                .entry(root_id)
                .or_insert_with(|| Pending::Paths(BTreeMap::new()));
            let full = match entry {
                Pending::Paths(paths) => {
                    *paths.entry(path).or_insert(false) |= subtree;
                    paths.len() > MAX_PENDING_PATHS
                }
                Pending::Rebuild => false,
            };
            if full {
                *entry = Pending::Rebuild;
            }
        }
    }
}

const FILES_OF_ROOT: &str =
    r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."files" WHERE root_id = $1::bigint AND deleted_at IS NULL"#;
const FOLDERS_OF_ROOT: &str =
    r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."folders" WHERE root_id = $1::bigint"#;
const FILES_AT: &str = r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."files"
    WHERE root_id = $1::bigint AND deleted_at IS NULL AND path = ANY($2::text[])"#;
const FOLDERS_AT: &str = r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."folders"
    WHERE root_id = $1::bigint AND path = ANY($2::text[])"#;
const FILES_UNDER: &str = r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."files"
    WHERE root_id = $1::bigint AND deleted_at IS NULL AND starts_with(path, $2)"#;
const FOLDERS_UNDER: &str = r#"SELECT id::bigint, path, mtime_ns::bigint FROM "idx"."folders"
    WHERE root_id = $1::bigint AND starts_with(path, $2)"#;

/// A row as the index stores it.
struct Row {
    kind: &'static str,
    id: i64,
    path: String,
    mtime_ns: i64,
}

fn read_rows(
    c: &mut Client,
    sql: &str,
    kind: &'static str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<Row>> {
    let mut rows = c.query_raw(sql, params.iter().copied())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(Row {
            kind,
            id: row.get(0),
            path: row.get(1),
            mtime_ns: row.get(2),
        });
    }
    Ok(out)
}

/// The indexer's name index; see the module comment.
pub struct NameIndex {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    touches: Sender<Touch>,
    /// Set once every root the index started with has been built.
    ready: AtomicBool,
    /// Changes reported, and changes applied to what searches see.
    sent: AtomicU64,
    applied: AtomicU64,
}

impl NameIndex {
    /// An empty index that builds every root in `root_ids` from `db` on a thread of its own,
    /// then follows what is reported to it. The thread ends once the index is dropped.
    pub fn start(db: Db, root_ids: &[i64]) -> Result<Arc<Self>> {
        let (schema, fields) = schema();
        let index = Index::create_in_ram(schema);
        let writer: IndexWriter = index.writer_with_num_threads(1, WRITER_MEMORY)?;
        let reader = index.reader_builder().reload_policy(ReloadPolicy::Manual).try_into()?;
        let (touches, received) = crossbeam_channel::unbounded();
        let names = Arc::new(Self {
            index,
            reader,
            fields,
            touches,
            ready: AtomicBool::new(false),
            sent: AtomicU64::new(0),
            applied: AtomicU64::new(0),
        });
        for &root_id in root_ids {
            names.rebuild(root_id);
        }
        let weak = Arc::downgrade(&names);
        std::thread::Builder::new()
            .name("names".to_owned())
            .spawn(move || follow(&weak, &db, writer, &received))?;
        Ok(names)
    }

    /// Whether every root the index started with has been built, so searches can trust it.
    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    /// Whether every change reported so far is visible to searches.
    pub fn caught_up(&self) -> bool {
        self.applied.load(Ordering::SeqCst) >= self.sent.load(Ordering::SeqCst)
    }

    fn send(&self, touch: Touch) {
        self.sent.fetch_add(1, Ordering::SeqCst);
        // Only fails once the index is going away, when nothing reads it any more.
        let _ = self.touches.send(touch);
    }

    /// The indexer wrote the rows at `path` of a root (and with `subtree`, those below it);
    /// read them again.
    pub fn touch(&self, root_id: i64, path: &str, subtree: bool) {
        let path = path.trim_matches('/');
        if path.is_empty() {
            self.rebuild(root_id);
        } else {
            self.send(Touch::Path {
                root_id,
                path: path.to_owned(),
                subtree,
            });
        }
    }

    /// Read every row of a root again.
    pub fn rebuild(&self, root_id: i64) {
        self.send(Touch::Rebuild(root_id));
    }

    /// Files and folders whose name holds every query word, each within its typo budget of the
    /// start of a word of the name, inside `scopes` and outside `exclude`. Fewer typos, then a
    /// newer modification time, rank first. `None` until the index is ready.
    pub fn search(&self, query: &NameSearch) -> Result<Option<NameHits>> {
        if !self.ready() {
            return Ok(None);
        }
        let words = self.words(&query.query)?;
        if words.is_empty() || query.scopes.is_empty() {
            return Ok(Some(NameHits::default()));
        }
        let mut base: Vec<(Occur, Box<dyn Query>)> = words.iter().map(|w| (Occur::Must, self.word_query(w))).collect();
        let places = BooleanQuery::new(
            query
                .scopes
                .iter()
                .map(|p| (Occur::Should, self.place_query(p)))
                .collect(),
        );
        base.push((Occur::Must, filter(Box::new(places))));
        base.extend(query.exclude.iter().map(|p| (Occur::MustNot, self.place_query(p))));
        let searcher = self.reader.searcher();
        let now = now_ns();
        Ok(Some(NameHits {
            files: self.top(&searcher, &base, FILE, query.files.min(MAX_HITS), now)?,
            folders: self.top(&searcher, &base, FOLDER, query.folders.min(MAX_HITS), now)?,
        }))
    }

    /// The query's words as the name field reads them. A one-letter word is left out while
    /// the query has longer ones, as `nameMatch` does.
    fn words(&self, query: &str) -> Result<Vec<String>> {
        let mut analyzer = self.index.tokenizer_for_field(self.fields.name)?;
        let text = nfc(query);
        let mut stream = analyzer.token_stream(&text);
        let mut words = Vec::new();
        while stream.advance() {
            words.push(stream.token().text.clone());
        }
        let longer: Vec<String> = words.iter().filter(|w| w.chars().count() > 1).cloned().collect();
        Ok(if longer.is_empty() { words } else { longer })
    }

    /// A word of the name starts with `word`, give or take its typo budget; fewer typos score
    /// higher.
    fn word_query(&self, word: &str) -> Box<dyn Query> {
        let term = Term::from_field_text(self.fields.name, word);
        let budget = typo_budget(word.chars().count());
        let clauses = (0..=budget)
            .map(|distance| {
                let fuzzy: Box<dyn Query> = Box::new(FuzzyTermQuery::new_prefix(term.clone(), distance, true));
                let boost = [4.0, 2.0, 1.0][usize::from(distance)];
                (Occur::Should, Box::new(BoostQuery::new(fuzzy, boost)) as Box<dyn Query>)
            })
            .collect();
        Box::new(BooleanQuery::new(clauses))
    }

    /// The row a place names and every row below it.
    fn place_query(&self, place: &Place) -> Box<dyn Query> {
        let prefix = place.prefix.trim_matches('/');
        let term = |field: Field| {
            Box::new(TermQuery::new(
                Term::from_field_text(field, &key(place.root_id, prefix)),
                IndexRecordOption::Basic,
            )) as Box<dyn Query>
        };
        if prefix.is_empty() {
            return term(self.fields.dirs);
        }
        Box::new(BooleanQuery::new(vec![
            (Occur::Should, term(self.fields.dirs)),
            (Occur::Should, term(self.fields.key)),
        ]))
    }

    fn top(
        &self,
        searcher: &tantivy::Searcher,
        base: &[(Occur, Box<dyn Query>)],
        kind: &str,
        limit: usize,
        now: i64,
    ) -> Result<Vec<NameHit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut clauses: Vec<(Occur, Box<dyn Query>)> = base.iter().map(|(o, q)| (*o, q.box_clone())).collect();
        clauses.push((
            Occur::Must,
            filter(Box::new(TermQuery::new(
                Term::from_field_text(self.fields.kind, kind),
                IndexRecordOption::Basic,
            ))),
        ));
        let collector = TopDocs::with_limit(limit).tweak_score(move |segment: &SegmentReader| {
            let mtime = segment
                .fast_fields()
                .i64("mtime")
                .ok()
                .map(|column| column.first_or_default_col(now));
            move |doc: tantivy::DocId, score: tantivy::Score| {
                f64::from(score) * recency(mtime.as_ref().map_or(now, |m| m.get_val(doc)), now)
            }
        });
        let fields = self.fields;
        searcher
            .search(&BooleanQuery::new(clauses), &collector)?
            .into_iter()
            .map(|(_, address)| {
                let doc: TantivyDocument = searcher.doc(address)?;
                let number = |field| doc.get_first(field).and_then(|v| v.as_i64()).unwrap_or_default();
                Ok(NameHit {
                    id: number(fields.id),
                    root_id: number(fields.root),
                    path: doc
                        .get_first(fields.path)
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_owned(),
                    mtime_ns: number(fields.mtime),
                })
            })
            .collect()
    }

    fn document(&self, root_id: i64, row: &Row) -> TantivyDocument {
        let f = self.fields;
        let mut doc = TantivyDocument::new();
        doc.add_text(f.kind, row.kind);
        doc.add_i64(f.id, row.id);
        doc.add_i64(f.root, root_id);
        doc.add_text(f.path, &row.path);
        doc.add_text(f.key, key(root_id, &row.path));
        for term in dir_terms(root_id, &row.path) {
            doc.add_text(f.dirs, term);
        }
        doc.add_text(f.name, nfc(basename(&row.path)));
        doc.add_i64(f.mtime, row.mtime_ns);
        doc
    }

    /// Replace a root's documents with its rows.
    fn rebuild_root(&self, c: &mut Client, writer: &IndexWriter, root_id: i64) -> Result<u64> {
        writer.delete_term(Term::from_field_text(self.fields.dirs, &key(root_id, "")));
        let mut count = 0;
        for (sql, kind) in [(FILES_OF_ROOT, FILE), (FOLDERS_OF_ROOT, FOLDER)] {
            for row in read_rows(c, sql, kind, &[&root_id])? {
                writer.add_document(self.document(root_id, &row))?;
                count += 1;
            }
        }
        Ok(count)
    }

    /// Replace the documents at `paths` (and below those marked as subtrees) with their rows.
    fn refresh(
        &self,
        c: &mut Client,
        writer: &IndexWriter,
        root_id: i64,
        paths: &BTreeMap<String, bool>,
    ) -> Result<()> {
        let exact: Vec<&str> = paths.keys().map(String::as_str).collect();
        let mut rows: BTreeMap<(&'static str, String), Row> = BTreeMap::new();
        let mut keep = |found: Vec<Row>| {
            for row in found {
                rows.insert((row.kind, row.path.clone()), row);
            }
        };
        for path in &exact {
            writer.delete_term(Term::from_field_text(self.fields.key, &key(root_id, path)));
        }
        keep(read_rows(c, FILES_AT, FILE, &[&root_id, &exact])?);
        keep(read_rows(c, FOLDERS_AT, FOLDER, &[&root_id, &exact])?);
        for (path, _) in paths.iter().filter(|(_, subtree)| **subtree) {
            writer.delete_term(Term::from_field_text(self.fields.dirs, &key(root_id, path)));
            let prefix = format!("{path}/");
            keep(read_rows(c, FILES_UNDER, FILE, &[&root_id, &prefix])?);
            keep(read_rows(c, FOLDERS_UNDER, FOLDER, &[&root_id, &prefix])?);
        }
        for row in rows.values() {
            writer.add_document(self.document(root_id, row))?;
        }
        Ok(())
    }

    /// Apply what roots are waiting for and make it visible to searches.
    fn apply(&self, db: &Db, writer: &mut IndexWriter, batch: &HashMap<i64, Pending>) -> Result<()> {
        let started = Instant::now();
        let rebuilt = db.with(|c| {
            let mut rebuilt = Vec::new();
            for (&root_id, pending) in batch {
                match pending {
                    Pending::Rebuild => rebuilt.push((root_id, self.rebuild_root(c, writer, root_id)?)),
                    Pending::Paths(paths) => self.refresh(c, writer, root_id, paths)?,
                }
            }
            Ok(rebuilt)
        })?;
        writer.commit()?;
        self.reader.reload()?;
        for (root_id, count) in rebuilt {
            log(&format!(
                "names: root {root_id} rebuilt with {count} names in {:.1}s",
                started.elapsed().as_secs_f64()
            ));
        }
        Ok(())
    }
}

/// The index's thread: wait for changes, let a burst of them settle, apply them in one commit,
/// and on a failure roll back and rebuild the roots involved once the database answers again.
fn follow(names: &Weak<NameIndex>, db: &Db, mut writer: IndexWriter, received: &Receiver<Touch>) {
    let mut pending: HashMap<i64, Pending> = HashMap::new();
    let mut count: u64 = 0;
    let mut retry = Duration::ZERO;
    loop {
        let first = if pending.is_empty() {
            match received.recv() {
                Ok(touch) => Some(touch),
                Err(_) => return,
            }
        } else {
            match received.recv_timeout(retry) {
                Ok(touch) => Some(touch),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        };
        if let Some(touch) = first {
            add(&mut pending, touch);
            count += 1;
        }
        let settled = Instant::now() + SETTLE;
        loop {
            match received.recv_deadline(settled) {
                Ok(touch) => {
                    add(&mut pending, touch);
                    count += 1;
                }
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
        let Some(index) = names.upgrade() else { return };
        let batch = std::mem::take(&mut pending);
        match index.apply(db, &mut writer, &batch) {
            Ok(()) => {
                index.ready.store(true, Ordering::SeqCst);
                index.applied.fetch_add(std::mem::take(&mut count), Ordering::SeqCst);
                retry = Duration::ZERO;
            }
            Err(e) => {
                let _ = writer.rollback();
                log(&format!("names: update failed, retrying: {}", describe(&e)));
                pending = batch.into_keys().map(|root_id| (root_id, Pending::Rebuild)).collect();
                retry = (retry * 2).clamp(Duration::from_secs(1), MAX_RETRY);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_more_typos_in_longer_words() {
        assert_eq!(typo_budget(0), 0);
        assert_eq!(typo_budget(4), 0);
        assert_eq!(typo_budget(5), 1);
        assert_eq!(typo_budget(8), 1);
        assert_eq!(typo_budget(9), 2);
        assert_eq!(typo_budget(30), 2);
    }

    #[test]
    fn weighs_age_like_the_search_ranking() {
        let now = 1_000 * NS_PER_DAY as i64;
        assert!((recency(now, now) - 1.0).abs() < 1e-9);
        assert!((recency(now + 5, now) - 1.0).abs() < 1e-9);
        let half = recency(now - 180 * NS_PER_DAY as i64, now);
        assert!((half - (RECENCY_FLOOR + (1.0 - RECENCY_FLOOR) / 2.0)).abs() < 1e-9);
        assert!(recency(0, now) >= RECENCY_FLOOR);
    }

    #[test]
    fn names_every_folder_above_a_row() {
        assert_eq!(dir_terms(3, "a.txt"), vec!["3:"]);
        assert_eq!(dir_terms(3, "a/b/c.txt"), vec!["3:", "3:a", "3:a/b"]);
    }

    #[test]
    fn rebuilds_a_root_once_too_many_paths_wait() {
        let mut pending = HashMap::new();
        for i in 0..MAX_PENDING_PATHS {
            add(
                &mut pending,
                Touch::Path {
                    root_id: 1,
                    path: format!("p{i}"),
                    subtree: false,
                },
            );
        }
        assert!(matches!(pending.get(&1), Some(Pending::Paths(p)) if p.len() == MAX_PENDING_PATHS));
        add(
            &mut pending,
            Touch::Path {
                root_id: 1,
                path: "one more".to_owned(),
                subtree: false,
            },
        );
        assert_eq!(pending.get(&1), Some(&Pending::Rebuild));
        add(
            &mut pending,
            Touch::Path {
                root_id: 1,
                path: "after".to_owned(),
                subtree: true,
            },
        );
        assert_eq!(pending.get(&1), Some(&Pending::Rebuild));
    }

    #[test]
    fn keeps_a_path_a_subtree_once_any_touch_says_so() {
        let mut pending = HashMap::new();
        let touch = |subtree| Touch::Path {
            root_id: 2,
            path: "a".to_owned(),
            subtree,
        };
        add(&mut pending, touch(true));
        add(&mut pending, touch(false));
        assert_eq!(
            pending.get(&2),
            Some(&Pending::Paths(BTreeMap::from([("a".to_owned(), true)])))
        );
        add(&mut pending, Touch::Rebuild(2));
        assert_eq!(pending.get(&2), Some(&Pending::Rebuild));
    }

    #[test]
    fn writes_modification_times_as_strings() {
        let hit = NameHit {
            id: 1,
            root_id: 2,
            path: "a".to_owned(),
            mtime_ns: 1_794_614_400_000_000_000,
        };
        assert_eq!(
            serde_json::to_value(&hit).ok(),
            Some(serde_json::json!({"id": 1, "root_id": 2, "path": "a", "mtime_ns": "1794614400000000000"}))
        );
    }
}
