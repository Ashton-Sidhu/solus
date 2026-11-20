CREATE TABLE `integration_resource_watch` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`uri` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`end_reason` text,
	`status_message` text,
	`wakes` integer NOT NULL,
	`last_wake_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integration_resource_watch_by_session` ON `integration_resource_watch` (`session_id`,`created_at`);