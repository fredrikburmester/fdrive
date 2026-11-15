-- A token made before access levels existed has no access; it is deleted and
-- its owner creates a new one. MCP's move log is dropped: personal activity
-- records MCP moves.
DELETE FROM "app"."api_tokens" WHERE "access" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ALTER COLUMN "access" SET NOT NULL;--> statement-breakpoint
DROP TABLE "idx"."moves" CASCADE;
