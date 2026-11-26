ALTER TABLE `session_storage` ADD `push_stopped_reason` text;--> statement-breakpoint
ALTER TABLE `session_storage` ADD `pushed_bytes` integer DEFAULT 0 NOT NULL;