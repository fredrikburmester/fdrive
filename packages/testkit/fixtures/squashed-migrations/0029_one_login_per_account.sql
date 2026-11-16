-- One login per account. An account keeps its oldest login; any other login
-- is deleted with everything keyed by it (its tags on paths, favorites,
-- shares, chats, folder views). Its user signs in again and gets an account
-- of their own. Files are not touched.
DELETE FROM "app"."identities" AS "extra" USING "app"."identities" AS "kept"
WHERE "extra"."account_id" = "kept"."account_id"
  AND ("kept"."created_at", "kept"."id") < ("extra"."created_at", "extra"."id");--> statement-breakpoint
-- A session or token whose login is gone (set to null above or earlier) can
-- no longer act for anyone.
DELETE FROM "app"."sessions" WHERE "active_identity_id" IS NULL;--> statement-breakpoint
DELETE FROM "app"."api_tokens" WHERE "identity_id" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."sessions" DROP CONSTRAINT "sessions_active_identity_id_identities_id_fk";--> statement-breakpoint
DROP INDEX "app"."sessions_active_identity_id_idx";--> statement-breakpoint
ALTER TABLE "app"."sessions" RENAME COLUMN "active_identity_id" TO "identity_id";--> statement-breakpoint
ALTER TABLE "app"."sessions" ALTER COLUMN "identity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_identity_id_idx" ON "app"."sessions" USING btree ("identity_id");--> statement-breakpoint
ALTER TABLE "app"."api_tokens" DROP CONSTRAINT "api_tokens_identity_id_identities_id_fk";--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ALTER COLUMN "identity_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "app"."identities_account_id_idx";--> statement-breakpoint
ALTER TABLE "app"."identities" ADD CONSTRAINT "identities_account_id_unique" UNIQUE("account_id");
