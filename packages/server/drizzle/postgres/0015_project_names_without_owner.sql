-- A project's default name is its repository's name, without the owner: rename the projects that still carry the old `owner/repo` default.
UPDATE "workspace_projects"
SET "display_name" = regexp_replace("display_name", '^.*/', '')
WHERE "display_name" LIKE '%/%' AND "display_name" = substring("repository_key" from position('/' in "repository_key") + 1);
