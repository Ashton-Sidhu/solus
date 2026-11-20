# Task issue parity

The accepted scope is the twelve High and Medium product changes from the
17 November 2026 issue comparison. GitLab, Azure DevOps, Forgejo/Gitea and
GitHub Enterprise remain outside this change.

## Ownership and vocabulary

Providers own tasks, comments, history, reactions, templates and PR
relationships. Personal settings own task sources and saved views. Solus
owns work attachments. Task sources are added from the Tasks page, with the
person's action. Project panels and new-session drafts do not offer sources.

Linear is a task provider. A Linear team is a task source. Credentials belong
to the acting person and must follow the vault's host/account policy. Never
put a token in personal settings, a source, a list response or a log.

Provider history and Solus activity are distinct. A provider PR relationship
says whether the provider will close an issue on merge; a Solus attachment
does not imply that behavior. External URL reads do not add a source.

## Acceptance checklist

- [x] Native mobile task list, details, source setup and supported writes.
- [x] Repository source setup on the Tasks page. The project-panel offer was removed by product decision on 19 November 2026.
- [x] Linear connection, team sources, reads, creation and supported writes.
- [x] Named saved views with create, apply, rename and remove.
- [x] Authored and mentioned involvement filters.
- [x] Provider history, separate from Solus activity.
- [x] Provider-reported PR links and closing relationships.
- [x] Explicit list continuation with retained rows and retry.
- [x] Multiple assignees where the provider supports them.
- [x] Issue and comment reactions where supported.
- [x] External issue URL inspection with explicit access and write state.
- [x] Provider templates in the task composer, with native form fallback.

All product capability applies to desktop, web and native mobile. Shared RPC
contracts carry host operations. Client stores own loading, refresh, stale
guards and commands. A provider's unsupported operation has an explicit
reason. Tests use fixtures and temporary databases. No app build, live data
write, real agent turn or unrequested development server is permitted.

## Validation and limits

253 focused tests pass: 243 task tests, two native dispatch tests and eight
account vault tests. Mobile and contract type checks pass. The account site
check has no site errors.

Focused fixtures cover provider writes, source continuation, personal views,
account changes, request failures and native task dispatch. Linear GraphQL
queries and GitHub inspection, template and reaction queries were checked
against provider schemas. The account vault implementation lives in
`/Users/sidhu/solus-cloud`; its focused tests cover checking, storing, reading,
replacing and removing the Linear key.

Mention search is supported by GitHub. Jira and Linear return an explicit
unsupported message. Their APIs do not provide a reliable issue mention filter.
Linear native forms preserve template fields. Linear PR attachments do not
report closing behavior or live PR state, so Solus shows references with unknown
state. Comment reactions are loaded for the first 100 provider comments; the UI
shows when more comments exist. Older provider history and source issue lists
have explicit continuation controls.

No interactive app, browser or device verification was run. Package-wide checks
still report unrelated errors in the existing checkout. No migration was applied
to live data, no build was run, and no changes were deployed.
