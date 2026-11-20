CREATE TABLE `integration_server_facts` (
	`integration_id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`verdict` text,
	`verdict_at` integer,
	`facts` text,
	`stored_at` integer NOT NULL,
	PRIMARY KEY(`integration_id`, `user_id`, `account_id`)
);
--> statement-breakpoint
ALTER TABLE `integration` ADD `launch` text;--> statement-breakpoint
ALTER TABLE `integration` ADD `project_key` text;