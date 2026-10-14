ALTER TABLE "session_states" ADD COLUMN "archived_at" bigint;--> statement-breakpoint
-- Archive the sessions that had no activity for 30 days and wait on no pull
-- request, once, before any client reads the list (docs/plans/session-archive.md).
-- The idle sweep in PR sync archives the later ones.
INSERT INTO "session_states" ("session_id", "organization_id")
SELECT "session_id", "organization_id" FROM "session_records"
WHERE "last_activity_at" < (extract(epoch from now()) * 1000)::bigint - 2592000000
ON CONFLICT ("session_id") DO NOTHING;--> statement-breakpoint
UPDATE "session_states" SET "archived_at" = (extract(epoch from now()) * 1000)::bigint
WHERE "archived_at" IS NULL
  AND "session_id" IN (
    SELECT "session_id" FROM "session_records"
    WHERE "last_activity_at" < (extract(epoch from now()) * 1000)::bigint - 2592000000
  )
  AND COALESCE("last_prompt_at", 0) < (extract(epoch from now()) * 1000)::bigint - 2592000000
  AND COALESCE("unsettled_at", 0) < (extract(epoch from now()) * 1000)::bigint - 2592000000
  AND ("snoozed_until" IS NULL OR "snoozed_until" <= (extract(epoch from now()) * 1000)::bigint)
  AND NOT EXISTS (
    SELECT 1 FROM "session_pull_requests"
    WHERE "session_pull_requests"."session_id" = "session_states"."session_id"
      AND "session_pull_requests"."source" <> 'dismissed'
      AND ("session_pull_requests"."pr_state" IS NULL OR "session_pull_requests"."pr_state" NOT IN ('merged', 'closed', 'missing'))
  );
