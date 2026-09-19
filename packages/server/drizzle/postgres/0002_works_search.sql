-- The works search index on Postgres (packages/server/src/db/search-index.ts):
-- a stored tsvector generated from the title (weight A) and content (weight B)
-- under a GIN index. Generated, so every write keeps it in step with no trigger.
ALTER TABLE "works" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A')
  || setweight(to_tsvector('english', coalesce("content", '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING GIN ("search");
