CREATE TABLE "app"."activity_event_subjects" (
	"owner_account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"file_id" uuid,
	"role" text NOT NULL,
	"subject_ordinal" integer NOT NULL,
	"virtual_path_snapshot" text,
	"revision_id" uuid,
	CONSTRAINT "activity_event_subjects_event_id_identity_id_role_subject_ordinal_pk" PRIMARY KEY("event_id","identity_id","role","subject_ordinal")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"owner_sequence" bigint NOT NULL,
	"actor_account_id" uuid,
	"identity_id" uuid NOT NULL,
	"file_id" uuid,
	"class" text NOT NULL,
	"action" text NOT NULL,
	"stage" text NOT NULL,
	"outcome" text,
	"source" text NOT NULL,
	"evidence" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"operation_id" uuid,
	"producer_operation_id" text,
	"batch_id" uuid,
	"parent_event_id" uuid,
	"occurred_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sort_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	"detected_at" timestamp with time zone,
	"before" jsonb,
	"after" jsonb,
	"detail" jsonb,
	"safe_error_code" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone,
	"last_at" timestamp with time zone,
	"outcome_counts" jsonb,
	"idempotency_key" text NOT NULL,
	CONSTRAINT "activity_events_owner_id" UNIQUE("owner_account_id","id"),
	CONSTRAINT "activity_events_owner_sequence" UNIQUE("owner_account_id","owner_sequence"),
	CONSTRAINT "activity_events_dedupe" UNIQUE("owner_account_id","identity_id","idempotency_key"),
	CONSTRAINT "activity_events_actor" CHECK (("app"."activity_events"."class" = 'action' and "app"."activity_events"."actor_account_id" = "app"."activity_events"."owner_account_id") or ("app"."activity_events"."class" = 'observation' and "app"."activity_events"."actor_account_id" is null)),
	CONSTRAINT "activity_events_actor_required" CHECK ("app"."activity_events"."class" <> 'action' or "app"."activity_events"."actor_account_id" is not null),
	CONSTRAINT "activity_events_payload_budget" CHECK (octet_length(coalesce("app"."activity_events"."before"::text,'') || coalesce("app"."activity_events"."after"::text,'') || coalesce("app"."activity_events"."detail"::text,'')) <= 16384)
);
--> statement-breakpoint
CREATE TABLE "app"."activity_export_reads" (
	"export_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "activity_export_reads_owner_account_id_export_id_window_id_pk" PRIMARY KEY("owner_account_id","export_id","window_id")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"format" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"filters" jsonb NOT NULL,
	"snapshot_sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"safe_error_code" text
);
--> statement-breakpoint
CREATE TABLE "app"."activity_file_bridges" (
	"identity_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "activity_file_bridges_identity_id_namespace_external_id_pk" PRIMARY KEY("identity_id","namespace","external_id")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_file_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"virtual_path" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"generation" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."activity_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"virtual_path" text NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"revision_id" uuid,
	"state" text DEFAULT 'live' NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fingerprint" text,
	CONSTRAINT "activity_files_identity_id_unique" UNIQUE("identity_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_lineage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source_file_id" uuid NOT NULL,
	"source_identity_id" uuid NOT NULL,
	"target_file_id" uuid NOT NULL,
	"target_identity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"evidence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."activity_observation_state" (
	"owner_account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"prior_generation" bigint NOT NULL,
	"discrepancy" text NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"event_id" uuid,
	"resolved_event_id" uuid,
	"last_check_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone,
	"detected_at" timestamp with time zone,
	"check_error" text,
	CONSTRAINT "activity_observation_state_owner_account_id_identity_id_file_id_prior_generation_discrepancy_pk" PRIMARY KEY("owner_account_id","identity_id","file_id","prior_generation","discrepancy")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"actor_account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"request_digest" text NOT NULL,
	"producer_operation_id" text NOT NULL,
	"batch_id" uuid,
	"parent_operation_id" uuid,
	"file_id" uuid,
	"file_generation" bigint,
	"revision_id" uuid,
	"state" text NOT NULL,
	"before" jsonb,
	"requested" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_event_id" uuid,
	CONSTRAINT "activity_operations_dedupe" UNIQUE("owner_account_id","identity_id","source","producer_operation_id"),
	CONSTRAINT "activity_operations_actor" CHECK ("app"."activity_operations"."owner_account_id" = "app"."activity_operations"."actor_account_id")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"owner_sequence" bigint NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."activity_read_receipts" (
	"owner_account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"context_hash" text NOT NULL,
	"request_id" uuid NOT NULL,
	"window_id" uuid NOT NULL,
	"outcome" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "activity_read_receipts_owner_account_id_identity_id_context_hash_request_id_pk" PRIMARY KEY("owner_account_id","identity_id","context_hash","request_id")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_read_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"action" text NOT NULL,
	"source" text NOT NULL,
	"context_hash" text NOT NULL,
	"evidence" text NOT NULL,
	"file_generation" bigint NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"virtual_path" text NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"attempted_count" integer NOT NULL,
	"outcome_counts" jsonb NOT NULL,
	"sealed_at" timestamp with time zone,
	CONSTRAINT "activity_read_window_key" UNIQUE("owner_account_id","identity_id","file_id","action","source","context_hash","file_generation","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "app"."activity_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"provider_version" text,
	"sha256" text,
	"size" bigint,
	"previous_revision_id" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."activity_storage_identities" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"provider_type" text NOT NULL,
	"label" text NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."activity_streams" (
	"owner_account_id" uuid PRIMARY KEY NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"retained_from" timestamp with time zone,
	"history_starts_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."activity_trash_bindings" (
	"file_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"original_virtual_path" text NOT NULL,
	"trash_virtual_leaf" text,
	"state" text NOT NULL,
	CONSTRAINT "activity_trash_bindings_event_id_file_id_pk" PRIMARY KEY("event_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "app"."activity_event_subjects" ADD CONSTRAINT "activity_event_subjects_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_event_subjects" ADD CONSTRAINT "activity_event_subjects_owner_account_id_event_id_activity_events_owner_account_id_id_fk" FOREIGN KEY ("owner_account_id","event_id") REFERENCES "app"."activity_events"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_event_subjects" ADD CONSTRAINT "activity_event_subjects_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_events" ADD CONSTRAINT "activity_events_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_events" ADD CONSTRAINT "activity_events_identity_id_activity_storage_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."activity_storage_identities"("identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_export_reads" ADD CONSTRAINT "activity_export_reads_export_id_activity_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "app"."activity_exports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_export_reads" ADD CONSTRAINT "activity_export_reads_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_exports" ADD CONSTRAINT "activity_exports_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_file_bridges" ADD CONSTRAINT "activity_file_bridges_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_file_locations" ADD CONSTRAINT "activity_file_locations_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_files" ADD CONSTRAINT "activity_files_identity_id_activity_storage_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."activity_storage_identities"("identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_lineage" ADD CONSTRAINT "activity_lineage_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_lineage" ADD CONSTRAINT "activity_lineage_owner_account_id_event_id_activity_events_owner_account_id_id_fk" FOREIGN KEY ("owner_account_id","event_id") REFERENCES "app"."activity_events"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_lineage" ADD CONSTRAINT "activity_lineage_source_identity_id_source_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("source_identity_id","source_file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_lineage" ADD CONSTRAINT "activity_lineage_target_identity_id_target_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("target_identity_id","target_file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_observation_state" ADD CONSTRAINT "activity_observation_state_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_observation_state" ADD CONSTRAINT "activity_observation_state_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_operations" ADD CONSTRAINT "activity_operations_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_operations" ADD CONSTRAINT "activity_operations_identity_id_activity_storage_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."activity_storage_identities"("identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_outbox" ADD CONSTRAINT "activity_outbox_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_outbox" ADD CONSTRAINT "activity_outbox_owner_account_id_event_id_activity_events_owner_account_id_id_fk" FOREIGN KEY ("owner_account_id","event_id") REFERENCES "app"."activity_events"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_read_receipts" ADD CONSTRAINT "activity_read_receipts_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_read_receipts" ADD CONSTRAINT "activity_read_receipts_window_id_activity_read_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "app"."activity_read_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_read_windows" ADD CONSTRAINT "activity_read_windows_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_read_windows" ADD CONSTRAINT "activity_read_windows_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_revisions" ADD CONSTRAINT "activity_revisions_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_revisions" ADD CONSTRAINT "activity_revisions_owner_account_id_event_id_activity_events_owner_account_id_id_fk" FOREIGN KEY ("owner_account_id","event_id") REFERENCES "app"."activity_events"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_revisions" ADD CONSTRAINT "activity_revisions_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_streams" ADD CONSTRAINT "activity_streams_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_trash_bindings" ADD CONSTRAINT "activity_trash_bindings_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_trash_bindings" ADD CONSTRAINT "activity_trash_bindings_owner_account_id_event_id_activity_events_owner_account_id_id_fk" FOREIGN KEY ("owner_account_id","event_id") REFERENCES "app"."activity_events"("owner_account_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."activity_trash_bindings" ADD CONSTRAINT "activity_trash_bindings_identity_id_file_id_activity_files_identity_id_id_fk" FOREIGN KEY ("identity_id","file_id") REFERENCES "app"."activity_files"("identity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_subjects_file" ON "app"."activity_event_subjects" USING btree ("owner_account_id","file_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_subjects_path" ON "app"."activity_event_subjects" USING btree ("owner_account_id","virtual_path_snapshot");--> statement-breakpoint
CREATE INDEX "activity_subjects_path_search" ON "app"."activity_event_subjects" USING gin ("virtual_path_snapshot" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "activity_subjects_event_page" ON "app"."activity_event_subjects" USING btree ("owner_account_id","event_id","subject_ordinal");--> statement-breakpoint
CREATE INDEX "activity_subjects_file_fk" ON "app"."activity_event_subjects" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_events_feed" ON "app"."activity_events" USING btree ("owner_account_id","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_location" ON "app"."activity_events" USING btree ("owner_account_id","identity_id","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_file" ON "app"."activity_events" USING btree ("owner_account_id","file_id","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_batch" ON "app"."activity_events" USING btree ("owner_account_id","batch_id","sort_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_events_identity" ON "app"."activity_events" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "activity_export_reads_export" ON "app"."activity_export_reads" USING btree ("export_id");--> statement-breakpoint
CREATE INDEX "activity_exports_owner" ON "app"."activity_exports" USING btree ("owner_account_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_bridges_file" ON "app"."activity_file_bridges" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "activity_bridges_file_fk" ON "app"."activity_file_bridges" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_locations_file" ON "app"."activity_file_locations" USING btree ("file_id","valid_from");--> statement-breakpoint
CREATE INDEX "activity_locations_file_fk" ON "app"."activity_file_locations" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "activity_files_live_path" ON "app"."activity_files" USING btree ("identity_id","virtual_path") WHERE "app"."activity_files"."state" = 'live';--> statement-breakpoint
CREATE INDEX "activity_lineage_source" ON "app"."activity_lineage" USING btree ("owner_account_id","source_file_id");--> statement-breakpoint
CREATE INDEX "activity_lineage_target" ON "app"."activity_lineage" USING btree ("owner_account_id","target_file_id");--> statement-breakpoint
CREATE INDEX "activity_lineage_event" ON "app"."activity_lineage" USING btree ("owner_account_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_lineage_source_fk" ON "app"."activity_lineage" USING btree ("source_identity_id","source_file_id");--> statement-breakpoint
CREATE INDEX "activity_lineage_target_fk" ON "app"."activity_lineage" USING btree ("target_identity_id","target_file_id");--> statement-breakpoint
CREATE INDEX "activity_observation_file_fk" ON "app"."activity_observation_state" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_operations_recovery" ON "app"."activity_operations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "activity_operations_identity" ON "app"."activity_operations" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "activity_outbox_pending" ON "app"."activity_outbox" USING btree ("delivered_at","available_at");--> statement-breakpoint
CREATE INDEX "activity_outbox_owner_sequence" ON "app"."activity_outbox" USING btree ("owner_account_id","owner_sequence");--> statement-breakpoint
CREATE INDEX "activity_outbox_event" ON "app"."activity_outbox" USING btree ("owner_account_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_read_receipts_expiry" ON "app"."activity_read_receipts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "activity_read_receipts_window" ON "app"."activity_read_receipts" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "activity_read_windows_seal" ON "app"."activity_read_windows" USING btree ("sealed_at","bucket_start");--> statement-breakpoint
CREATE INDEX "activity_read_windows_file_fk" ON "app"."activity_read_windows" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_revisions_file" ON "app"."activity_revisions" USING btree ("owner_account_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_revisions_event" ON "app"."activity_revisions" USING btree ("owner_account_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_revisions_file_fk" ON "app"."activity_revisions" USING btree ("identity_id","file_id");--> statement-breakpoint
CREATE INDEX "activity_trash_leaf" ON "app"."activity_trash_bindings" USING btree ("identity_id","trash_virtual_leaf");--> statement-breakpoint
CREATE INDEX "activity_trash_event" ON "app"."activity_trash_bindings" USING btree ("owner_account_id","event_id");--> statement-breakpoint
CREATE INDEX "activity_trash_file_fk" ON "app"."activity_trash_bindings" USING btree ("identity_id","file_id");