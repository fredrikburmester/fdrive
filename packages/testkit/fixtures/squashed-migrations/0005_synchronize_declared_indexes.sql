-- The five search indexes already exist from 0000 raw SQL. Register them
-- in the generated schema snapshot without rebuilding existing indexes.
CREATE INDEX IF NOT EXISTS "image_embeddings_hnsw_idx" ON "app"."image_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wopi_locks_expires_at_idx" ON "app"."wopi_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_tsv_idx" ON "idx"."chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx" ON "idx"."chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_name_trgm_idx" ON "idx"."files" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_path_trgm_idx" ON "idx"."files" USING gin ("path" gin_trgm_ops);