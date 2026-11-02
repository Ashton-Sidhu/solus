CREATE TABLE `log_events` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`level` text NOT NULL,
	`name` text NOT NULL,
	`tag` text NOT NULL,
	`file` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`span_id`) REFERENCES `spans`(`span_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `log_events_trace_time` ON `log_events` (`trace_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `log_events_span_time` ON `log_events` (`span_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `spans` (
	`span_id` text PRIMARY KEY NOT NULL,
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
	`ended_at` integer,
	`duration_ms` integer,
	`status` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	`user_id` text,
	`user_email` text,
	`organization_id` text,
	`host_id` text
);
--> statement-breakpoint
CREATE INDEX `spans_kind_time` ON `spans` (`kind`,`started_at`);--> statement-breakpoint
CREATE INDEX `spans_kind_name_time` ON `spans` (`kind`,`name`,`started_at`);--> statement-breakpoint
CREATE INDEX `spans_trace` ON `spans` (`trace_id`);--> statement-breakpoint
CREATE INDEX `spans_session` ON `spans` (`session_id`,`started_at`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `spans_time` ON `spans` (`started_at`);