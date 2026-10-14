-- A project's default name is its repository's name, without the owner: rename the projects that still carry the old `owner/repo` default.
UPDATE `workspace_projects`
SET `display_name` = substr(`display_name`, length(rtrim(`display_name`, replace(`display_name`, '/', ''))) + 1)
WHERE `display_name` LIKE '%/%' AND `display_name` = substr(`repository_key`, instr(`repository_key`, '/') + 1);
