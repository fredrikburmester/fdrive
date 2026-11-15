DELETE FROM "app"."activity_trash_bindings" WHERE "trash_virtual_leaf" IS NULL;--> statement-breakpoint
ALTER TABLE "app"."activity_trash_bindings" ALTER COLUMN "trash_virtual_leaf" SET NOT NULL;--> statement-breakpoint
DELETE FROM "app"."settings" WHERE "key" LIKE 'trash.configuration.%';
