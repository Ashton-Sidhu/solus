-- The owner moves into share_grant as a `user` row with role `owner`. A named row
-- the owner also held gives way to it.
DELETE FROM "share_grant" WHERE "subject_kind" = 'user' AND EXISTS (
  SELECT 1 FROM "resource_owner" AS o
  WHERE o."resource_kind" = "share_grant"."resource_kind" AND o."resource_id" = "share_grant"."resource_id" AND o."owner_user_id" = "share_grant"."subject_id"
);--> statement-breakpoint
INSERT INTO "share_grant" ("id", "resource_kind", "resource_id", "subject_kind", "subject_id", "role", "link_secret_hash", "link_secret", "granted_by_user_id", "created_at", "organization_id")
SELECT 'owner:' || "resource_kind" || ':' || "resource_id", "resource_kind", "resource_id", 'user', "owner_user_id", 'owner', NULL, NULL, "owner_user_id", "created_at", "organization_id"
FROM "resource_owner";--> statement-breakpoint
ALTER TABLE "resource_owner" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "resource_owner" CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "share_grant_owner" ON "share_grant" USING btree ("resource_kind","resource_id") WHERE role = 'owner';
