-- An indexer started before the API had migrated could create the `files`
-- root while the old `sftpgo` root still held the index, so 0017's rename was
-- skipped and the folder began indexing again from scratch. When both roots
-- exist, the old one keeps the index: the duplicate's partial rows go, and
-- the old root takes the name. Office documents named under the duplicate
-- lose to the originals for the same file.
DO $$
DECLARE
	old_id smallint;
	duplicate_id smallint;
BEGIN
	SELECT "id" INTO old_id FROM "idx"."roots" WHERE "name" = 'sftpgo';
	SELECT "id" INTO duplicate_id FROM "idx"."roots" WHERE "name" = 'files';
	IF old_id IS NOT NULL AND duplicate_id IS NOT NULL THEN
		DELETE FROM "idx"."files" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."scans" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."moves" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."events" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."ocr_log" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."processing_failures" WHERE "root_id" = duplicate_id;
		DELETE FROM "idx"."roots" WHERE "id" = duplicate_id;
		UPDATE "idx"."roots" SET "name" = 'files' WHERE "id" = old_id;
	END IF;
END $$;--> statement-breakpoint
DELETE FROM "app"."office_files" AS duplicate
WHERE duplicate."root_name" = 'files' AND EXISTS (
	SELECT 1 FROM "app"."office_files" AS original
	WHERE original."root_name" = 'sftpgo'
		AND original."provider_id" = duplicate."provider_id"
		AND original."path" = duplicate."path"
);--> statement-breakpoint
UPDATE "app"."office_files" SET "root_name" = 'files' WHERE "root_name" = 'sftpgo';--> statement-breakpoint
-- Version 2: the index root is `files`. The indexer and OCR wait for it, so
-- they never touch roots before the API has run the migrations above.
INSERT INTO "idx"."schema_version" ("version") VALUES (2) ON CONFLICT DO NOTHING;
