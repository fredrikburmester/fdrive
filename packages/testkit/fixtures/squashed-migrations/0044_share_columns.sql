-- Links SFTPGo kept the passwords of hold a hash nothing verifies: they go.
DELETE FROM "app"."shares" WHERE "password_hash" = 'locked$sftpgo';--> statement-breakpoint
ALTER TABLE "app"."shares" DROP CONSTRAINT "shares_password_hash_kind";--> statement-breakpoint
ALTER TABLE "app"."shares" DROP COLUMN "has_password";--> statement-breakpoint
ALTER TABLE "app"."shares" RENAME COLUMN "views" TO "used_downloads";
