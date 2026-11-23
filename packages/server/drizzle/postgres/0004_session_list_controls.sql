ALTER TABLE "personal_resource_state" ADD COLUMN "pin_order_key" text;--> statement-breakpoint
ALTER TABLE "personal_resource_state" ADD COLUMN "active_order_key" text;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "auto_settle_disabled_at" bigint;