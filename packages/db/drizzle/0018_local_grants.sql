CREATE TABLE "app"."local_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_username" text NOT NULL,
	"path" text NOT NULL,
	"grantee_username" text NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_grants_owner_path_grantee_unique" UNIQUE("owner_username","path","grantee_username"),
	CONSTRAINT "local_grants_access" CHECK ("app"."local_grants"."access" in ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "app"."local_grants" ADD CONSTRAINT "local_grants_owner_username_local_users_username_fk" FOREIGN KEY ("owner_username") REFERENCES "app"."local_users"("username") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "app"."local_grants" ADD CONSTRAINT "local_grants_grantee_username_local_users_username_fk" FOREIGN KEY ("grantee_username") REFERENCES "app"."local_users"("username") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "local_grants_grantee_username_idx" ON "app"."local_grants" USING btree ("grantee_username");