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
ALTER TABLE "work_live_docs" ADD COLUMN "last_author" text;--> statement-breakpoint
ALTER TABLE "work_live_docs" ADD COLUMN "body_version" integer;--> statement-breakpoint
ALTER TABLE "work_live_docs" ADD COLUMN "needs_projection" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_storage_bodies" ADD CONSTRAINT "work_storage_bodies_work_id_work_storage_work_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."work_storage"("work_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_storage_due" ON "work_storage" USING btree ("provider","due_at") WHERE due_at IS NOT NULL;