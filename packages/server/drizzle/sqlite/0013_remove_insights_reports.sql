-- Insights reports are no longer shared (organization-scope §4): the works that held them go, with their rows.
DELETE FROM `work_annotations` WHERE `work_id` IN (SELECT `id` FROM `works` WHERE `type` = 'insights-report');--> statement-breakpoint
DELETE FROM `work_revisions` WHERE `work_id` IN (SELECT `id` FROM `works` WHERE `type` = 'insights-report');--> statement-breakpoint
DELETE FROM `work_live_docs` WHERE `work_id` IN (SELECT `id` FROM `works` WHERE `type` = 'insights-report');--> statement-breakpoint
DELETE FROM `work_reviewers` WHERE `work_id` IN (SELECT `id` FROM `works` WHERE `type` = 'insights-report');--> statement-breakpoint
DELETE FROM `share_grant` WHERE `resource_kind` = 'work' AND `resource_id` IN (SELECT `id` FROM `works` WHERE `type` = 'insights-report');--> statement-breakpoint
DELETE FROM `works` WHERE `type` = 'insights-report';
