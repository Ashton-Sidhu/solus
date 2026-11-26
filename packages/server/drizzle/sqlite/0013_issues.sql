-- Tasks are issues: the host's copy of GitHub, Jira and Linear issues. The stored
-- 'task' kind values are changed to 'issue' by a one-time script, not here.
ALTER TABLE `tasks` RENAME TO `issues`;--> statement-breakpoint
ALTER TABLE `task_sources` RENAME TO `issue_sources`;--> statement-breakpoint
ALTER TABLE `task_source_items` RENAME TO `issue_source_items`;--> statement-breakpoint
ALTER TABLE `issue_source_items` RENAME COLUMN `task_id` TO `issue_id`;--> statement-breakpoint
DROP INDEX `task_source_items_task`;--> statement-breakpoint
CREATE INDEX `issue_source_items_issue` ON `issue_source_items` (`issue_id`);--> statement-breakpoint
ALTER TABLE `task_source_access` RENAME TO `issue_source_access`;--> statement-breakpoint
DROP INDEX `resource_links_working_owner`;--> statement-breakpoint
CREATE UNIQUE INDEX `resource_links_working_owner` ON `resource_links` (`organization_id`,`target_key`) WHERE source_kind = 'issue' AND target_kind = 'session' AND relation = 'works-on' AND status = 'active';--> statement-breakpoint
DROP INDEX `comment_threads_task_order`;--> statement-breakpoint
CREATE INDEX `comment_threads_issue_order` ON `comment_threads` (`organization_id`,`subject_kind`,`subject_id`,`subject_part`,`created_at`,`thread_id`) WHERE subject_kind = 'issue';
