CREATE TABLE "idx"."folders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"path" text NOT NULL,
	"name" text NOT NULL,
	"mtime_ns" bigint NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_root_id_path_unique" UNIQUE("root_id","path")
);
--> statement-breakpoint
ALTER TABLE "idx"."folders" ADD CONSTRAINT "folders_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_name_trgm_idx" ON "idx"."folders" USING gin ("name" gin_trgm_ops);