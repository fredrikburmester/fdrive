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
ALTER TABLE "idx"."ocr_log" ADD CONSTRAINT "ocr_log_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE no action ON UPDATE no action;