-- Every resource has one owner on its own row (docs/plans/access-model.md §2.2):
-- `owner_key`, taken from the owner row of `share_grant`, then from the session
-- record's `owner_user_id`. A row that had neither keeps '', which no person
-- holds. The owner rows go, and `share_grant` becomes `acl_entry`: only what an
-- owner gave to others.
ALTER TABLE "share_grant" RENAME TO "acl_entry";--> statement-breakpoint
DROP INDEX "share_grant_owner";--> statement-breakpoint
ALTER INDEX "share_grant_subject" RENAME TO "acl_entry_subject";--> statement-breakpoint
ALTER INDEX "share_grant_secret_idx" RENAME TO "acl_entry_secret_idx";--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "owner_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "works" SET "owner_key" = COALESCE((SELECT "subject_id" FROM "acl_entry" WHERE "resource_kind" = 'work' AND "resource_id" = "works"."id" AND "role" = 'owner'), '');--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "owner_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "owner_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "owner_key" = COALESCE((SELECT "subject_id" FROM "acl_entry" WHERE "resource_kind" = 'task' AND "resource_id" = "tasks"."id" AND "role" = 'owner'), '');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "owner_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "owner_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "session_records" SET "owner_key" = COALESCE((SELECT "subject_id" FROM "acl_entry" WHERE "resource_kind" = 'session' AND "resource_id" = "session_records"."session_id" AND "role" = 'owner'), "owner_user_id", '');--> statement-breakpoint
ALTER TABLE "session_records" ALTER COLUMN "owner_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "session_records" DROP COLUMN "owner_user_id";--> statement-breakpoint
ALTER TABLE "session_admissions" RENAME COLUMN "owner_user_id" TO "owner_key";--> statement-breakpoint
DELETE FROM "acl_entry" WHERE "role" = 'owner';
