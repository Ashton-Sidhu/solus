CREATE TABLE "runner_cursors" (
	"organization_id" text NOT NULL,
	"host_id" text NOT NULL,
	"stream" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runner_cursors_organization_id_host_id_stream_pk" PRIMARY KEY("organization_id","host_id","stream")
);
