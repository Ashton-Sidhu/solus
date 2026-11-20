CREATE TABLE `session_storage` (
	`session_id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`head` text,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `session_storage_turns` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`facts` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_storage_turns_by_session` ON `session_storage_turns` (`session_id`,`created_at`);