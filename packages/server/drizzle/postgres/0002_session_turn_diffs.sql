CREATE TABLE "session_turn_diffs" (
	"organization_id" text NOT NULL,
	"session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"runner_host_id" text NOT NULL,
	"ended_at" bigint NOT NULL,
	"files_changed" integer NOT NULL,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"patch" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "session_turn_diffs_session_id_turn_index_organization_id_pk" PRIMARY KEY("session_id","turn_index","organization_id")
);
