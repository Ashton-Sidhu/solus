ALTER TABLE "acl_entry" ADD COLUMN "granted_at" bigint;--> statement-breakpoint
ALTER TABLE "acl_entry" ADD COLUMN "granted_by_name" text;