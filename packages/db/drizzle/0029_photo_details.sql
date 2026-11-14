ALTER TABLE "idx"."files" ADD COLUMN "taken_at" timestamp;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD COLUMN "camera" text;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "idx"."files" ADD COLUMN "longitude" double precision;