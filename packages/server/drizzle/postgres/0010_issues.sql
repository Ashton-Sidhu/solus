-- Tasks are issues: the host's copy of GitHub, Jira and Linear issues. The stored
-- 'task' kind values are changed to 'issue' by a one-time script, not here.
ALTER TABLE "tasks" RENAME TO "issues";--> statement-breakpoint
ALTER INDEX IF EXISTS "tasks_pkey" RENAME TO "issues_pkey";--> statement-breakpoint
ALTER TABLE "task_sources" RENAME TO "issue_sources";--> statement-breakpoint
ALTER INDEX IF EXISTS "task_sources_pkey" RENAME TO "issue_sources_pkey";--> statement-breakpoint
ALTER TABLE "task_source_items" RENAME TO "issue_source_items";--> statement-breakpoint
ALTER TABLE "issue_source_items" RENAME COLUMN "task_id" TO "issue_id";--> statement-breakpoint
ALTER TABLE "issue_source_items" RENAME CONSTRAINT "task_source_items_source_key_task_id_pk" TO "issue_source_items_source_key_issue_id_pk";--> statement-breakpoint
ALTER INDEX "task_source_items_task" RENAME TO "issue_source_items_issue";--> statement-breakpoint
ALTER TABLE "task_source_access" RENAME TO "issue_source_access";--> statement-breakpoint
ALTER TABLE "issue_source_access" RENAME CONSTRAINT "task_source_access_user_id_source_key_pk" TO "issue_source_access_user_id_source_key_pk";--> statement-breakpoint
DROP INDEX "resource_links_working_owner";--> statement-breakpoint
CREATE UNIQUE INDEX "resource_links_working_owner" ON "resource_links" USING btree ("organization_id","target_key") WHERE source_kind = 'issue' AND target_kind = 'session' AND relation = 'works-on' AND status = 'active';--> statement-breakpoint
DROP INDEX "comment_threads_task_order";--> statement-breakpoint
CREATE INDEX "comment_threads_issue_order" ON "comment_threads" USING btree ("organization_id","subject_kind","subject_id","subject_part","created_at","thread_id") WHERE subject_kind = 'issue';
