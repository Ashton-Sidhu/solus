CREATE TABLE `session_turn_diffs` (
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_index` integer NOT NULL,
	`runner_host_id` text NOT NULL,
	`ended_at` integer NOT NULL,
	`files_changed` integer NOT NULL,
	`additions` integer NOT NULL,
	`deletions` integer NOT NULL,
	`patch` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `turn_index`, `organization_id`)
);
