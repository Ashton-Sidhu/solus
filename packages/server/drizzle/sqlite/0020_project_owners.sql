-- Every project has one owner (docs/plans/access-model.md §2.2): the person who
-- added it, taken from `created_by` (a member's account id). A row with none keeps
-- '', which no person holds: only an administrator changes it.
ALTER TABLE `workspace_projects` ADD `owner_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `workspace_projects` SET `owner_key` = COALESCE(`created_by`, '');
