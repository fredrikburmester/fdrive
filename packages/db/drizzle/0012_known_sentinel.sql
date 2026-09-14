ALTER TABLE "app"."backup_runs" ADD COLUMN "verification_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."backup_runs" ADD COLUMN "verification_error" text;