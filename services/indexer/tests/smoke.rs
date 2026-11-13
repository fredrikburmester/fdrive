mod common;

#[test]
fn migrated_database_has_the_schema() {
    let url = common::database();
    let mut client = common::connect(&url);
    let version: i32 = client
        .query_one(r#"SELECT max(version) FROM "idx"."schema_version""#, &[])
        .unwrap()
        .get(0);
    assert_eq!(version, fdrive_indexer::runner::EXPECTED_SCHEMA_VERSION as i32);
}
