CREATE TABLE `personal_documents` (
	`organization_id` text DEFAULT 'local' NOT NULL,
	`person_key` text NOT NULL,
	`kind` text NOT NULL,
	`content` text DEFAULT '{}' NOT NULL,
	`source` text NOT NULL,
	`account_revision` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `person_key`, `kind`)
);
