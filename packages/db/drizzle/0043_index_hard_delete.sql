DELETE FROM "idx"."files" WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "idx"."files" DROP COLUMN "deleted_at";