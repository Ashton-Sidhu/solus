CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`at` integer NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`by_kind` text NOT NULL,
	`by_user_key` text,
	`target_user_key` text,
	`by` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_by_subject` ON `activity` (`subject_kind`,`subject_id`,`at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_for_user` ON `activity` (`target_user_key`,`at`,`id`);--> statement-breakpoint
CREATE TABLE `asset_publications` (
	`asset_id` text NOT NULL,
	`provider` text NOT NULL,
	`target_key` text NOT NULL,
	`remote_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`asset_id`, `provider`, `target_key`)
);
--> statement-breakpoint
CREATE TABLE `indexed_plans` (
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`plan_tool_use_id` text NOT NULL,
	`project_path` text NOT NULL,
	`cwd` text NOT NULL,
	`project_root` text NOT NULL,
	`timestamp` integer NOT NULL,
	`title` text NOT NULL,
	`excerpt` text NOT NULL,
	`plan_file_path` text,
	`content` text NOT NULL,
	`derived_status` text NOT NULL,
	`session_available` integer DEFAULT 1 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`provider`, `session_id`, `plan_tool_use_id`)
);
--> statement-breakpoint
CREATE INDEX `indexed_plans_by_project` ON `indexed_plans` (`provider`,`project_root`,"timestamp" desc);--> statement-breakpoint
CREATE INDEX `indexed_plans_by_session` ON `indexed_plans` (`session_id`);--> statement-breakpoint
CREATE TABLE `insight_log_events` (
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
CREATE INDEX `insight_log_events_time_idx` ON `insight_log_events` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `insight_spans` (
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
	`user_id` text,
	`user_email` text,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`status` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `span_id`)
);
--> statement-breakpoint
CREATE INDEX `insight_turns_page` ON `insight_spans` (`organization_id`,"started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX `insight_turns_user_page` ON `insight_spans` (`organization_id`,`user_id`,"started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX `insight_turns_host_page` ON `insight_spans` (`organization_id`,`host_id`,"started_at" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX `insight_turns_session_page` ON `insight_spans` (`organization_id`,`session_id`,"started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX `insight_turns_provider_page` ON `insight_spans` (`organization_id`,`provider`,"started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX `insight_spans_time_idx` ON `insight_spans` (`started_at`);--> statement-breakpoint
CREATE TABLE `plan_annotations` (
	`session_id` text NOT NULL,
	`plan_tool_use_id` text NOT NULL,
	`status` text,
	`title` text,
	`bookmarked` integer,
	`bookmarked_at` integer,
	`project_path` text,
	`cwd` text,
	`comments` text,
	`updated_at` integer,
	`mirrored_doc` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `plan_tool_use_id`)
);
--> statement-breakpoint
CREATE TABLE `plan_index_providers` (
	`provider` text PRIMARY KEY NOT NULL,
	`completed_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resource_owner` (
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`resource_kind`, `resource_id`)
);
--> statement-breakpoint
CREATE TABLE `runner_cursors` (
	`organization_id` text NOT NULL,
	`host_id` text NOT NULL,
	`actor_user_id` text DEFAULT '' NOT NULL,
	`stream` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `actor_user_id`, `stream`)
);
--> statement-breakpoint
CREATE TABLE `session_admissions` (
	`organization_id` text NOT NULL,
	`admission_id` text NOT NULL,
	`host_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `admission_id`)
);
--> statement-breakpoint
CREATE TABLE `session_pull_requests` (
	`session_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`linked_at` integer NOT NULL,
	`pr_state` text,
	`pr_draft` integer,
	`pr_updated_at` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `repository`, `number`)
);
--> statement-breakpoint
CREATE INDEX `session_pull_requests_by_pull_request` ON `session_pull_requests` (`repository`,`number`);--> statement-breakpoint
CREATE TABLE `session_records` (
	`session_id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`publication` text DEFAULT 'local' NOT NULL,
	`owner_user_id` text,
	`provider` text NOT NULL,
	`project_path` text NOT NULL,
	`project_remote` text,
	`runner_host_id` text,
	`title` text,
	`custom_title` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`model` text,
	`reasoning_effort` text,
	`parent_session_id` text,
	`root_session_id` text,
	`created_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`cwd` text,
	`slug` text,
	`is_worktree` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`project_root` text,
	`delegation_message_id` text,
	`delegation_depth` integer,
	`delegation_intent` text,
	`delegation_created_at` integer
);
--> statement-breakpoint
CREATE INDEX `sessions_api_page` ON `session_records` (`organization_id`,"created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `sessions_api_provider_page` ON `session_records` (`organization_id`,`provider`,"created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE TABLE `session_states` (
	`session_id` text PRIMARY KEY NOT NULL,
	`settled_at` integer,
	`settled_by` text,
	`unsettled_at` integer,
	`snoozed_until` integer,
	`snooze_note` text,
	`last_prompt_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_states_settled` ON `session_states` (`settled_at`);--> statement-breakpoint
CREATE TABLE `session_transcripts` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`runner_host_id` text NOT NULL,
	`message` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `position`, `organization_id`)
);
--> statement-breakpoint
CREATE TABLE `share_grant` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`link_secret_hash` text,
	`link_secret` text,
	`granted_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_grant_subject` ON `share_grant` (`resource_kind`,`resource_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `share_grant_secret_idx` ON `share_grant` (`link_secret_hash`) WHERE link_secret_hash IS NOT NULL;--> statement-breakpoint
CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author` text,
	`source` text DEFAULT 'local' NOT NULL,
	`external_id` text,
	`origin_session_id` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_comments_by_task` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_comments_external` ON `task_comments` (`task_id`,`external_id`) WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `task_counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_external_links` (
	`task_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`external_updated_at` text,
	`snapshot` text,
	`dirty_fields` text DEFAULT '[]' NOT NULL,
	`sync_state` text DEFAULT 'ok' NOT NULL,
	`sync_error` text,
	`last_synced_at` integer,
	`retry_at` integer,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_external_links_external` ON `task_external_links` (`provider`,`external_key`,`external_id`);--> statement-breakpoint
CREATE TABLE `task_links` (
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_scope` text DEFAULT '' NOT NULL,
	`target_key` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`url` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`origin_session_id` text,
	`output_session_id` text,
	`linked_at` integer NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`pr_state` text,
	`pr_draft` integer,
	`pr_updated_at` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`task_id`, `kind`, `target_scope`, `target_key`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_links_by_target` ON `task_links` (`kind`,`target_key`,`target_scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_pr_links_by_url` ON `task_links` (`task_id`,`url`) WHERE kind = 'pr' AND url IS NOT NULL;--> statement-breakpoint
CREATE TABLE `task_session_links` (
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text DEFAULT 'working' NOT NULL,
	`pr` text,
	`injected_at` integer,
	`linked_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`task_id`, `session_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_session_links_by_session` ON `task_session_links` (`session_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` integer,
	`project_key` text,
	`title` text NOT NULL,
	`title_source` text DEFAULT 'prompt' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'inbox' NOT NULL,
	`assignee` text,
	`due_date` text,
	`priority` text,
	`labels` text DEFAULT '[]' NOT NULL,
	`pr` text,
	`epic` text,
	`source` text DEFAULT 'user' NOT NULL,
	`origin_session_id` text,
	`origin_automation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`triaged_at` integer,
	`done_at` integer,
	`last_read_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_short_id_unique` ON `tasks` (`short_id`);--> statement-breakpoint
CREATE INDEX `tasks_api_page` ON `tasks` (`organization_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `tasks_api_project_page` ON `tasks` (`organization_id`,`project_key`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `tasks_api_status_page` ON `tasks` (`organization_id`,`status`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `upstream_task_cache` (
	`project_key` text NOT NULL,
	`provider` text NOT NULL,
	`external_key` text NOT NULL,
	`scope` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`truncated` integer,
	`tasks` text NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`project_key`, `provider`, `external_key`, `scope`)
);
--> statement-breakpoint
CREATE TABLE `work_annotations` (
	`work_id` text PRIMARY KEY NOT NULL,
	`data` text,
	`updated_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_live_docs` (
	`work_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`client_seqs` text,
	`updated_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `work_reviewers` (
	`work_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`display_name` text NOT NULL,
	`color_index` integer DEFAULT 0 NOT NULL,
	`requested_by` text,
	`requested_at` integer,
	`request_message` text,
	`requested_rev` integer,
	`decision` text,
	`decision_summary` text,
	`decided_at` integer,
	`decided_rev` integer,
	`decided_content_hash` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`work_id`, `reviewer_id`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_reviewers_reviewer` ON `work_reviewers` (`reviewer_id`,"requested_at" desc);--> statement-breakpoint
CREATE TABLE `work_revisions` (
	`work_id` text NOT NULL,
	`rev` integer NOT NULL,
	`content` text,
	`updated_at` integer,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`source_content_version` integer,
	`author` text,
	`reason` text DEFAULT 'checkpoint' NOT NULL,
	`content_hash` text NOT NULL,
	PRIMARY KEY(`work_id`, `rev`),
	FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `works` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`preview` text,
	`type` text,
	`session_id` text,
	`agent_provider` text,
	`cwd` text,
	`pinned` integer,
	`content` text,
	`created_at` integer,
	`updated_at` integer,
	`meta` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`content_version` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`content_author` text,
	`previous_revision_id` integer
);
--> statement-breakpoint
CREATE INDEX `works_api_page` ON `works` (`organization_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `works_api_type_page` ON `works` (`organization_id`,`type`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `works_by_session` ON `works` (`session_id`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `workspace_api_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_api_receipts_expiry` ON `workspace_api_receipts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `workspace_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`repository_key` text NOT NULL,
	`display_name` text NOT NULL,
	`default_branch` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_projects_by_repository` ON `workspace_projects` (`organization_id`,`repository_key`);--> statement-breakpoint
-- The works search index on SQLite (packages/server/src/db/search-index.ts):
-- an FTS5 table kept in step by triggers on `works`. `works.id` is text and its
-- implicit rowid can change when a migration rebuilds the table, so
-- `works_fts_rows` gives each work a stable integer that is its FTS rowid. A
-- trigger then finds a work's FTS row by key, not by scanning the index. A
-- migration that rebuilds `works` drops these triggers with the old table and
-- must create them again.
CREATE TABLE `works_fts_rows` (
	`rowid` integer PRIMARY KEY,
	`work_id` text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE VIRTUAL TABLE works_fts USING fts5(
  title,
  content,
  tokenize='porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER works_fts_ai AFTER INSERT ON works BEGIN
  INSERT INTO works_fts_rows(work_id) VALUES (new.id);
  INSERT INTO works_fts(rowid, title, content)
    VALUES ((SELECT rowid FROM works_fts_rows WHERE work_id = new.id), COALESCE(new.title, ''), COALESCE(new.content, ''));
END;
--> statement-breakpoint
CREATE TRIGGER works_fts_ad AFTER DELETE ON works BEGIN
  DELETE FROM works_fts WHERE rowid = (SELECT rowid FROM works_fts_rows WHERE work_id = old.id);
  DELETE FROM works_fts_rows WHERE work_id = old.id;
END;
--> statement-breakpoint
-- Only a change to the indexed text re-indexes: pins, metadata and version
-- bumps write `works` often and leave the index alone.
CREATE TRIGGER works_fts_au AFTER UPDATE OF title, content ON works
WHEN old.title IS NOT new.title OR old.content IS NOT new.content BEGIN
  UPDATE works_fts SET title = COALESCE(new.title, ''), content = COALESCE(new.content, '')
    WHERE rowid = (SELECT rowid FROM works_fts_rows WHERE work_id = new.id);
END;
