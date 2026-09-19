CREATE TABLE IF NOT EXISTS `credential_locks` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`host_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `credential_vault` (
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`method` text NOT NULL,
	`ciphertext` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`expires_at` integer,
	`connected_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `insight_log_events` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`host_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`level` text NOT NULL,
	`name` text NOT NULL,
	`tag` text NOT NULL,
	`file` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `insight_log_events_span_idx` ON `insight_log_events` (`organization_id`,`host_id`,`span_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `insight_spans` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`host_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`trace_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`service` text NOT NULL,
	`session_id` text,
	`provider` text,
	`model` text,
	`project_root` text,
	`origin` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `span_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `insight_spans_session_idx` ON `insight_spans` (`organization_id`,`session_id`,`started_at`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `insight_spans_time_idx` ON `insight_spans` (`organization_id`,`started_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organization_members` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_prompt_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`author_display_name` text,
	`text` text NOT NULL,
	`state` text DEFAULT 'waiting' NOT NULL,
	`claimed_by_host_id` text,
	`claim_epoch` integer,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`settled_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_prompt_queue_session_idx` ON `session_prompt_queue` (`organization_id`,`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_prompt_queue_waiting_idx` ON `session_prompt_queue` (`organization_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_runner_leases` (
	`session_id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`host_id` text NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_transcripts` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`runner_host_id` text NOT NULL,
	`message` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `session_id`, `position`)
);
