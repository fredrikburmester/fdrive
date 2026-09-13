CREATE TABLE "idx"."processing_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"root_id" smallint NOT NULL,
	"path" text NOT NULL,
	"feature" text NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"operation_id" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"first_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "processing_failures_root_path_feature_unique" UNIQUE("root_id","path","feature")
);
--> statement-breakpoint
ALTER TABLE "idx"."processing_failures" ADD CONSTRAINT "processing_failures_root_id_roots_id_fk" FOREIGN KEY ("root_id") REFERENCES "idx"."roots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processing_failures_feature_resolved_id_idx" ON "idx"."processing_failures" USING btree ("feature","resolved_at","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "processing_failures_resolved_idx" ON "idx"."processing_failures" USING btree ("resolved_at");