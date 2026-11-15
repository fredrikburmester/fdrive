CREATE TABLE "idx"."work" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"path" text NOT NULL,
	"target_path" text,
	"sha256" text,
	"size" bigint,
	"mtime_ns" bigint,
	"inode" bigint,
	"ctime_ns" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idx"."work" ADD CONSTRAINT "work_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_root_id_id_idx" ON "idx"."work" USING btree ("root_id","id");--> statement-breakpoint
CREATE INDEX "work_created_at_idx" ON "idx"."work" USING btree ("created_at");