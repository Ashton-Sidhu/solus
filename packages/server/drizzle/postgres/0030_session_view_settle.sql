ALTER TABLE "session_views" ADD COLUMN "settled_at" bigint;--> statement-breakpoint
-- A person's settle is now their own (docs/plans/session-archive.md). A settle
-- a person made before is kept for the session's owner, and leaves the shared state.
INSERT INTO "session_views" ("session_id", "person_key", "organization_id", "settled_at")
SELECT "session_states"."session_id", "session_records"."owner_key", "session_records"."organization_id", "session_states"."settled_at"
FROM "session_states" JOIN "session_records" ON "session_records"."session_id" = "session_states"."session_id"
WHERE "session_states"."settled_by" = 'person' AND "session_states"."settled_at" IS NOT NULL
ON CONFLICT ("session_id", "person_key") DO UPDATE SET "settled_at" = excluded."settled_at";--> statement-breakpoint
UPDATE "session_states" SET "settled_at" = NULL, "settled_by" = NULL WHERE "settled_by" = 'person';
