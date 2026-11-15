-- fdrive checks passwords against app.local_users alone, and every local user
-- has a login of exactly the same name from the moment it exists, which a
-- sign-in finds in any case. A login on storage other than the files folder,
-- or one whose user is gone (removed under System > Users), is deleted with
-- everything keyed by it: its tags on paths, favorites, folder views, shares,
-- chats, tokens and sessions. A user without a login, left by a setup or an
-- add that failed halfway, is deleted too. Files are not touched.
DELETE FROM "app"."identities" AS "i"
WHERE "i"."provider_id" NOT IN (SELECT "id" FROM "app"."providers" WHERE "type" = 'local')
  OR NOT EXISTS (
    SELECT 1 FROM "app"."local_users" AS "u" WHERE "u"."username" = "i"."external_username"
  );--> statement-breakpoint
DELETE FROM "app"."local_users" AS "u"
WHERE NOT EXISTS (
  SELECT 1 FROM "app"."identities" AS "i" WHERE "i"."external_username" = "u"."username"
);--> statement-breakpoint
-- Setup completes in one transaction: an unfinished claim, or the marker an
-- installation from before the owner record kept, no longer counts as set up.
DELETE FROM "app"."settings"
WHERE "key" = 'setup.initialized.v1'
  OR ("key" = 'setup.owner.v1' AND "value"->>'state' IS DISTINCT FROM 'complete');--> statement-breakpoint
-- The sealed copies of every password go; FDRIVE_MASTER_KEY stays for the
-- secrets that still need it.
ALTER TABLE "app"."credentials" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "app"."credentials" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "identities_external_username_lower_unique" ON "app"."identities" USING btree (lower("external_username"));
