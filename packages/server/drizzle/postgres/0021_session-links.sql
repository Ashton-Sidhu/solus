CREATE TABLE "session_links" (
	"session_id" text NOT NULL,
	"link_id" text NOT NULL,
	"target" text NOT NULL,
	"title" text NOT NULL,
	"created_by" text NOT NULL,
	"linked_at" bigint NOT NULL,
	"organization_id" text DEFAULT 'local' NOT NULL,
	CONSTRAINT "session_links_session_id_link_id_pk" PRIMARY KEY("session_id","link_id")
);
