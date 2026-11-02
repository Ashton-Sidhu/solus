CREATE TABLE `acl_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text DEFAULT '' NOT NULL,
	`role` text NOT NULL,
	`link_secret_hash` text,
	`link_secret` text,
	`actions` text,
	`expires_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`granted_at` integer,
	`granted_by_name` text,
	`organization_id` text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `acl_entry_subject` ON `acl_entry` (`resource_kind`,`resource_id`,`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `acl_entry_secret_idx` ON `acl_entry` (`link_secret_hash`) WHERE link_secret_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX `acl_entry_by_subject` ON `acl_entry` (`subject_kind`,`subject_id`,`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`at` integer NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`by_kind` text NOT NULL,
	`created_by` text,
	`user_id` text,
	`by` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_by_subject` ON `activity` (`subject_kind`,`subject_id`,`at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_for_user` ON `activity` (`user_id`,`at`,`id`);--> statement-breakpoint
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
	`thread_id` text DEFAULT '' NOT NULL,
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
CREATE INDEX `indexed_plans_by_thread` ON `indexed_plans` (`provider`,`thread_id`);--> statement-breakpoint
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
CREATE INDEX `insight_log_events_trace_idx` ON `insight_log_events` (`organization_id`,`host_id`,`trace_id`);--> statement-breakpoint
CREATE TABLE `insight_span_texts` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`host_id` text NOT NULL,
	`span_id` text NOT NULL,
	`name` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `span_id`, `name`)
);
--> statement-breakpoint
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
CREATE INDEX `insight_spans_trace_idx` ON `insight_spans` (`organization_id`,`host_id`,`trace_id`);--> statement-breakpoint
CREATE INDEX `insight_spans_time_idx` ON `insight_spans` (`started_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
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
	`archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_event` ON `notifications` (`organization_id`,`user_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `notifications_for_user` ON `notifications` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `notifications_by_resource` ON `notifications` (`organization_id`,`resource_key`);--> statement-breakpoint
CREATE TABLE `operation_receipts` (
	`scope` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text,
	`result_id` text,
	`expires_at` integer,
	PRIMARY KEY(`scope`, `namespace`, `key`)
);
--> statement-breakpoint
CREATE INDEX `operation_receipts_expiry` ON `operation_receipts` (`expires_at`,`scope`,`namespace`,`key`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
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
CREATE TABLE `resource_preferences` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`resource_kind` text NOT NULL,
	`resource_id` text NOT NULL,
	`created_by` text NOT NULL,
	`settled_at` integer,
	`archived_at` integer,
	`snoozed_until` integer,
	`snooze_note` text,
	`viewed_at` integer,
	PRIMARY KEY(`organization_id`, `resource_kind`, `resource_id`, `created_by`)
);
--> statement-breakpoint
CREATE INDEX `resource_preferences_by_person` ON `resource_preferences` (`created_by`,`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE INDEX `resource_preferences_snoozed` ON `resource_preferences` (`created_by`,`resource_kind`,`snoozed_until`) WHERE snoozed_until IS NOT NULL;--> statement-breakpoint
CREATE TABLE `runner_delivery_cursors` (
	`organization_id` text NOT NULL,
	`host_id` text NOT NULL,
	`user_id` text DEFAULT '' NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `host_id`, `user_id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`session_id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`created_by` text NOT NULL,
	`publication` text DEFAULT 'local' NOT NULL,
	`admitted_host_id` text,
	`admitted_at` integer,
	`started_at` integer,
	`provider` text,
	`project_path` text,
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
	`last_activity_at` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`cwd` text,
	`slug` text,
	`is_worktree` integer DEFAULT 0 NOT NULL,
	`branch` text,
	`project_root` text,
	`delegation_message_id` text,
	`delegation_depth` integer,
	`delegation_intent` text,
	`delegation_created_at` integer,
	`place` text,
	`started_by` text,
	`settled_at` integer,
	`settled_by` text,
	`unsettled_at` integer,
	`last_prompt_at` integer,
	`execution_preferences` text,
	`lead_started_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_api_page` ON `session` (`organization_id`,"created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_api_provider_page` ON `session` (`organization_id`,`provider`,"created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_api_activity_page` ON `session` (`organization_id`,"last_activity_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_any_page` ON `session` ("created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_by_activity` ON `session` ("last_activity_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_by_parent` ON `session` (`parent_session_id`,"created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX `session_by_project_path` ON `session` (`project_path`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `session_by_place` ON `session` (`place`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `session_links` (
	`session_id` text NOT NULL,
	`link_id` text NOT NULL,
	`target` text NOT NULL,
	`title` text NOT NULL,
	`created_by` text NOT NULL,
	`linked_at` integer NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `link_id`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_pull_request_watches` (
	`session_id` text NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`watch_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`state` text NOT NULL,
	`acting_user_key` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	PRIMARY KEY(`session_id`, `repository`, `number`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`session_id`) ON UPDATE no action ON DELETE cascade
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
	PRIMARY KEY(`session_id`, `repository`, `number`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_pull_requests_by_pull_request` ON `session_pull_requests` (`repository`,`number`);--> statement-breakpoint
CREATE INDEX `session_pull_requests_open` ON `session_pull_requests` (`session_id`) WHERE source <> 'dismissed' AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed', 'missing'));--> statement-breakpoint
CREATE TABLE `session_transcripts` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`runner_host_id` text NOT NULL,
	`message` text NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `position`, `organization_id`)
);
--> statement-breakpoint
CREATE INDEX `session_transcripts_search_pending` ON `session_transcripts` (`session_id`) WHERE search_text = '';--> statement-breakpoint
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
	`value` integer NOT NULL
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
	`started_by` text,
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
	`assignee_user_id` text,
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
	`location` text,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`created_by` text NOT NULL
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
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`arrived_at` integer NOT NULL,
	`source` text NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`replay_of` text,
	`request` text NOT NULL,
	`verification_failure` text,
	`actions` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_by_webhook` ON `webhook_deliveries` (`webhook_id`,`arrived_at`,`id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`project` text,
	`verification` text NOT NULL,
	`replay_key` text,
	`actions` text NOT NULL,
	`author` text NOT NULL,
	`copied_url_hash` text,
	`lost_count` integer DEFAULT 0 NOT NULL,
	`lost_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_by_creator` ON `webhooks` (`organization_id`,`created_by`);--> statement-breakpoint
CREATE INDEX `webhooks_by_project` ON `webhooks` (`project`);--> statement-breakpoint
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
	`last_author` text,
	`body_version` integer,
	`needs_projection` integer DEFAULT 0 NOT NULL,
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
CREATE TABLE `work_storage` (
	`work_id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`provider` text NOT NULL,
	`repository` text,
	`storage_scope` text,
	`commit_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`archived_generation` integer DEFAULT 0 NOT NULL,
	`dirty_since` integer,
	`due_at` integer,
	`deleted` integer DEFAULT 0 NOT NULL,
	`error` text,
	`claim_id` text,
	`claim_until` integer,
	`operation` text
);
--> statement-breakpoint
CREATE INDEX `work_storage_due` ON `work_storage` (`provider`,`due_at`) WHERE due_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `work_storage_bodies` (
	`work_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`content` text,
	`commit_id` text,
	PRIMARY KEY(`work_id`, `content_hash`),
	FOREIGN KEY (`work_id`) REFERENCES `work_storage`(`work_id`) ON UPDATE no action ON DELETE cascade
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
	`previous_revision_id` integer,
	`location` text,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `works_api_page` ON `works` (`organization_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `works_api_type_page` ON `works` (`organization_id`,`type`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `works_by_session` ON `works` (`session_id`) WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE `workspace_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text DEFAULT 'local' NOT NULL,
	`repository_key` text NOT NULL,
	`display_name` text NOT NULL,
	`default_branch` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_projects_by_repository` ON `workspace_projects` (`organization_id`,`repository_key`);--> statement-breakpoint
CREATE TABLE `activity_mirror_rows` (
	`session_id` text NOT NULL,
	`activity_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `activity_id`)
);
--> statement-breakpoint
CREATE TABLE `async_questions` (
	`question_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`retained_until` integer
);
--> statement-breakpoint
CREATE INDEX `async_questions_by_session` ON `async_questions` (`session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `async_questions_by_agent` ON `async_questions` (`agent_session_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `async_questions_retained` ON `async_questions` (`retained_until`) WHERE retained_until IS NOT NULL;--> statement-breakpoint
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
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `browser_profiles` (
	`created_by` text NOT NULL,
	`project_root` text NOT NULL,
	`profile_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`created_by`, `project_root`, `profile_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_profiles_default` ON `browser_profiles` (`created_by`,`project_root`) WHERE is_default = 1;--> statement-breakpoint
CREATE TABLE `delivery_queue` (
	`seq` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`payload` text NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text DEFAULT '' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `delivery_queue_by_destination` ON `delivery_queue` (`organization_id`,`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `delivery_queue_by_key` ON `delivery_queue` (`kind`,`key`);--> statement-breakpoint
CREATE TABLE `integration` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_by` text NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth` text NOT NULL,
	`disabled_tools` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_slug` ON `integration` (`organization_id`,`created_by`,`slug`);--> statement-breakpoint
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
CREATE TABLE `member_folder` (
	`user_id` text PRIMARY KEY NOT NULL,
	`folder` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_folder_folder_unique` ON `member_folder` (`folder`);--> statement-breakpoint
CREATE TABLE `notification_pr_observations` (
	`authority` text NOT NULL,
	`repo` text NOT NULL,
	`user_id` text NOT NULL,
	`pending` text NOT NULL,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`authority`, `repo`, `user_id`)
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
	`error` text
);
--> statement-breakpoint
CREATE INDEX `outbox_ops_by_resource` ON `outbox_ops` (`domain`,`resource_id`,`id`);--> statement-breakpoint
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
	`created_by` text NOT NULL,
	`name` text NOT NULL,
	`form` text NOT NULL,
	`spec` text,
	`sql` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_metrics_queries_by_creator` ON `saved_metrics_queries` (`created_by`,"updated_at" desc);--> statement-breakpoint
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
CREATE TABLE `transcript_index` (
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
	`place` text
);
--> statement-breakpoint
CREATE INDEX `transcript_index_by_project_root` ON `transcript_index` (`project_root`,"last_timestamp" desc);--> statement-breakpoint
CREATE INDEX `transcript_index_recent_branches` ON `transcript_index` (`last_timestamp`) WHERE branch IS NOT NULL AND branch <> '';--> statement-breakpoint
CREATE TABLE `transcript_mirror_rows` (
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`hash` text NOT NULL,
	PRIMARY KEY(`session_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `turn_flags` (
	`created_by` text NOT NULL,
	`trace_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`created_by`, `trace_id`)
);

--> statement-breakpoint
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
--> statement-breakpoint
-- The session search index on SQLite (packages/server/src/db/session-search.ts): an FTS5
-- table over each mirrored message's `search_text`, kept in step by triggers.
CREATE VIRTUAL TABLE session_transcripts_fts USING fts5(search_text, content='session_transcripts', content_rowid='rowid', tokenize='unicode61');
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_insert AFTER INSERT ON session_transcripts BEGIN
  INSERT INTO session_transcripts_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_update AFTER UPDATE OF search_text ON session_transcripts WHEN old.search_text IS NOT new.search_text BEGIN
  INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO session_transcripts_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER session_transcripts_search_delete AFTER DELETE ON session_transcripts BEGIN
  INSERT INTO session_transcripts_fts(session_transcripts_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;
--> statement-breakpoint
-- The transcript search index on this host (packages/server/src/db/session-indexer.ts):
-- a contentless FTS5 table over `session_messages`, written by the indexer beside
-- each message row. Contentless so a delete needs only the rowid.
CREATE VIRTUAL TABLE session_fts USING fts5(text, content='', contentless_delete=1, tokenize='unicode61');
