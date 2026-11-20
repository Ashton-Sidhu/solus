ALTER TABLE `session_storage` ADD `cloud_scope` text;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `pushed_head` text;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `reported_head` text;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `push_due_at` integer;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `push_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `push_error` text;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `push_refused_head` text;