-- Office keys a document by its owner's login and the owner's own path
-- instead of a provider row, index root and root-relative path. Rows only
-- give documents their WOPI ids, so they are dropped, not moved: every
-- document gets a new id the next time it is opened, and editor sessions
-- open before this release must be reopened.
DROP TABLE "app"."office_files" CASCADE;--> statement-breakpoint
CREATE TABLE "app"."office_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."office_files" ADD CONSTRAINT "office_files_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "office_files_identity_id_idx" ON "app"."office_files" USING btree ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "office_files_active_path_unique" ON "app"."office_files" USING btree ("identity_id","path") WHERE "app"."office_files"."deleted_at" is null;