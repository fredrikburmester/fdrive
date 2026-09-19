CREATE TABLE "app"."ai_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"references" jsonb NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chat_messages_chat_ordinal" UNIQUE("chat_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "app"."ai_chat_references" (
	"chat_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"missing" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_chat_references_chat_id_path_pk" PRIMARY KEY("chat_id","path")
);
--> statement-breakpoint
CREATE TABLE "app"."ai_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"share" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_chat_id_ai_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "app"."ai_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_references" ADD CONSTRAINT "ai_chat_references_chat_id_ai_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "app"."ai_chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_chat_references" ADD CONSTRAINT "ai_chat_references_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_chats" ADD CONSTRAINT "ai_chats_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_chat_references_identity_path_idx" ON "app"."ai_chat_references" USING btree ("identity_id","path");--> statement-breakpoint
CREATE INDEX "ai_chats_identity_last_message_idx" ON "app"."ai_chats" USING btree ("identity_id","last_message_at");