CREATE TABLE `integration_icon` (
	`integration_id` text PRIMARY KEY NOT NULL,
	`icon` text NOT NULL,
	`source_key` text NOT NULL,
	`fetched_at` integer NOT NULL
);
