-- Trash keeps each item in a folder of its own, /.trash/<id>/<name>, and
-- where it came from and when in this row. The API moves the items Trash's old
-- layout (/.trash/.fdrive-move-v1) still holds into it when it starts.
CREATE TABLE "app"."trash_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"original_path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"size" bigint NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"moving_from" text,
	CONSTRAINT "trash_items_kind" CHECK ("app"."trash_items"."kind" in ('file', 'dir'))
);
--> statement-breakpoint
ALTER TABLE "app"."trash_items" ADD CONSTRAINT "trash_items_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_items_identity_deleted" ON "app"."trash_items" USING btree ("identity_id","deleted_at");