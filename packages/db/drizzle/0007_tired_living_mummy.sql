CREATE TABLE "app"."folder_views" (
	"identity_id" uuid NOT NULL,
	"path" text NOT NULL,
	"mode" text NOT NULL,
	"sort" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_views_identity_id_path_pk" PRIMARY KEY("identity_id","path")
);
--> statement-breakpoint
ALTER TABLE "app"."folder_views" ADD CONSTRAINT "folder_views_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "app"."identities"("id") ON DELETE cascade ON UPDATE no action;