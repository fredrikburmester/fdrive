-- The files folder is the only index root: row 1, named `files`, seeded here
-- so nothing creates it and the API journals its changes from its first
-- start. Any other root goes, with what was indexed under it; the index is
-- the disk's to rebuild, and the next scan does.
DELETE FROM "idx"."files" WHERE "root_id" IN (
	SELECT "id" FROM "idx"."roots" WHERE "id" <> 1 OR "name" <> 'files'
);--> statement-breakpoint
DELETE FROM "idx"."scans" WHERE "root_id" IN (
	SELECT "id" FROM "idx"."roots" WHERE "id" <> 1 OR "name" <> 'files'
);--> statement-breakpoint
DELETE FROM "idx"."ocr_log" WHERE "root_id" IN (
	SELECT "id" FROM "idx"."roots" WHERE "id" <> 1 OR "name" <> 'files'
);--> statement-breakpoint
DELETE FROM "idx"."roots" WHERE "id" <> 1 OR "name" <> 'files';--> statement-breakpoint
INSERT INTO "idx"."roots" ("id", "name") VALUES (1, 'files') ON CONFLICT DO NOTHING;--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('"idx"."roots"', 'id'), 1);
