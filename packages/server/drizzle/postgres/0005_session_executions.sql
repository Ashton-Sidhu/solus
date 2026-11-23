CREATE TABLE "session_executions" (
	"session_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"revision" integer NOT NULL,
	"execution" text NOT NULL,
	CONSTRAINT "session_executions_session_id_tool_id_pk" PRIMARY KEY("session_id","tool_id")
);
