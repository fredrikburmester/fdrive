CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "idx";
--> statement-breakpoint
CREATE TABLE "app"."accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"identity_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."credentials" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"key_id" text NOT NULL,
	"cached_token" text,
	"cached_token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."favorites" (
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_identity_id_path_pk" PRIMARY KEY("identity_id","path")
);
--> statement-breakpoint
CREATE TABLE "app"."file_tags" (
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "file_tags_identity_id_path_tag_id_pk" PRIMARY KEY("identity_id","path","tag_id")
);
--> statement-breakpoint
CREATE TABLE "app"."folder_views" (
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mode" text NOT NULL,
	"sort" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_views_identity_id_path_pk" PRIMARY KEY("identity_id","path")
);
--> statement-breakpoint
CREATE TABLE "app"."identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"external_username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "identities_provider_id_external_username_unique" UNIQUE("provider_id","external_username")
);
--> statement-breakpoint
CREATE TABLE "app"."image_embeddings" (
	"content_key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."office_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"root_name" text NOT NULL,
	"path" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_type_base_url_unique" UNIQUE("type","base_url")
);
--> statement-breakpoint
CREATE TABLE "app"."recents" (
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recents_identity_id_path_pk" PRIMARY KEY("identity_id","path")
);
--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"active_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "app"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"sftpgo_share_id" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"paths" text[] NOT NULL,
	"has_password" boolean DEFAULT false NOT NULL,
	"presentation" text DEFAULT 'auto' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "shares_identity_id_sftpgo_share_id_unique" UNIQUE("identity_id","sftpgo_share_id")
);
--> statement-breakpoint
CREATE TABLE "app"."system_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"subsystem" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "app"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	CONSTRAINT "tags_account_id_name_unique" UNIQUE("account_id","name")
);
--> statement-breakpoint
CREATE TABLE "app"."thumbnails" (
	"content_key" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"width" integer,
	"height" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thumbnails_content_key_size_pk" PRIMARY KEY("content_key","size")
);
--> statement-breakpoint
CREATE TABLE "app"."wopi_locks" (
	"file_id" text PRIMARY KEY NOT NULL,
	"lock_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idx"."chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"file_id" bigint NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', "text")) STORED,
	"embedding" vector(384)
);
--> statement-breakpoint
CREATE TABLE "idx"."events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now(),
	"root_id" smallint NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"target_path" text
);
--> statement-breakpoint
CREATE TABLE "idx"."files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"ext" text DEFAULT '' NOT NULL,
	"size" bigint NOT NULL,
	"mtime_ns" bigint NOT NULL,
	"sha256" text,
	"mime" text,
	"text_status" text DEFAULT 'pending' NOT NULL,
	"text_chars" integer DEFAULT 0 NOT NULL,
	"error" text,
	"first_seen" timestamp with time zone DEFAULT now(),
	"last_seen" timestamp with time zone DEFAULT now(),
	"indexed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "files_root_id_path_unique" UNIQUE("root_id","path")
);
--> statement-breakpoint
CREATE TABLE "idx"."moves" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now(),
	"root_id" smallint NOT NULL,
	"src" text,
	"dst" text,
	"actor" text
);
--> statement-breakpoint
CREATE TABLE "idx"."ocr_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"path" text NOT NULL,
	"size" bigint NOT NULL,
	"mtime_ns" bigint NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "ocr_log_root_id_path_size_mtime_ns_unique" UNIQUE("root_id","path","size","mtime_ns")
);
--> statement-breakpoint
CREATE TABLE "idx"."ocr_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"seen" integer DEFAULT 0 NOT NULL,
	"ocred" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idx"."roots" (
	"id" "smallserial" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "roots_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "idx"."scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"files_changed" integer DEFAULT 0 NOT NULL,
	"files_deleted" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idx"."schema_version" (
	"version" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."api_tokens" ADD CONSTRAINT "api_tokens_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credentials" ADD CONSTRAINT "credentials_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."favorites" ADD CONSTRAINT "favorites_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_tags" ADD CONSTRAINT "file_tags_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_tags" ADD CONSTRAINT "file_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "app"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."folder_views" ADD CONSTRAINT "folder_views_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identities" ADD CONSTRAINT "identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identities" ADD CONSTRAINT "identities_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."office_files" ADD CONSTRAINT "office_files_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."recents" ADD CONSTRAINT "recents_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_active_identity_id_identities_id_fk" FOREIGN KEY ("active_identity_id") REFERENCES "app"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD CONSTRAINT "shares_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tags" ADD CONSTRAINT "tags_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."chunks" ADD CONSTRAINT "chunks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "idx"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."events" ADD CONSTRAINT "events_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD CONSTRAINT "files_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."moves" ADD CONSTRAINT "moves_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."ocr_log" ADD CONSTRAINT "ocr_log_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idx"."scans" ADD CONSTRAINT "scans_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_tags_tag_id_idx" ON "app"."file_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "identities_account_id_idx" ON "app"."identities" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "office_files_active_location_unique" ON "app"."office_files" USING btree ("provider_id","root_name","path") WHERE "app"."office_files"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "recents_identity_id_opened_at_idx" ON "app"."recents" USING btree ("identity_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "app"."sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "system_events_subsystem_at_idx" ON "app"."system_events" USING btree ("subsystem","at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chunks_file_id_idx" ON "idx"."chunks" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "events_at_idx" ON "idx"."events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "files_sha256_idx" ON "idx"."files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "files_mtime_ns_idx" ON "idx"."files" USING btree ("mtime_ns");--> statement-breakpoint
CREATE INDEX "files_text_status_idx" ON "idx"."files" USING btree ("text_status");--> statement-breakpoint
CREATE INDEX "files_name_trgm_idx" ON "idx"."files" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "files_path_trgm_idx" ON "idx"."files" USING gin ("path" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "idx"."chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "chunks_embedding_hnsw_idx" ON "idx"."chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
INSERT INTO "idx"."schema_version" ("version") VALUES (1);--> statement-breakpoint
CREATE INDEX "image_embeddings_hnsw_idx" ON "app"."image_embeddings" USING hnsw ("embedding" vector_cosine_ops);
