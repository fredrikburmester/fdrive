CREATE TABLE "idx"."change_epoch" (
	"single" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_epoch_single" CHECK ("idx"."change_epoch"."single")
);
