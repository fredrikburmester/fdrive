CREATE TABLE "app"."system_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"subsystem" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE INDEX "system_events_subsystem_at_idx" ON "app"."system_events" USING btree ("subsystem","at" DESC NULLS LAST,"id" DESC NULLS LAST);