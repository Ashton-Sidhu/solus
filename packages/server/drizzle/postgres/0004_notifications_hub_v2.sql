ALTER TABLE "notification_changes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_journal" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "notification_changes" CASCADE;--> statement-breakpoint
DROP TABLE "notification_journal" CASCADE;--> statement-breakpoint
DROP INDEX "notifications_for_recipient";--> statement-breakpoint
CREATE INDEX "notifications_for_recipient" ON "notifications" USING btree ("recipient_key","created_at","id");--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "resolved_at";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "resolution";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "revision";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "read_revision";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "archived_revision";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "last_operation_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "position";