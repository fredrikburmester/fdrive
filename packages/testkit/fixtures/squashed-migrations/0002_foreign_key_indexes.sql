CREATE INDEX "api_tokens_account_id_idx" ON "app"."api_tokens" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "api_tokens_identity_id_idx" ON "app"."api_tokens" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "office_files_provider_id_idx" ON "app"."office_files" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "app"."sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_active_identity_id_idx" ON "app"."sessions" USING btree ("active_identity_id");