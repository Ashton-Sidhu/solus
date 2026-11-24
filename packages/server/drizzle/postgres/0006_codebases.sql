CREATE TABLE "codebases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"roots" text DEFAULT '[]' NOT NULL,
	"updated_at" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "codebase_id" text;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "attached_folders" text DEFAULT '[]' NOT NULL;