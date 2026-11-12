CREATE TABLE "app"."local_users" (
	"username" text PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "local_users_username_lower_unique" ON "app"."local_users" USING btree (lower("username"));--> statement-breakpoint
-- SFTPGo is gone: its users' homes were <data>/<username>, the layout the local
-- provider serves. Turn the SFTPGo row the deployment pinned (else the one the
-- setup owner signed in to, else the oldest) into the local provider in place, so every login and everything keyed by it
-- (tags, favorites, shares, activity, Office files) carries over. Passwords are
-- carried over from the sealed credentials when the API starts.
UPDATE "app"."providers" SET "type" = 'local', "base_url" = 'local', "config" = '{}'::jsonb
WHERE "id" = (
	SELECT "id" FROM "app"."providers" WHERE "type" = 'sftpgo'
	ORDER BY "managed_by_env" DESC,
		"base_url" IS NOT DISTINCT FROM (
			SELECT "value"->>'baseUrl' FROM "app"."settings" WHERE "key" = 'setup.owner.v1'
		) DESC,
		"created_at" ASC
	LIMIT 1
) AND NOT EXISTS (SELECT 1 FROM "app"."providers" WHERE "type" = 'local');--> statement-breakpoint
UPDATE "app"."providers" SET "enabled" = false, "managed_by_env" = false WHERE "type" = 'sftpgo';--> statement-breakpoint
-- The index root SFTPGo's data folder was read under becomes the local
-- folder's root, `files`, keeping every indexed file, OCR record and Office
-- document instead of indexing the same folder again under a new name.
UPDATE "app"."office_files" SET "root_name" = 'files'
WHERE "root_name" = 'sftpgo' AND NOT EXISTS (SELECT 1 FROM "idx"."roots" WHERE "name" = 'files');--> statement-breakpoint
UPDATE "idx"."roots" SET "name" = 'files'
WHERE "name" = 'sftpgo' AND NOT EXISTS (SELECT 1 FROM "idx"."roots" WHERE "name" = 'files');--> statement-breakpoint
-- Virtual folder mappings existed for SFTPGo; a local home is always <root>/<username>.
DELETE FROM "app"."settings" WHERE "key" = 'mount_mappings' OR "key" LIKE 'identity\_scope:%';--> statement-breakpoint
ALTER TABLE "app"."shares" DROP CONSTRAINT "shares_identity_id_sftpgo_share_id_unique";--> statement-breakpoint
ALTER TABLE "app"."shares" DROP CONSTRAINT "shares_password_hash_kind";--> statement-breakpoint
-- SFTPGo's share links become links fdrive serves itself, keeping their
-- addresses. SFTPGo kept their passwords, so a protected link gets a hash that
-- matches nothing: it stays locked until its owner sets a new password.
UPDATE "app"."shares" SET "password_hash" = 'locked$sftpgo'
WHERE "sftpgo_share_id" IS NOT NULL AND "has_password";--> statement-breakpoint
CREATE INDEX "shares_identity_id_idx" ON "app"."shares" USING btree ("identity_id");--> statement-breakpoint
ALTER TABLE "app"."shares" DROP COLUMN "sftpgo_share_id";--> statement-breakpoint
ALTER TABLE "app"."shares" ADD CONSTRAINT "shares_password_hash_kind" CHECK ("app"."shares"."has_password" = ("app"."shares"."password_hash" is not null));
