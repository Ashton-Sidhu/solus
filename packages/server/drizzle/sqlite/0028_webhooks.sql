CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`arrived_at` integer NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`replay_of` text,
	`request` text NOT NULL,
	`verification_failure` text,
	`actions` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_by_webhook` ON `webhook_deliveries` (`webhook_id`,`arrived_at`,`id`);--> statement-breakpoint
CREATE TABLE `webhook_seen_keys` (
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`kind`, `key`)
);
--> statement-breakpoint
CREATE INDEX `webhook_seen_keys_by_expiry` ON `webhook_seen_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`owner_key` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`project` text,
	`verification` text NOT NULL,
	`replay_key` text,
	`actions` text NOT NULL,
	`created_by` text NOT NULL,
	`copied_url_hash` text,
	`lost_count` integer DEFAULT 0 NOT NULL,
	`lost_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_by_owner` ON `webhooks` (`organization_id`,`owner_key`);--> statement-breakpoint
CREATE INDEX `webhooks_by_project` ON `webhooks` (`project`);