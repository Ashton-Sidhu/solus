ALTER TABLE `session_records` ADD `place` text;--> statement-breakpoint
ALTER TABLE `session_records` ADD `started_by` text;--> statement-breakpoint
CREATE INDEX `session_records_by_place` ON `session_records` (`place`,`last_activity_at`);