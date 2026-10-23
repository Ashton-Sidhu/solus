DROP TABLE "runner_cursors" CASCADE;--> statement-breakpoint
CREATE TABLE "runner_delivery_cursors" (
	"organization_id" text NOT NULL,
	"host_id" text NOT NULL,
	"actor_user_id" text DEFAULT '' NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_delivery_cursors_organization_id_host_id_actor_user_id_pk" PRIMARY KEY("organization_id","host_id","actor_user_id")
);
