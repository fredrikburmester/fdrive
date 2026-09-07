CREATE TABLE "app"."image_embeddings" (
	"content_key" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "image_embeddings_hnsw_idx" ON "app"."image_embeddings" USING hnsw ("embedding" vector_cosine_ops);
