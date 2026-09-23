# Cloud work change checks

Decision: replace live work editing with ordinary saves and upstream change
notices. Applies to documents, diagrams, slides and HTML artifacts on desktop,
web and mobile. Session multiplayer remains.

## Manual check

1. Open one cloud document in two clients. Save a change in A. B keeps its copy
   and shows a notice within 30 seconds, or when B regains focus.
2. In B, select Reload saved copy. It now shows A's saved content.
3. Type a draft in B, then save another change from A. B keeps its draft. A save
   from B is refused; the notice offers Discard edits and reload. Copy the draft
   before choosing that action if it is needed.
4. Save from B after a reload. B must not report its own save as a remote change.
5. Disconnect B. A failed check/reload leaves B's copy in place with an error.
   Reconnect and refocus; B can check and reload. Delete the work or remove B's
   access: the check fails without replacing B's copy with an empty document.
6. Repeat for diagram saves, agent updates to an HTML artifact, and slides.
   No work avatars, cursors, live merges, or shared HTML source editor appear.
   Document Markdown source remains editable. Google-linked content stays
   read-only. Check keyboard operation, light/dark mode and phone layout.
7. In a shared session, confirm presence, typing, prompt authors, queue authors,
   follow and permissions still work.

## Automated checks

- `bun scripts/test-unit.ts cloud-work-copy.test work-version.test share-commit.test presence-manager.test presence-people.test presence-watch.test access-policy.test`
- Run `work-version.test` and `share-commit.test` with `--engine=postgres`
  against a disposable database.
- `bun run build:test`, then `bun scripts/lab.ts run cloud-sharing` and
  `bun scripts/lab.ts run presence`. Add `POSTGRES_ADMIN_URL` for both engines.

No live data, provider credentials, deployment or production migration is needed.

## Verification — 2026-09-19

- Focused unit files: 10/10 SQLite; work version and share commit: 2/2 Postgres.
- Cloud-sharing Lab: 42 checks on SQLite and disposable Postgres 17.
- Session presence Lab: 32 checks on personal and 34 on managed hosts.
- Contracts typecheck and focused lint pass. Production and test builds pass.
- Repository typechecks remain non-clean. The WorkPane SessionMeta mismatch
  predates this change; no errors were reported in the new copy store.
- No new browser/native-device pass, production deployment, migration, commit
  or push. Temporary Postgres was stopped by its captured container ID.

Review note: the existing WorksStore is over 600 lines. New polling/copy logic
is kept in cloud-work-copy.store.svelte.ts rather than expanding that store.
