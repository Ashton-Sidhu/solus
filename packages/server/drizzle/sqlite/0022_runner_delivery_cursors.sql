DROP TABLE `runner_cursors`;--> statement-breakpoint
CREATE TABLE `runner_delivery_cursors` (
	`organization_id` text NOT NULL,
	`host_id` text NOT NULL,
	`actor_user_id` text DEFAULT '' NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `actor_user_id`)
);
