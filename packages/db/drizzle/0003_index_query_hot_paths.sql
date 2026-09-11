CREATE INDEX "moves_root_id_idx" ON "idx"."moves" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "ocr_log_status_at_idx" ON "idx"."ocr_log" USING btree ("status","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scans_root_id_started_at_idx" ON "idx"."scans" USING btree ("root_id","started_at" DESC NULLS LAST);