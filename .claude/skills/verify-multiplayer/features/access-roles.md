# Access roles

Every resource on a host follows one rule (`roleOf`, docs/plans/access-model.md §2.3). A member sees and changes their own automations; a host administrator sees and changes all of them. A notification is its recipient's alone. In Insights a member reads the turns they ran; an administrator reads every turn, and only an administrator runs SQL. Every member lists the organization's projects; only a project's owner or an administrator changes or removes one. A browser profile is its owner's alone, an administrator included. A guest reaches none of these.

## Sub-features

- `automation-owner` — a member lists, reads, changes, runs, and deletes only their own automation; an administrator does all of it on every automation; `automation.changed` reaches only the people with a role on it.
- `notification-personal` — a run's notification reaches its owner only; nobody else lists or marks it, an administrator included.
- `insights-own-turns` — the turn page, its summary, and a trace hold the reader's own turns; an administrator reads all; `metricsRunSql` is an administrator's.
- `project-owner` — every member lists the directory; renaming or removing a project takes its owner or an administrator.
- `guest-none` — a guest is refused every one of these reads.
- `browser-profile-personal` — bob's browser profile is listed, renamed, cleared, made a default, and deleted by bob alone; dan and alice are answered as if it does not exist (docs/plans/member-isolation.md §6).
- `integration-personal` — an MCP server is its owner's alone (not driven by the Lab; see Gotchas).

## How to get to it (user POV)

- Automations page: the list, an automation's detail, Run, Pause, Edit, Delete.
- The notifications hub (the bell): the list and read and archive marks.
- Insights: the turn table, its totals, a turn's waterfall, and the SQL editor.
- Projects: the organization's project list, rename and remove.
- The browser pane's profile chip: the list of profiles, rename, delete, and Clear browser data.

## Driving it with the Lab

Preconditions:

- `DOCTOR OK` (Lab-issuer mode; no cloud).

- **Run.** `bun lab run access-roles` (both host flavors). bob and dan connect pasted-token seats, so the automation's run and their turns run on the mock backend; the scenario disconnects both seats at its end.
- **Proof.** Each run's report has 0 failed checks. The checks are from the other person's side: dan's lists, dan's refused calls (`FORBIDDEN`), the `automation.changed` events dan did not receive, the notification only bob lists, and the turn page dan reads next to alice's.

## Gotchas

- PASS (2026-10-14) on both flavors.
- Cookie import is not driven: it reads a real browser's cookie store on the host. That one person's import never reaches another's jar is proved in `tests/unit/browser-cookie-import.test.ts` and `tests/unit/browser-profiles.test.ts`. The profile handlers refuse another person's profile with "No browser profile …", not `FORBIDDEN`: its id names nothing for the caller.
- An MCP server is not driven here: `integrationCreate` probes an HTTPS address, and the Lab's fake MCP server (`tests/unit/integrations/fake-servers.ts`) is plain HTTP on loopback, which the probe refuses. The rule is proved on records in `tests/unit/access.test.ts` ("on integration rows") and in cloud mode by `account-reads` for the owner.
- The seats scenario expects dan to have no seat: this scenario disconnects bob's and dan's seats at its end. A failure part way leaves them connected; run `seats` alone after fixing it.
- On a personal host alice is its owner, an administrator; on a managed host she is the organization owner, also an administrator. Both flavors give her `editor` on bob's automation and project.
- The pull-request rule (a change to a pull request a session links needs `session.edit` on it) needs a code host; it is proved in `tests/unit/pr-merge-broadcast.test.ts`, not here.
