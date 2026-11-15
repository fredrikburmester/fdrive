-- The indexer and OCR start after a healthy API, which migrates before it
-- serves, so they no longer wait for a schema version.
DROP TABLE "idx"."schema_version";
