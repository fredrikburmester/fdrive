CREATE TABLE "app"."backup_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"label" text NOT NULL,
	"filename" text NOT NULL,
	"source_date" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bytes" text NOT NULL,
	"sha256" text NOT NULL,
	"secret" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."backup_configuration" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"installation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"recipient" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"challenge_hash" text,
	"challenge_expires_at" timestamp with time zone,
	"schedule" jsonb DEFAULT '{"frequency":"manual","timezone":"UTC","hour":3,"daily":7,"weekly":4,"monthly":12}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone,
	"restored" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."backup_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"destination_revision" uuid NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"object_key" text,
	"version_id" text,
	"verified_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "backup_delivery_run_destination" UNIQUE("run_id","destination_id")
);
--> statement-breakpoint
CREATE TABLE "app"."backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret" "bytea" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"tested_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"requested_by" uuid,
	"schedule_slot" text,
	"request" jsonb NOT NULL,
	"recipient" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"bytes" text DEFAULT '0' NOT NULL,
	"sha256" text,
	"error" text,
	"coverage" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"artifact" text,
	CONSTRAINT "backup_runs_schedule_slot_unique" UNIQUE("schedule_slot")
);
--> statement-breakpoint
ALTER TABLE "app"."backup_deliveries" ADD CONSTRAINT "backup_deliveries_run_id_backup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_deliveries_run_idx" ON "app"."backup_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "backup_runs_created_idx" ON "app"."backup_runs" USING btree ("created_at");