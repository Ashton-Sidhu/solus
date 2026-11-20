CREATE TABLE `host_device` (
	`device_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`token_hash` text,
	`paired_at` integer,
	`last_seen_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_device_token_hash_unique` ON `host_device` (`token_hash`);