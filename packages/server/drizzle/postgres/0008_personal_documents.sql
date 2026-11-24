CREATE TABLE "personal_documents" (
	"organization_id" text DEFAULT 'local' NOT NULL,
	"person_key" text NOT NULL,
	"kind" text NOT NULL,
	"content" text DEFAULT '{}' NOT NULL,
	"source" text NOT NULL,
	"account_revision" integer,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "personal_documents_organization_id_person_key_kind_pk" PRIMARY KEY("organization_id","person_key","kind")
);
