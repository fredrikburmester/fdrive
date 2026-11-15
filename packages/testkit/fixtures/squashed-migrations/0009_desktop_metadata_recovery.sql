CREATE TABLE "app"."desktop_effects" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app"."favorites" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."file_tags" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."folder_views" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."office_files" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."recents" ADD COLUMN "revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."desktop_effects" ADD CONSTRAINT "desktop_effects_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desktop_effects" ADD CONSTRAINT "desktop_effects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desktop_effects" ADD CONSTRAINT "desktop_effects_identity_id_operation_id_desktop_operations_identity_id_id_fk" FOREIGN KEY ("identity_id","operation_id") REFERENCES "app"."desktop_operations"("identity_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_effects_operation" ON "app"."desktop_effects" USING btree ("identity_id","operation_id");--> statement-breakpoint
CREATE INDEX "desktop_effects_pending" ON "app"."desktop_effects" USING btree ("next_attempt_at","sequence") WHERE "app"."desktop_effects"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "desktop_effects_identity_pending" ON "app"."desktop_effects" USING btree ("identity_id","sequence") WHERE "app"."desktop_effects"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "desktop_effects_account" ON "app"."desktop_effects" USING btree ("account_id");