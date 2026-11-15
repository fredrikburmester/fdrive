DROP TABLE "app"."desktop_effects" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."desktop_items" DROP COLUMN "content_version";--> statement-breakpoint
ALTER TABLE "app"."favorites" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "app"."file_tags" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "app"."folder_views" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "app"."office_files" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "app"."recents" DROP COLUMN "revision";