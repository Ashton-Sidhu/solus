CREATE TABLE "session_repositories" (
	"cloud_scope" text NOT NULL,
	"session_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"repository" text NOT NULL,
	"storage_scope" text NOT NULL,
	"head" text,
	"synced_turn" integer DEFAULT 0 NOT NULL,
	"last_run_host_id" text,
	"running_host_id" text,
	"running_since" bigint,
	"title" text,
	"provider" text,
	"model" text,
	"repository_key" text,
	"branch" text,
	"last_activity_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "session_repositories_cloud_scope_session_id_pk" PRIMARY KEY("cloud_scope","session_id")
);
--> statement-breakpoint
CREATE INDEX "session_repositories_owner" ON "session_repositories" USING btree ("owner_user_id","last_activity_at" desc);