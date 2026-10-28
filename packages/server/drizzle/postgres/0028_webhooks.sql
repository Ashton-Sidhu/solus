CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"received_at" bigint NOT NULL,
	"arrived_at" bigint NOT NULL,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"replay_of" text,
	"request" text NOT NULL,
	"verification_failure" text,
	"actions" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_seen_keys" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "webhook_seen_keys_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	"owner_key" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"project" text,
	"verification" text NOT NULL,
	"replay_key" text,
	"actions" text NOT NULL,
	"created_by" text NOT NULL,
	"copied_url_hash" text,
	"lost_count" integer DEFAULT 0 NOT NULL,
	"lost_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_webhook" ON "webhook_deliveries" USING btree ("webhook_id","arrived_at","id");--> statement-breakpoint
CREATE INDEX "webhook_seen_keys_by_expiry" ON "webhook_seen_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "webhooks_by_owner" ON "webhooks" USING btree ("organization_id","owner_key");--> statement-breakpoint
CREATE INDEX "webhooks_by_project" ON "webhooks" USING btree ("project");