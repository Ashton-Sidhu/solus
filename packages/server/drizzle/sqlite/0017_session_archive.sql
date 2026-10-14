ALTER TABLE `session_states` ADD `archived_at` integer;--> statement-breakpoint
-- Archive the sessions that had no activity for 30 days and wait on no pull
-- request, once, before any client reads the list (docs/plans/session-archive.md).
-- The idle sweep in PR sync archives the later ones.
INSERT INTO `session_states` (`session_id`, `organization_id`)
SELECT `session_id`, `organization_id` FROM `session_records`
WHERE `last_activity_at` < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
ON CONFLICT (`session_id`) DO NOTHING;--> statement-breakpoint
UPDATE `session_states` SET `archived_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `archived_at` IS NULL
  AND `session_id` IN (
    SELECT `session_id` FROM `session_records`
    WHERE `last_activity_at` < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
  )
  AND COALESCE(`last_prompt_at`, 0) < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
  AND COALESCE(`unsettled_at`, 0) < CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 2592000000
  AND (`snoozed_until` IS NULL OR `snoozed_until` <= CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  AND NOT EXISTS (
    SELECT 1 FROM `session_pull_requests`
    WHERE `session_pull_requests`.`session_id` = `session_states`.`session_id`
      AND `session_pull_requests`.`source` <> 'dismissed'
      AND (`session_pull_requests`.`pr_state` IS NULL OR `session_pull_requests`.`pr_state` NOT IN ('merged', 'closed', 'missing'))
  );
