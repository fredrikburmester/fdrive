CREATE TABLE "app"."office_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"root_name" text NOT NULL,
	"path" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."office_files" ADD CONSTRAINT "office_files_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "office_files_active_location_unique" ON "app"."office_files" USING btree ("provider_id","root_name","path") WHERE "app"."office_files"."deleted_at" is null;