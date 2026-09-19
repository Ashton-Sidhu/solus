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
CREATE INDEX "session_records_by_project" ON "session_records" USING btree ("organization_id","project_path","last_activity_at" desc);--> statement-breakpoint
CREATE INDEX "session_records_by_provider" ON "session_records" USING btree ("organization_id","provider","last_activity_at" desc);