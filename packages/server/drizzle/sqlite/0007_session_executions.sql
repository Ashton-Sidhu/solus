CREATE TABLE `session_executions` (
	`session_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`revision` integer NOT NULL,
	`execution` text NOT NULL,
	PRIMARY KEY(`session_id`, `tool_id`)
);
