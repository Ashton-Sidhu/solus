ALTER TABLE `session_storage` ADD `push_stopped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `pushed_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session_storage` RENAME COLUMN `push_error` TO `push_error_reason`;
