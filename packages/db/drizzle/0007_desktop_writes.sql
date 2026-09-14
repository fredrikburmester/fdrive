CREATE TABLE "app"."desktop_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"metadata_version" uuid DEFAULT gen_random_uuid() NOT NULL,
	"content_version" text,
	"original_path" text,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."desktop_operations" (
	"id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_operations_identity_id_id_pk" PRIMARY KEY("identity_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."desktop_items" ADD CONSTRAINT "desktop_items_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desktop_operations" ADD CONSTRAINT "desktop_operations_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."desktop_operations" ADD CONSTRAINT "desktop_operations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_items_live_path" ON "app"."desktop_items" USING btree ("identity_id","path") WHERE "app"."desktop_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "desktop_items_identity" ON "app"."desktop_items" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "desktop_operations_cleanup" ON "app"."desktop_operations" USING btree ("state","updated_at");