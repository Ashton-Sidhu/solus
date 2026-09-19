CREATE TABLE IF NOT EXISTS `resource_owner` (
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`resource_kind`, `resource_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `share_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`link_secret_hash` text,
	`link_secret` text,
	`granted_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `share_grant_subject` ON `share_grant` (`resource_kind`,`resource_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `share_grant_resource_idx` ON `share_grant` (`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `share_grant_secret_idx` ON `share_grant` (`link_secret_hash`) WHERE link_secret_hash IS NOT NULL;