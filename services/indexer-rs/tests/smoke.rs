mod common;

#[test]
fn migrated_database_has_the_schema() {
    let url = common::database();
    let mut client = common::connect(&url);
    let version: i32 = client.query_one(r#"SELECT version FROM "idx"."schema_version""#, &[]).unwrap().get(0);
    assert_eq!(version, 1);
}
