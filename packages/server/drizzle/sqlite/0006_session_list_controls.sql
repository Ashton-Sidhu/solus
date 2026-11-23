ALTER TABLE `personal_resource_state` ADD `pin_order_key` text;--> statement-breakpoint
ALTER TABLE `personal_resource_state` ADD `active_order_key` text;--> statement-breakpoint
ALTER TABLE `session_records` ADD `auto_settle_disabled_at` integer;