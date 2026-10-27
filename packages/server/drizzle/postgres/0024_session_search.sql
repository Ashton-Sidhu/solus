ALTER TABLE "session_transcripts" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE INDEX session_transcripts_search_pending ON session_transcripts(session_id) WHERE search_text = '';
--> statement-breakpoint
DROP INDEX "session_transcripts_search_idx";
--> statement-breakpoint
ALTER TABLE "session_transcripts" DROP COLUMN "search";
--> statement-breakpoint
ALTER TABLE "session_transcripts" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "search_text")) STORED;
--> statement-breakpoint
CREATE INDEX "session_transcripts_search_idx" ON "session_transcripts" USING GIN ("search");
