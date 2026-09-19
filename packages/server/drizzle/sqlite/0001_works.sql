CREATE TABLE IF NOT EXISTS `work_annotations` (
	`work_id` text PRIMARY KEY NOT NULL,
	`data` text,
	`updated_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `work_revisions` (
	`work_id` text NOT NULL,
	`rev` integer NOT NULL,
	`content` text,
	`updated_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`work_id`, `rev`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `works` (
	`id` text PRIMARY KEY NOT NULL,
	`storage` text DEFAULT 'local' NOT NULL,
	`title` text,
	`preview` text,
	`type` text,
	`session_id` text,
	`agent_provider` text,
	`cwd` text,
	`pinned` integer,
	`content` text,
	`created_at` integer,
	`updated_at` integer,
	`meta` text,
	`organization_id` text DEFAULT 'local' NOT NULL
);
