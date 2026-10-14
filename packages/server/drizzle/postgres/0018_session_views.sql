CREATE TABLE "session_views" (
	"session_id" text NOT NULL,
	"person_key" text NOT NULL,
	"archived_at" bigint,
	"snoozed_until" bigint,
	"snooze_note" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "session_views_session_id_person_key_pk" PRIMARY KEY("session_id","person_key")
);
--> statement-breakpoint
CREATE INDEX "session_views_by_person" ON "session_views" USING btree ("person_key","session_id");--> statement-breakpoint
ALTER TABLE "session_states" DROP COLUMN "snoozed_until";--> statement-breakpoint
ALTER TABLE "session_states" DROP COLUMN "snooze_note";--> statement-breakpoint
ALTER TABLE "session_states" DROP COLUMN "archived_at";