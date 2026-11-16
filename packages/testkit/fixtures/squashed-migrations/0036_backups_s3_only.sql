-- Backups go to S3-compatible buckets or a browser download only. Destinations
-- in the files folder go with their delivery records; the archives they wrote
-- stay where they are, ordinary files in their owner's folder. Configuration
-- ZIP attachments go with their table and the record of which backup holds
-- which version.
DELETE FROM "app"."backup_deliveries" WHERE "destination_id" IN (
  SELECT "id" FROM "app"."backup_destinations" WHERE "type" <> 's3'
);--> statement-breakpoint
DELETE FROM "app"."backup_destinations" WHERE "type" <> 's3';--> statement-breakpoint
DELETE FROM "app"."settings" WHERE "key" LIKE 'backup.inventory.%';--> statement-breakpoint
DROP TABLE "app"."backup_attachments" CASCADE;
