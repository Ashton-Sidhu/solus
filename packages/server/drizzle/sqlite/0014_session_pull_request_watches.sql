CREATE TABLE `session_pull_request_watches` (
	`session_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`watch_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`state` text NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `repository`, `number`)
);
