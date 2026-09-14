ALTER TABLE "app"."backup_deliveries" ADD COLUMN "marker_version_id" text;--> statement-breakpoint
ALTER TABLE "app"."backup_deliveries" ADD COLUMN "retention_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."backup_runs" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."backup_runs" ADD COLUMN "verified_at" timestamp with time zone;