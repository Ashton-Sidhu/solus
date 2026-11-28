# Data

## Migrations

```sql
-- migrations/0001_notes.sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_created ON notes (created_at);
```

- Name a file with four digits, an underscore, and a lower-case name: `0002_add_done.sql`. Solus applies the new files of a version in number order, all in one transaction. Do not write `BEGIN` or `COMMIT` in a file.
- A migration that fails stops the deploy and applies nothing: not that file, and not the new files before it. The version before it keeps running on the schema it had, and the receipt says the SQLite error.
- Never edit, rename, or remove a migration that a deployed version has, and never give a new file a number before one. Solus keeps a hash of each applied file and refuses such a deploy. Add a new file with the next number.
- A deploy never deletes data. An earlier version can be made active again, and it then runs against the newer schema: write changes that old code can live with (add a column with a default; do not rename one in the same step).
- When you make the starter into another app before its first deploy, replace `0001_notes.sql`. Once a version is deployed, only add files.

Try an operation's SQL before you deploy: `sqlite3` or `node:sqlite` in a scratch file is faster than a deploy.

## Writes and retries

- Bind values with `?` parameters. Use a transaction when a read and write must agree, or a single conditional update when it can enforce the same rule. Use a unique constraint for facts that must only be written once, such as a provider event ID.
- Keep network calls outside SQLite transactions. A remote action can succeed while saving its response fails. For an action that must be recoverable, record it with a stable ID, use that ID for the remote service's idempotency key when supported, and save the outcome. For longer jobs, use [workflow steps](workflows.md#how-a-run-stays-alive).

## Storage

`storage` from `@solus/app` is key-value data for a UI with no backend: `storage.get`, `set`, `delete`, `keys`. A value is at most 1 MiB and the whole app holds 8 MiB. It belongs to the app, not to one viewer. Use the database for anything a schedule or an agent also reads.

Never keep a secret in `storage` or in the database.
