ALTER TABLE "indexed_plans" ADD COLUMN "thread_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "indexed_plans_by_thread" ON "indexed_plans" USING btree ("provider","thread_id");--> statement-breakpoint
-- Rows written before this held the thread in session_id (docs/plans/session-identity.md).
UPDATE "indexed_plans" SET "thread_id" = "session_id";