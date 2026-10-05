CREATE TABLE `notification_changes` (
	`position` integer PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`recipient_key` text NOT NULL,
	`notification_id` text NOT NULL,
	`op` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notification_changes_for_recipient` ON `notification_changes` (`recipient_key`,`position`);--> statement-breakpoint
CREATE INDEX `notification_changes_by_time` ON `notification_changes` (`at`);--> statement-breakpoint
CREATE TABLE `notification_journal` (
	`id` integer PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`floor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`recipient_key` text NOT NULL,
	`event_id` text NOT NULL,
	`activity_id` text,
	`kind` text NOT NULL,
	`resource_key` text NOT NULL,
	`facts` text NOT NULL,
	`resource` text NOT NULL,
	`by` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	`archived_at` integer,
	`resolved_at` integer,
	`resolution` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`read_revision` integer DEFAULT 0 NOT NULL,
	`archived_revision` integer DEFAULT 0 NOT NULL,
	`last_operation_id` text,
	`position` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event` ON `notifications` (`organization_id`,`recipient_key`,`event_id`);--> statement-breakpoint
CREATE INDEX `notifications_for_recipient` ON `notifications` (`recipient_key`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `notifications_by_resource` ON `notifications` (`organization_id`,`resource_key`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `assignee_user_id` text;