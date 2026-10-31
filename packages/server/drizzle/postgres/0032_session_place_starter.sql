ALTER TABLE "session_records" ADD COLUMN "place" text;--> statement-breakpoint
ALTER TABLE "session_records" ADD COLUMN "started_by" text;--> statement-breakpoint
CREATE INDEX "session_records_by_place" ON "session_records" USING btree ("place","last_activity_at");