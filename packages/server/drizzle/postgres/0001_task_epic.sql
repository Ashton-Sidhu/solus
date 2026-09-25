ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_tasks_id_fk";
--> statement-breakpoint
DROP INDEX "tasks_parent";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "parent_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "epic" text;--> statement-breakpoint
DELETE FROM "task_events" WHERE "kind" = 'parent_changed';