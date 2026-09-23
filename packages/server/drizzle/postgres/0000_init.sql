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
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL,
	"duration_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"attrs" text DEFAULT '{}' NOT NULL,
	CONSTRAINT "insight_spans_organization_id_host_id_span_id_pk" PRIMARY KEY("organization_id","host_id","span_id")
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
CREATE TABLE "resource_owner" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "resource_owner_resource_kind_resource_id_pk" PRIMARY KEY("resource_kind","resource_id")
);
--> statement-breakpoint
CREATE TABLE "runner_cursors" (
	"organization_id" text NOT NULL,
	"host_id" text NOT NULL,
	"stream" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_cursors_organization_id_host_id_stream_pk" PRIMARY KEY("organization_id","host_id","stream")
);
--> statement-breakpoint
CREATE TABLE "session_records" (
	"session_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"owner_user_id" text,
	"provider" text NOT NULL,
	"project_path" text NOT NULL,
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
	"last_activity_at" bigint NOT NULL,
	"size" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_transcripts" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"runner_host_id" text NOT NULL,
	"message" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "session_transcripts_organization_id_session_id_position_pk" PRIMARY KEY("organization_id","session_id","position")
);
--> statement-breakpoint
CREATE TABLE "share_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"link_secret_hash" text,
	"link_secret" text,
	"granted_by_user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
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
	"value" integer NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor" text DEFAULT 'user' NOT NULL,
	"actor_label" text,
	"from_value" text,
	"to_value" text,
	"target_kind" text,
	"target_scope" text,
	"target_key" text,
	"target_title" text,
	"created_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL
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
CREATE TABLE "task_links" (
	"task_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_scope" text DEFAULT '' NOT NULL,
	"target_key" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"url" text,
	"created_by" text DEFAULT 'user' NOT NULL,
	"origin_session_id" text,
	"linked_at" bigint NOT NULL,
	"pinned" integer DEFAULT 0 NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "task_links_task_id_kind_target_scope_target_key_pk" PRIMARY KEY("task_id","kind","target_scope","target_key")
);
--> statement-breakpoint
CREATE TABLE "task_session_links" (
	"task_id" text NOT NULL,
	"session_id" text NOT NULL,
	"role" text DEFAULT 'working' NOT NULL,
	"pr" text,
	"injected_at" bigint,
	"linked_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "task_session_links_task_id_session_id_pk" PRIMARY KEY("task_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"short_id" integer,
	"project_key" text,
	"parent_id" text,
	"title" text NOT NULL,
	"title_source" text DEFAULT 'prompt' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'inbox' NOT NULL,
	"kind" text DEFAULT 'task' NOT NULL,
	"assignee" text,
	"due_date" text,
	"priority" text,
	"labels" text DEFAULT '[]' NOT NULL,
	"pr" text,
	"source" text DEFAULT 'user' NOT NULL,
	"origin_session_id" text,
	"origin_automation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"triaged_at" bigint,
	"done_at" bigint,
	"last_read_at" bigint,
	"organization_id" text DEFAULT 'local' NOT NULL,
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
CREATE TABLE "work_annotations" (
	"work_id" text PRIMARY KEY NOT NULL,
	"data" text,
	"updated_at" bigint,
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_revisions" (
	"work_id" text NOT NULL,
	"rev" integer NOT NULL,
	"content" text,
	"updated_at" bigint,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "work_revisions_work_id_rev_pk" PRIMARY KEY("work_id","rev")
);
--> statement-breakpoint
CREATE TABLE "works" (
	"id" text PRIMARY KEY NOT NULL,
	"storage" text DEFAULT 'local' NOT NULL,
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
	"organization_id" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"repository_key" text NOT NULL,
	"display_name" text NOT NULL,
	"default_branch" text,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_external_links" ADD CONSTRAINT "task_external_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_links" ADD CONSTRAINT "task_session_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indexed_plans_by_project" ON "indexed_plans" USING btree ("provider","project_root","timestamp" desc);--> statement-breakpoint
CREATE INDEX "indexed_plans_by_cwd" ON "indexed_plans" USING btree ("provider","cwd","timestamp" desc);--> statement-breakpoint
CREATE INDEX "insight_log_events_span_idx" ON "insight_log_events" USING btree ("organization_id","host_id","span_id","occurred_at");--> statement-breakpoint
CREATE INDEX "insight_spans_session_idx" ON "insight_spans" USING btree ("organization_id","session_id","started_at") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "insight_spans_time_idx" ON "insight_spans" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "session_records_by_project" ON "session_records" USING btree ("organization_id","project_path","last_activity_at" desc);--> statement-breakpoint
CREATE INDEX "session_records_by_provider" ON "session_records" USING btree ("organization_id","provider","last_activity_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "share_grant_subject" ON "share_grant" USING btree ("resource_kind","resource_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "share_grant_resource_idx" ON "share_grant" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "share_grant_secret_idx" ON "share_grant" USING btree ("link_secret_hash") WHERE link_secret_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_comments_by_task" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_external" ON "task_comments" USING btree ("task_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_events_by_task" ON "task_events" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_external_links_external" ON "task_external_links" USING btree ("provider","external_key","external_id");--> statement-breakpoint
CREATE INDEX "task_links_by_target" ON "task_links" USING btree ("kind","target_scope","target_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_pr_links_by_url" ON "task_links" USING btree ("task_id","url") WHERE kind = 'pr' AND url IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_session_links_by_session" ON "task_session_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tasks_by_project" ON "tasks" USING btree ("project_key","status","updated_at" desc);--> statement-breakpoint
CREATE INDEX "tasks_by_status" ON "tasks" USING btree ("status","created_at" desc);--> statement-breakpoint
CREATE INDEX "tasks_parent" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_projects_by_repository" ON "workspace_projects" USING btree ("organization_id","repository_key");--> statement-breakpoint
-- The works search index on Postgres (packages/server/src/db/search-index.ts):
-- a stored tsvector generated from the title (weight A) and content (weight B)
-- under a GIN index. Generated, so every write keeps it in step with no trigger.
ALTER TABLE "works" ADD COLUMN "search" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("title", '')), 'A')
  || setweight(to_tsvector('english', coalesce("content", '')), 'B')
) STORED;
--> statement-breakpoint
CREATE INDEX "works_search_idx" ON "works" USING GIN ("search");
