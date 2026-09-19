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
CREATE INDEX "indexed_plans_by_project" ON "indexed_plans" USING btree ("provider","project_root","timestamp" desc);--> statement-breakpoint
CREATE INDEX "indexed_plans_by_cwd" ON "indexed_plans" USING btree ("provider","cwd","timestamp" desc);