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
ALTER TABLE "work_revisions" ADD CONSTRAINT "work_revisions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;