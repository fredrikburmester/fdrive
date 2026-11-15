mod common;

use fdrive_indexer::config::{ROOT_ID, ROOT_NAME};

#[test]
fn migrations_seed_the_files_root_the_indexer_serves() {
    let url = common::database();
    let mut client = common::connect(&url);
    let name: String = client
        .query_one(r#"SELECT name FROM "idx"."roots" WHERE id = $1::bigint"#, &[&ROOT_ID])
        .unwrap()
        .get(0);
    assert_eq!(name, ROOT_NAME);
}
