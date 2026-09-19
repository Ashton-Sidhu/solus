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
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_external_links" ADD CONSTRAINT "task_external_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_links" ADD CONSTRAINT "task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_session_links" ADD CONSTRAINT "task_session_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comments_by_task" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_comments_external" ON "task_comments" USING btree ("task_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_events_by_task" ON "task_events" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_external_links_external" ON "task_external_links" USING btree ("provider","external_key","external_id");--> statement-breakpoint
CREATE INDEX "task_links_by_target" ON "task_links" USING btree ("kind","target_scope","target_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_pr_links_by_url" ON "task_links" USING btree ("task_id","url") WHERE kind = 'pr' AND url IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_session_links_by_session" ON "task_session_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "tasks_by_project" ON "tasks" USING btree ("project_key","status","updated_at" desc);--> statement-breakpoint
CREATE INDEX "tasks_by_status" ON "tasks" USING btree ("status","created_at" desc);--> statement-breakpoint
CREATE INDEX "tasks_parent" ON "tasks" USING btree ("parent_id");