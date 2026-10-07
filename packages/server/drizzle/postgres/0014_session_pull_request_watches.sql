CREATE TABLE "session_pull_request_watches" (
	"session_id" text NOT NULL,
	"repository" text NOT NULL,
	"number" integer NOT NULL,
	"watch_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"state" text NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "session_pull_request_watches_session_id_repository_number_pk" PRIMARY KEY("session_id","repository","number")
);
