-- Personal activity drops what only SFTPGo, WebDAV or S3 produced: the
-- provider version of a revision, the provider snapshot of each login (its
-- label becomes the login's username), the Trash strategy in event facts,
-- and the observations listings found by comparing against history. Those
-- observation events no longer parse and are deleted with their dedupe state.
ALTER TABLE "app"."activity_revisions" DROP COLUMN "provider_version";--> statement-breakpoint
ALTER TABLE "app"."activity_storage_identities" DROP COLUMN "provider_id";--> statement-breakpoint
ALTER TABLE "app"."activity_storage_identities" DROP COLUMN "provider_type";--> statement-breakpoint
ALTER TABLE "app"."activity_storage_identities" DROP COLUMN "retired_at";--> statement-breakpoint
UPDATE "app"."activity_storage_identities" AS "s" SET "label" = "i"."external_username"
FROM "app"."identities" AS "i" WHERE "i"."id" = "s"."identity_id";--> statement-breakpoint
UPDATE "app"."activity_events" SET "before" = "before" - 'trashStrategy' WHERE "before" ? 'trashStrategy';--> statement-breakpoint
UPDATE "app"."activity_events" SET "after" = "after" - 'trashStrategy' WHERE "after" ? 'trashStrategy';--> statement-breakpoint
UPDATE "app"."activity_events" SET "detail" = "detail" - 'trashStrategy' WHERE "detail" ? 'trashStrategy';--> statement-breakpoint
DELETE FROM "app"."activity_observation_state" WHERE "event_id" IN (
  SELECT "id" FROM "app"."activity_events" WHERE "source" = 'refresh'
);--> statement-breakpoint
DELETE FROM "app"."activity_events" WHERE "source" = 'refresh';
