CREATE TABLE IF NOT EXISTS `asset_publications` (
	`asset_id` text NOT NULL,
	`provider` text NOT NULL,
	`target_key` text NOT NULL,
	`remote_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`asset_id`, `provider`, `target_key`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author` text,
	`source` text DEFAULT 'local' NOT NULL,
	`external_id` text,
	`origin_session_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_comments_by_task` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `task_comments_external` ON `task_comments` (`task_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor` text DEFAULT 'user' NOT NULL,
	`actor_label` text,
	`from_value` text,
	`to_value` text,
	`target_kind` text,
	`target_scope` text,
	`target_key` text,
	`target_title` text,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_events_by_task` ON `task_events` (`task_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_external_links` (
	`task_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`external_updated_at` text,
	`snapshot` text,
	`dirty_fields` text DEFAULT '[]' NOT NULL,
	`sync_state` text DEFAULT 'ok' NOT NULL,
	`sync_error` text,
	`last_synced_at` integer,
	`retry_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `task_external_links_external` ON `task_external_links` (`provider`,`external_key`,`external_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_links` (
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_scope` text DEFAULT '' NOT NULL,
	`target_key` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`url` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`origin_session_id` text,
	`linked_at` integer NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`task_id`, `kind`, `target_scope`, `target_key`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_links_by_target` ON `task_links` (`kind`,`target_scope`,`target_key`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `task_pr_links_by_url` ON `task_links` (`task_id`,`url`) WHERE kind = 'pr' AND url IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_session_links` (
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text DEFAULT 'working' NOT NULL,
	`pr` text,
	`injected_at` integer,
	`linked_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`task_id`, `session_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `task_session_links_by_session` ON `task_session_links` (`session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` integer,
	`project_key` text,
	`parent_id` text,
	`title` text NOT NULL,
	`title_source` text DEFAULT 'prompt' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`assignee` text,
	`due_date` text,
	`priority` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`pr` text,
	`source` text DEFAULT 'user' NOT NULL,
	`origin_session_id` text,
	`origin_automation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`triaged_at` integer,
	`done_at` integer,
	`last_read_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tasks_short_id_unique` ON `tasks` (`short_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_by_project` ON `tasks` (`project_key`,`status`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_by_status` ON `tasks` (`status`,"created_at" desc);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tasks_parent` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `upstream_task_cache` (
	`project_key` text NOT NULL,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`scope` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`truncated` integer,
	`tasks` text NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`project_key`, `provider`, `external_key`, `scope`)
);
