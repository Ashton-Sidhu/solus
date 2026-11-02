CREATE TABLE "acl_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"link_secret_hash" text,
	"link_secret" text,
	"actions" text,
	"expires_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"granted_at" bigint,
	"granted_by_name" text,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"at" bigint NOT NULL,
	"turn_id" text,
	"kind" text NOT NULL,
	"by_kind" text NOT NULL,
	"created_by" text,
	"user_id" text,
	"by" text NOT NULL,
	"data" text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_publications" (
	"asset_id" text NOT NULL,
	"provider" text NOT NULL,
	"target_key" text NOT NULL,
	"remote_url" text NOT NULL,
	"created_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "asset_publications_asset_id_provider_target_key_pk" PRIMARY KEY("asset_id","provider","target_key")
);
--> statement-breakpoint
CREATE TABLE "indexed_plans" (
	"provider" text NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text DEFAULT '' NOT NULL,
	"plan_tool_use_id" text NOT NULL,
	"project_path" text NOT NULL,
	"cwd" text NOT NULL,
	"project_root" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"title" text NOT NULL,
	"excerpt" text NOT NULL,
	"plan_file_path" text,
	"content" text NOT NULL,
	"derived_status" text NOT NULL,
	"session_available" integer DEFAULT 1 NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "indexed_plans_provider_session_id_plan_tool_use_id_pk" PRIMARY KEY("provider","session_id","plan_tool_use_id")
);
--> statement-breakpoint
CREATE TABLE "insight_log_events" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"host_id" text NOT NULL,
	"event_id" bigint NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"level" text NOT NULL,
	"name" text NOT NULL,
	"tag" text NOT NULL,
	"file" text NOT NULL,
	"attrs" text DEFAULT '{}' NOT NULL,
	CONSTRAINT "insight_log_events_organization_id_host_id_event_id_pk" PRIMARY KEY("organization_id","host_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "insight_span_texts" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"host_id" text NOT NULL,
	"span_id" text NOT NULL,
	"name" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "insight_span_texts_organization_id_host_id_span_id_name_pk" PRIMARY KEY("organization_id","host_id","span_id","name")
);
--> statement-breakpoint
CREATE TABLE "insight_spans" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"host_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"trace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"service" text NOT NULL,
	"session_id" text,
	"provider" text,
	"model" text,
	"project_root" text,
	"origin" text,
	"user_id" text,
	"user_email" text,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"duration_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"attrs" text DEFAULT '{}' NOT NULL,
	CONSTRAINT "insight_spans_organization_id_host_id_span_id_pk" PRIMARY KEY("organization_id","host_id","span_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"activity_id" text,
	"kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"facts" text NOT NULL,
	"resource" text NOT NULL,
	"by" text NOT NULL,
	"summary" text NOT NULL,
	"created_at" bigint NOT NULL,
	"read_at" bigint,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "operation_receipts" (
	"scope" text NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text,
	"result_id" text,
	"expires_at" bigint,
	CONSTRAINT "operation_receipts_scope_namespace_key_pk" PRIMARY KEY("scope","namespace","key")
);
--> statement-breakpoint
CREATE TABLE "plan_annotations" (
	"session_id" text NOT NULL,
	"plan_tool_use_id" text NOT NULL,
	"status" text,
	"title" text,
	"bookmarked" integer,
	"bookmarked_at" bigint,
	"project_path" text,
	"cwd" text,
	"comments" text,
	"updated_at" bigint,
	"mirrored_doc" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "plan_annotations_session_id_plan_tool_use_id_pk" PRIMARY KEY("session_id","plan_tool_use_id")
);
--> statement-breakpoint
CREATE TABLE "plan_index_providers" (
	"provider" text PRIMARY KEY NOT NULL,
	"completed_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_request_observations" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"authority_key" text NOT NULL,
	"repository" text NOT NULL,
	"number" integer NOT NULL,
	"state" text NOT NULL,
	"draft" integer,
	"title" text DEFAULT '' NOT NULL,
	"updated_at" text,
	"observed_at" bigint NOT NULL,
	CONSTRAINT "pull_request_observations_organization_id_authority_key_repository_number_pk" PRIMARY KEY("organization_id","authority_key","repository","number")
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_scope" text DEFAULT '' NOT NULL,
	"target_key" text NOT NULL,
	"relation" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"url" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"via_session_id" text,
	"origin_session_id" text,
	"authority_key" text,
	"repository" text,
	"number" integer,
	"keeps_session" integer DEFAULT 0 NOT NULL,
	"watch_id" text,
	"watch_started_at" bigint,
	"watch_user_id" text,
	"watch_state" text,
	"author" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_preferences" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_by" text NOT NULL,
	"settled_at" bigint,
	"archived_at" bigint,
	"snoozed_until" bigint,
	"snooze_note" text,
	"viewed_at" bigint,
	CONSTRAINT "resource_preferences_organization_id_resource_kind_resource_id_created_by_pk" PRIMARY KEY("organization_id","resource_kind","resource_id","created_by")
);
--> statement-breakpoint
CREATE TABLE "runner_delivery_cursors" (
	"organization_id" text NOT NULL,
	"host_id" text NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_delivery_cursors_organization_id_host_id_user_id_pk" PRIMARY KEY("organization_id","host_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"session_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"created_by" text NOT NULL,
	"publication" text DEFAULT 'local' NOT NULL,
	"admitted_host_id" text,
	"admitted_at" bigint,
	"started_at" bigint,
	"provider" text,
	"project_path" text,
	"project_remote" text,
	"runner_host_id" text,
	"title" text,
	"custom_title" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"model" text,
	"reasoning_effort" text,
	"parent_session_id" text,
	"root_session_id" text,
	"created_at" bigint NOT NULL,
	"last_activity_at" bigint DEFAULT 0 NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"cwd" text,
	"slug" text,
	"is_worktree" integer DEFAULT 0 NOT NULL,
	"branch" text,
	"project_root" text,
	"delegation_message_id" text,
	"delegation_depth" integer,
	"delegation_intent" text,
	"delegation_created_at" bigint,
	"place" text,
	"started_by" text,
	"settled_at" bigint,
	"settled_by" text,
	"unsettled_at" bigint,
	"last_prompt_at" bigint,
	"execution_preferences" text,
	"lead_started_at" bigint
);
--> statement-breakpoint
CREATE TABLE "session_transcripts" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"runner_host_id" text NOT NULL,
	"message" text NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "session_transcripts_session_id_position_organization_id_pk" PRIMARY KEY("session_id","position","organization_id")
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"author" text,
	"source" text DEFAULT 'local' NOT NULL,
	"external_id" text,
	"origin_session_id" text,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	"dirty" integer DEFAULT 0 NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_external_links" (
	"task_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_key" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"external_updated_at" text,
	"snapshot" text,
	"dirty_fields" text DEFAULT '[]' NOT NULL,
	"sync_state" text DEFAULT 'ok' NOT NULL,
	"sync_error" text,
	"last_synced_at" bigint,
	"retry_at" bigint,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"short_id" integer,
	"project_key" text,
	"title" text NOT NULL,
	"title_source" text DEFAULT 'prompt' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'inbox' NOT NULL,
	"assignee" text,
	"assignee_user_id" text,
	"due_date" text,
	"priority" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"epic" text,
	"source" text DEFAULT 'user' NOT NULL,
	"origin_session_id" text,
	"origin_automation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"triaged_at" bigint,
	"done_at" bigint,
	"last_read_at" bigint,
	"location" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "tasks_short_id_unique" UNIQUE("short_id")
);
--> statement-breakpoint
CREATE TABLE "upstream_task_cache" (
	"project_key" text NOT NULL,
	"provider" text NOT NULL,
	"external_key" text NOT NULL,
	"scope" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	"truncated" integer,
	"tasks" text NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "upstream_task_cache_project_key_provider_external_key_scope_pk" PRIMARY KEY("project_key","provider","external_key","scope")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"received_at" bigint NOT NULL,
	"arrived_at" bigint NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"replay_of" text,
	"request" text NOT NULL,
	"verification_failure" text,
	"actions" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"project" text,
	"verification" text NOT NULL,
	"replay_key" text,
	"actions" text NOT NULL,
	"author" text NOT NULL,
	"copied_url_hash" text,
	"lost_count" integer DEFAULT 0 NOT NULL,
	"lost_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_annotations" (
	"work_id" text PRIMARY KEY NOT NULL,
	"data" text,
	"updated_at" bigint,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_live_docs" (
	"work_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"client_seqs" text,
	"last_author" text,
	"body_version" integer,
	"needs_projection" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_reviewers" (
	"work_id" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"display_name" text NOT NULL,
	"color_index" integer DEFAULT 0 NOT NULL,
	"requested_by" text,
	"requested_at" bigint,
	"request_message" text,
	"requested_rev" integer,
	"decision" text,
	"decision_summary" text,
	"decided_at" bigint,
	"decided_rev" integer,
	"decided_content_hash" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "work_reviewers_work_id_reviewer_id_pk" PRIMARY KEY("work_id","reviewer_id")
);
--> statement-breakpoint
CREATE TABLE "work_revisions" (
	"work_id" text NOT NULL,
	"rev" integer NOT NULL,
	"content" text,
	"updated_at" bigint,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"source_content_version" integer,
	"author" text,
	"reason" text DEFAULT 'checkpoint' NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "work_revisions_work_id_rev_pk" PRIMARY KEY("work_id","rev")
);
--> statement-breakpoint
CREATE TABLE "work_storage" (
	"work_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"provider" text NOT NULL,
	"repository" text,
	"storage_scope" text,
	"commit_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"archived_generation" integer DEFAULT 0 NOT NULL,
	"dirty_since" bigint,
	"due_at" bigint,
	"deleted" integer DEFAULT 0 NOT NULL,
	"error" text,
	"claim_id" text,
	"claim_until" bigint,
	"operation" text
);
--> statement-breakpoint
CREATE TABLE "work_storage_bodies" (
	"work_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text,
	"commit_id" text,
	CONSTRAINT "work_storage_bodies_work_id_content_hash_pk" PRIMARY KEY("work_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"preview" text,
	"type" text,
	"session_id" text,
	"agent_provider" text,
	"cwd" text,
	"pinned" integer,
	"content" text,
	"created_at" bigint,
	"updated_at" bigint,
	"meta" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"content_version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"content_author" text,
	"previous_revision_id" integer,
	"location" text,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"repository_key" text NOT NULL,
	"display_name" text NOT NULL,
	"default_branch" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_external_links" ADD CONSTRAINT "task_external_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_live_docs" ADD CONSTRAINT "work_live_docs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_reviewers" ADD CONSTRAINT "work_reviewers_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_storage_bodies" ADD CONSTRAINT "work_storage_bodies_work_id_work_storage_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_storage"("work_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acl_entry_subject" ON "acl_entry" USING btree ("resource_kind","resource_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "acl_entry_secret_idx" ON "acl_entry" USING btree ("link_secret_hash") WHERE link_secret_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "acl_entry_by_subject" ON "acl_entry" USING btree ("subject_kind","subject_id","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "activity_by_subject" ON "activity" USING btree ("subject_kind","subject_id","at","id");--> statement-breakpoint
CREATE INDEX "activity_for_user" ON "activity" USING btree ("user_id","at","id");--> statement-breakpoint
CREATE INDEX "indexed_plans_by_project" ON "indexed_plans" USING btree ("provider","project_root","timestamp" desc);--> statement-breakpoint
CREATE INDEX "indexed_plans_by_session" ON "indexed_plans" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "indexed_plans_by_thread" ON "indexed_plans" USING btree ("provider","thread_id");--> statement-breakpoint
CREATE INDEX "insight_log_events_time_idx" ON "insight_log_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "insight_log_events_trace_idx" ON "insight_log_events" USING btree ("organization_id","host_id","trace_id");--> statement-breakpoint
CREATE INDEX "insight_turns_page" ON "insight_spans" USING btree ("organization_id","started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX "insight_turns_user_page" ON "insight_spans" USING btree ("organization_id","user_id","started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX "insight_turns_host_page" ON "insight_spans" USING btree ("organization_id","host_id","started_at" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX "insight_turns_session_page" ON "insight_spans" USING btree ("organization_id","session_id","started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX "insight_turns_provider_page" ON "insight_spans" USING btree ("organization_id","provider","started_at" desc,"host_id" desc,"trace_id" desc) WHERE kind = 'turn' AND span_id = trace_id;--> statement-breakpoint
CREATE INDEX "insight_spans_trace_idx" ON "insight_spans" USING btree ("organization_id","host_id","trace_id");--> statement-breakpoint
CREATE INDEX "insight_spans_time_idx" ON "insight_spans" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_event" ON "notifications" USING btree ("organization_id","user_id","event_id");--> statement-breakpoint
CREATE INDEX "notifications_for_user" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "notifications_by_resource" ON "notifications" USING btree ("organization_id","resource_key");--> statement-breakpoint
CREATE INDEX "operation_receipts_expiry" ON "operation_receipts" USING btree ("expires_at","scope","namespace","key") WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_links_edge" ON "resource_links" USING btree ("source_kind","source_id","target_kind","target_scope","target_key");--> statement-breakpoint
CREATE INDEX "resource_links_by_target" ON "resource_links" USING btree ("target_kind","target_key","target_scope");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_links_working_owner" ON "resource_links" USING btree ("organization_id","target_key") WHERE source_kind = 'task' AND target_kind = 'session' AND relation = 'works-on' AND status = 'active';--> statement-breakpoint
CREATE INDEX "resource_links_open_session" ON "resource_links" USING btree ("source_id","organization_id") WHERE keeps_session = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_links_watch" ON "resource_links" USING btree ("watch_id") WHERE watch_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "resource_links_by_pull_request" ON "resource_links" USING btree ("repository","number") WHERE repository IS NOT NULL;--> statement-breakpoint
CREATE INDEX "resource_preferences_by_person" ON "resource_preferences" USING btree ("created_by","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "resource_preferences_snoozed" ON "resource_preferences" USING btree ("created_by","resource_kind","snoozed_until") WHERE snoozed_until IS NOT NULL;--> statement-breakpoint
CREATE INDEX "session_api_page" ON "session" USING btree ("organization_id","created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_api_provider_page" ON "session" USING btree ("organization_id","provider","created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_api_activity_page" ON "session" USING btree ("organization_id","last_activity_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_any_page" ON "session" USING btree ("created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_by_activity" ON "session" USING btree ("last_activity_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_by_parent" ON "session" USING btree ("parent_session_id","created_at" desc,"session_id" desc);--> statement-breakpoint
CREATE INDEX "session_by_project_path" ON "session" USING btree ("project_path","last_activity_at");--> statement-breakpoint
CREATE INDEX "session_by_place" ON "session" USING btree ("place","last_activity_at");--> statement-breakpoint
CREATE INDEX "session_transcripts_search_pending" ON "session_transcripts" USING btree ("session_id") WHERE search_text = '';--> statement-breakpoint
CREATE INDEX "task_comments_by_task" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_external" ON "task_comments" USING btree ("task_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_external_links_external" ON "task_external_links" USING btree ("provider","external_key","external_id");--> statement-breakpoint
CREATE INDEX "tasks_api_page" ON "tasks" USING btree ("organization_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "tasks_api_project_page" ON "tasks" USING btree ("organization_id","project_key","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "tasks_api_status_page" ON "tasks" USING btree ("organization_id","status","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_webhook" ON "webhook_deliveries" USING btree ("webhook_id","arrived_at","id");--> statement-breakpoint
CREATE INDEX "webhooks_by_creator" ON "webhooks" USING btree ("organization_id","created_by");--> statement-breakpoint
CREATE INDEX "webhooks_by_project" ON "webhooks" USING btree ("project");--> statement-breakpoint
CREATE INDEX "work_reviewers_reviewer" ON "work_reviewers" USING btree ("reviewer_id","requested_at" desc);--> statement-breakpoint
CREATE INDEX "work_storage_due" ON "work_storage" USING btree ("provider","due_at") WHERE due_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "works_api_page" ON "works" USING btree ("organization_id","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "works_api_type_page" ON "works" USING btree ("organization_id","type","created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX "works_by_session" ON "works" USING btree ("session_id") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_projects_by_repository" ON "workspace_projects" USING btree ("organization_id","repository_key");
--> statement-breakpoint
-- The works search index on Postgres (packages/server/src/db/search-index.ts):
-- a stored tsvector generated from the title (weight A) and content (weight B)
-- under a GIN index. Generated, so every write keeps it in step with no trigger.
ALTER TABLE "works" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A')
  || setweight(to_tsvector('english', coalesce("content", '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING GIN ("search");
--> statement-breakpoint
-- The session search index on Postgres: a stored tsvector generated from each
-- mirrored message's `search_text` under a GIN index.
ALTER TABLE "session_transcripts" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "search_text")) STORED;
--> statement-breakpoint
CREATE INDEX "session_transcripts_search_idx" ON "session_transcripts" USING GIN ("search");
