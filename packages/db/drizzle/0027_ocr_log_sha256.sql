ALTER TABLE "idx"."ocr_log" ADD COLUMN "sha256" text;--> statement-breakpoint
CREATE INDEX "ocr_log_sha256_idx" ON "idx"."ocr_log" USING btree ("sha256");