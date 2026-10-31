CREATE INDEX `acl_entry_by_subject` ON `acl_entry` (`subject_kind`,`subject_id`,`resource_kind`,`resource_id`);--> statement-breakpoint
CREATE INDEX `session_pull_requests_open` ON `session_pull_requests` (`session_id`) WHERE source <> 'dismissed' AND (pr_state IS NULL OR pr_state NOT IN ('merged', 'closed', 'missing'));--> statement-breakpoint
CREATE INDEX `session_records_by_activity` ON `session_records` (`last_activity_at`);--> statement-breakpoint
CREATE INDEX `session_views_snoozed` ON `session_views` (`person_key`,`session_id`) WHERE snoozed_until IS NOT NULL;