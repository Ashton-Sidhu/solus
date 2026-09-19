CREATE TABLE "credential_locks" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"host_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "credential_locks_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "credential_vault" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"ciphertext" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" bigint,
	"connected_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "credential_vault_user_id_provider_pk" PRIMARY KEY("user_id","provider")
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
CREATE TABLE "organization_members" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"last_seen_at" bigint NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "session_prompt_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"session_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"author_display_name" text,
	"text" text NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"claimed_by_host_id" text,
	"claim_epoch" integer,
	"created_at" bigint NOT NULL,
	"claimed_at" bigint,
	"settled_at" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "session_runner_leases" (
	"session_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"host_id" text NOT NULL,
	"epoch" integer DEFAULT 1 NOT NULL,
	"expires_at" bigint NOT NULL
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
CREATE INDEX "insight_log_events_span_idx" ON "insight_log_events" USING btree ("organization_id","host_id","span_id","occurred_at");--> statement-breakpoint
CREATE INDEX "insight_spans_session_idx" ON "insight_spans" USING btree ("organization_id","session_id","started_at") WHERE session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "insight_spans_time_idx" ON "insight_spans" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "session_prompt_queue_session_idx" ON "session_prompt_queue" USING btree ("organization_id","session_id","created_at");--> statement-breakpoint
CREATE INDEX "session_prompt_queue_waiting_idx" ON "session_prompt_queue" USING btree ("organization_id","state","created_at");