CREATE TABLE "task_snoozes" (
	"task_id" text NOT NULL,
	"person_key" text NOT NULL,
	"snoozed_until" bigint NOT NULL,
	"snooze_note" text,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "task_snoozes_task_id_person_key_pk" PRIMARY KEY("task_id","person_key")
);
--> statement-breakpoint
ALTER TABLE "task_snoozes" ADD CONSTRAINT "task_snoozes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_snoozes_by_person" ON "task_snoozes" USING btree ("person_key","snoozed_until");