ALTER TABLE "app"."office_files" DROP CONSTRAINT "office_files_provider_id_providers_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."providers" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."providers" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."providers" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."providers" ADD COLUMN "managed_by_env" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."office_files" ADD CONSTRAINT "office_files_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE cascade ON UPDATE no action;