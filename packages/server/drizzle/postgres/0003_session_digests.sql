CREATE TABLE "session_artifact_copies" (
	"session_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"artifacts" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_digests" (
	"session_id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"digest" text NOT NULL,
	"updated_at" bigint NOT NULL
);
