CREATE TABLE IF NOT EXISTS `workspace_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`repository_key` text NOT NULL,
	`display_name` text NOT NULL,
	`default_branch` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_projects_by_repository` ON `workspace_projects` (`organization_id`,`repository_key`);