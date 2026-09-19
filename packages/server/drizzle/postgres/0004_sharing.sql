CREATE TABLE "resource_owner" (
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "resource_owner_resource_kind_resource_id_pk" PRIMARY KEY("resource_kind","resource_id")
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
CREATE UNIQUE INDEX "share_grant_subject" ON "share_grant" USING btree ("resource_kind","resource_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "share_grant_resource_idx" ON "share_grant" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "share_grant_secret_idx" ON "share_grant" USING btree ("link_secret_hash") WHERE link_secret_hash IS NOT NULL;