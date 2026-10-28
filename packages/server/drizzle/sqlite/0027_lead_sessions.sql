CREATE TABLE `session_leads` (
	`session_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
