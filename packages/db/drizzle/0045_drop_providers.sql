-- The files folder is fdrive's only storage, so its row in app.providers and
-- the login column naming it go. Its id stays: the Mac app compares it as each
-- location's `providerId`, so it moves to the `storage.id` setting first. A
-- database the API never started has no row; the API creates the setting then.
INSERT INTO "app"."settings" ("key", "value")
SELECT 'storage.id', jsonb_build_object('id', "id") FROM "app"."providers"
WHERE "type" = 'local' AND "base_url" = 'local';--> statement-breakpoint
ALTER TABLE "app"."identities" DROP CONSTRAINT "identities_provider_id_external_username_unique";--> statement-breakpoint
ALTER TABLE "app"."identities" DROP CONSTRAINT "identities_provider_id_providers_id_fk";--> statement-breakpoint
ALTER TABLE "app"."identities" DROP COLUMN "provider_id";--> statement-breakpoint
DROP TABLE "app"."providers";--> statement-breakpoint
-- A login is named after its local user, in any case.
ALTER TABLE "app"."identities" RENAME COLUMN "external_username" TO "username";--> statement-breakpoint
ALTER INDEX "app"."identities_external_username_lower_unique" RENAME TO "identities_username_lower_unique";
