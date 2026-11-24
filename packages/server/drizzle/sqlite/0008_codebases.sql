CREATE TABLE `codebases` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`roots` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
ALTER TABLE `session_records` ADD `codebase_id` text;--> statement-breakpoint
ALTER TABLE `session_records` ADD `attached_folders` text DEFAULT '[]' NOT NULL;