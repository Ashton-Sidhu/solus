CREATE TABLE `mcp_task` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`session_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`tool` text NOT NULL,
	`upstream_task_id` text NOT NULL,
	`status` text NOT NULL,
	`status_message` text,
	`traceparent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `mcp_task_by_session` ON `mcp_task` (`session_id`,`created_at`);