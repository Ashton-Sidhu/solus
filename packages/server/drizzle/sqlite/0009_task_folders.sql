CREATE TABLE `task_folders` (
	`root` text PRIMARY KEY NOT NULL,
	`real_root` text NOT NULL,
	`codebase_id` text,
	`session_id` text,
	`anchor` text NOT NULL,
	`primary_path` text NOT NULL,
	`primary_repository_path` text NOT NULL,
	`primary_is_worktree` integer NOT NULL,
	`branch` text NOT NULL,
	`repositories` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_folders_by_real_root` ON `task_folders` (`real_root`);