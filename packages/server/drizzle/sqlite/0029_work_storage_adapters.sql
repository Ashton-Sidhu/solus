CREATE TABLE `work_storage` (
	`work_id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`provider` text NOT NULL,
	`repository` text,
	`storage_scope` text,
	`commit_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`archived_generation` integer DEFAULT 0 NOT NULL,
	`dirty_since` integer,
	`due_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	`error` text,
	`claim_id` text,
	`claim_until` integer,
	`operation` text
);
--> statement-breakpoint
CREATE INDEX `work_storage_due` ON `work_storage` (`provider`,`due_at`) WHERE due_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `work_storage_bodies` (
	`work_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`content` text,
	`commit_id` text,
	PRIMARY KEY(`work_id`, `content_hash`),
	FOREIGN KEY (`work_id`) REFERENCES `work_storage`(`work_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `work_live_docs` ADD `last_author` text;--> statement-breakpoint
ALTER TABLE `work_live_docs` ADD `body_version` integer;--> statement-breakpoint
ALTER TABLE `work_live_docs` ADD `needs_projection` integer DEFAULT 0 NOT NULL;