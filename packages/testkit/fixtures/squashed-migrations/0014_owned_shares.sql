ALTER TABLE "app"."shares" ALTER COLUMN "sftpgo_share_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD COLUMN "max_downloads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."shares" ADD CONSTRAINT "shares_password_hash_kind" CHECK (("app"."shares"."sftpgo_share_id" is null and "app"."shares"."has_password" = ("app"."shares"."password_hash" is not null)) or ("app"."shares"."sftpgo_share_id" is not null and "app"."shares"."password_hash" is null));