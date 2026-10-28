ALTER TABLE "tasks" DROP COLUMN "lead_preferences";
--> statement-breakpoint
UPDATE "task_session_links" SET "role" = 'working' WHERE "role" = 'lead';
