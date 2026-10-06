CREATE TABLE `task_snoozes` (
	`task_id` text NOT NULL,
	`person_key` text NOT NULL,
	`snoozed_until` integer NOT NULL,
	`snooze_note` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`task_id`, `person_key`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_snoozes_by_person` ON `task_snoozes` (`person_key`,`snoozed_until`);