CREATE TABLE IF NOT EXISTS `runner_cursors` (
	`organization_id` text NOT NULL,
	`host_id` text NOT NULL,
	`stream` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `stream`)
);
