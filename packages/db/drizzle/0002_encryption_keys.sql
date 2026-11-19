CREATE TABLE "app"."encryption_device_keys" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"identity_id" uuid NOT NULL,
	"device_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."encryption_keys" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"password_key" text NOT NULL,
	"recovery_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."encryption_device_keys" ADD CONSTRAINT "encryption_device_keys_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "app"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."encryption_device_keys" ADD CONSTRAINT "encryption_device_keys_identity_id_encryption_keys_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."encryption_keys"("identity_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."encryption_keys" ADD CONSTRAINT "encryption_keys_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "encryption_device_keys_identity" ON "app"."encryption_device_keys" USING btree ("identity_id");