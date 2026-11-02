CREATE TABLE `activity_mirror_rows` (
	`session_id` text NOT NULL,
	`activity_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `activity_id`)
);
--> statement-breakpoint
CREATE TABLE `applied_ops` (
	`op_id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `async_questions` (
	`question_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `async_questions_by_session` ON `async_questions` (`session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `async_questions_by_agent` ON `async_questions` (`agent_session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`status` text,
	`output` text,
	`data` text,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_by_automation` ON `automation_runs` (`automation_id`,"started_at" desc);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`enabled` integer,
	`favorite` integer,
	`action` text,
	`trigger_config` text,
	`next_run_at` integer,
	`last_run` text,
	`created_at` integer,
	`updated_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`owner_key` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_profile_defaults` (
	`owner_key` text NOT NULL,
	`project_root` text NOT NULL,
	`profile_id` text NOT NULL,
	PRIMARY KEY(`owner_key`, `project_root`)
);
--> statement-breakpoint
CREATE TABLE `browser_profiles` (
	`owner_key` text NOT NULL,
	`project_root` text NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_key`, `project_root`, `profile_id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_queue` (
	`seq` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`organization_id` text NOT NULL,
	`actor_user_id` text DEFAULT '' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `delivery_queue_by_destination` ON `delivery_queue` (`organization_id`,`actor_user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `delivery_queue_by_key` ON `delivery_queue` (`kind`,`key`);--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`owner_key` text NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth` text NOT NULL,
	`disabled_tools` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_slug` ON `integration` (`organization_id`,`owner_key`,`slug`);--> statement-breakpoint
CREATE TABLE `integration_connection` (
	`integration_id` text NOT NULL,
	`user_id` text,
	`account_id` text DEFAULT 'default' NOT NULL,
	`status` text NOT NULL,
	`source` text DEFAULT 'host' NOT NULL,
	`label` text,
	`info` text,
	`error` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`integration_id`, `user_id`, `account_id`)
);
--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `notification_pr_observations` (
	`authority` text NOT NULL,
	`repo` text NOT NULL,
	`recipient_key` text NOT NULL,
	`pending` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`authority`, `repo`, `recipient_key`)
);
--> statement-breakpoint
CREATE TABLE `outbox_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`resource_id` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`session_id` text,
	`recorded_at` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`publication_id` text
);
--> statement-breakpoint
CREATE INDEX `outbox_ops_by_resource` ON `outbox_ops` (`domain`,`resource_id`,`id`);--> statement-breakpoint
CREATE INDEX `outbox_ops_by_publication` ON `outbox_ops` (`publication_id`,`state`);--> statement-breakpoint
CREATE TABLE `pinned_sessions` (
	`session_id` text NOT NULL,
	`server_id` text DEFAULT '' NOT NULL,
	`provider` text,
	`title` text,
	`cwd` text,
	`pinned_at` integer,
	PRIMARY KEY(`session_id`, `server_id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`key` text PRIMARY KEY NOT NULL,
	`path` text,
	`folder_name` text,
	`added_at` integer,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `recent_projects` (
	`path` text PRIMARY KEY NOT NULL,
	`folder_name` text,
	`last_opened` integer
);
--> statement-breakpoint
CREATE TABLE `run_exchanges` (
	`exchange_id` text PRIMARY KEY NOT NULL,
	`sender_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`delivery_state` text,
	`delivery_queue_id` text,
	`payload` text NOT NULL,
	`report` text,
	`reply` text,
	`settled_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_queue` (
	`queue_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_queue_by_session` ON `run_queue` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `runs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`state` text NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_metrics_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`form` text NOT NULL,
	`spec` text,
	`sql` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `saved_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_root` text NOT NULL,
	`text` text NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_prompts_by_project` ON `saved_prompts` (`project_root`,"created_at" desc);--> statement-breakpoint
CREATE TABLE `session_files` (
	`path` text PRIMARY KEY NOT NULL,
	`provider` text,
	`last_offset` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `session_keys` (
	`number` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_keys_session_id_unique` ON `session_keys` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_lineage_members` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`cwd` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `position`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_lineage_member_provider_session` ON `session_lineage_members` (`provider_session_id`,`provider`) WHERE provider_session_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `session_messages` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`uuid` text,
	`role` text,
	`ts` integer,
	`text` text
);
--> statement-breakpoint
CREATE INDEX `session_messages_by_session` ON `session_messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_thread_aliases` (
	`provider` text NOT NULL,
	`provider_session_id` text NOT NULL,
	`session_id` text NOT NULL,
	PRIMARY KEY(`provider_session_id`, `provider`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`cwd` text,
	`project_path` text,
	`project_root` text,
	`is_worktree` integer,
	`slug` text,
	`first_message` text,
	`custom_title` text,
	`last_timestamp` integer,
	`size` integer,
	`model` text,
	`reasoning_effort` text,
	`branch` text,
	`server_id` text,
	`parent_session_id` text,
	`root_session_id` text,
	`delegation_exchange_id` text,
	`delegation_depth` integer,
	`delegation_intent` text,
	`delegation_created_at` integer,
	`started_by` text,
	`place` text
);
--> statement-breakpoint
CREATE INDEX `sessions_by_parent` ON `sessions` (`parent_session_id`,"last_timestamp" desc);--> statement-breakpoint
CREATE INDEX `sessions_by_project_root` ON `sessions` (`project_root`,"last_timestamp" desc);--> statement-breakpoint
CREATE INDEX `sessions_worktree_recent` ON `sessions` (`last_timestamp`) WHERE is_worktree = 1;--> statement-breakpoint
CREATE TABLE `transcript_mirror_rows` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`session_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `turn_flags` (
	`trace_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

--> statement-breakpoint
-- The transcript search index on this host (packages/server/src/db/session-indexer.ts):
-- a contentless FTS5 table over `session_messages`, written by the indexer beside
-- each message row. Contentless so a delete needs only the rowid.
CREATE VIRTUAL TABLE session_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
