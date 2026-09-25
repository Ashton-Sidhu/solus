ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_tasks_id_fk";
--> statement-breakpoint
DROP INDEX "tasks_parent";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "parent_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "kind";