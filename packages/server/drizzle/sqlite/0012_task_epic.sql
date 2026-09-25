PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` integer,
	`project_key` text,
	`title` text NOT NULL,
	`title_source` text DEFAULT 'prompt' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`assignee` text,
	`due_date` text,
	`priority` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`pr` text,
	`epic` text,
	`source` text DEFAULT 'user' NOT NULL,
	`origin_session_id` text,
	`origin_automation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`triaged_at` integer,
	`done_at` integer,
	`last_read_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "short_id", "project_key", "title", "title_source", "body", "status", "assignee", "due_date", "priority", "labels", "pr", "source", "origin_session_id", "origin_automation_id", "created_at", "updated_at", "triaged_at", "done_at", "last_read_at", "organization_id") SELECT "id", "short_id", "project_key", "title", "title_source", "body", "status", "assignee", "due_date", "priority", "labels", "pr", "source", "origin_session_id", "origin_automation_id", "created_at", "updated_at", "triaged_at", "done_at", "last_read_at", "organization_id" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_short_id_unique` ON `tasks` (`short_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_by_project` ON `tasks` (`project_key`,`status`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_by_status` ON `tasks` (`status`,"created_at" desc);--> statement-breakpoint
DELETE FROM `task_events` WHERE `kind` = 'parent_changed';