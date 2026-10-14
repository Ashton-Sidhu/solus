CREATE TABLE `session_views` (
	`session_id` text NOT NULL,
	`person_key` text NOT NULL,
	`archived_at` integer,
	`snoozed_until` integer,
	`snooze_note` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `person_key`)
);
--> statement-breakpoint
CREATE INDEX `session_views_by_person` ON `session_views` (`person_key`,`session_id`);--> statement-breakpoint
ALTER TABLE `session_states` DROP COLUMN `snoozed_until`;--> statement-breakpoint
ALTER TABLE `session_states` DROP COLUMN `snooze_note`;--> statement-breakpoint
ALTER TABLE `session_states` DROP COLUMN `archived_at`;