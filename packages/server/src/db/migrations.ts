import type { DatabaseSync } from 'node:sqlite'

/**
 * The host's hand-written SQLite migrations, indexed by `PRAGMA user_version`.
 * A released slot is never rewritten: a database past that index skips the
 * replacement forever. Slots that once created or changed the tasks tables
 * are reserved; those tables are generated from the ported schema now.
 */
const migrations = [
  `
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  name TEXT,
  enabled INTEGER,
  favorite INTEGER,
  action TEXT,
  trigger_config TEXT,
  next_run_at INTEGER,
  last_run TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  started_at INTEGER,
  finished_at INTEGER,
  status TEXT,
  output TEXT,
  data TEXT
);
CREATE INDEX runs_by_automation ON automation_runs(automation_id, started_at DESC);

CREATE TABLE works (
  id TEXT PRIMARY KEY,
  storage TEXT NOT NULL,
  title TEXT,
  preview TEXT,
  type TEXT,
  session_id TEXT,
  agent_provider TEXT,
  cwd TEXT,
  pinned INTEGER,
  content TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  meta TEXT
);

CREATE TABLE work_revisions (
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  content TEXT,
  updated_at INTEGER,
  PRIMARY KEY (work_id, rev)
);

CREATE TABLE work_annotations (
  work_id TEXT PRIMARY KEY,
  data TEXT,
  updated_at INTEGER
);

CREATE TABLE plan_annotations (
  session_id TEXT NOT NULL,
  plan_tool_use_id TEXT NOT NULL,
  status TEXT,
  title TEXT,
  bookmarked INTEGER,
  bookmarked_at INTEGER,
  project_path TEXT,
  cwd TEXT,
  comments TEXT,
  updated_at INTEGER,
  PRIMARY KEY (session_id, plan_tool_use_id)
);

CREATE TABLE pinned_sessions (
  session_id TEXT PRIMARY KEY,
  provider TEXT,
  title TEXT,
  cwd TEXT,
  pinned_at INTEGER
);

CREATE TABLE projects (
  key TEXT PRIMARY KEY,
  path TEXT,
  folder_name TEXT,
  added_at INTEGER
);

CREATE TABLE recent_projects (
  path TEXT PRIMARY KEY,
  folder_name TEXT,
  last_opened INTEGER
);

CREATE TABLE project_config (
  project_key TEXT PRIMARY KEY,
  config TEXT,
  updated_at INTEGER
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE session_files (
  path TEXT PRIMARY KEY,
  provider TEXT,
  size INTEGER,
  mtime INTEGER,
  last_offset INTEGER DEFAULT 0,
  indexed_at INTEGER
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  cwd TEXT,
  project_path TEXT,
  project_key TEXT,
  is_worktree INTEGER,
  slug TEXT,
  first_message TEXT,
  last_timestamp INTEGER,
  message_count INTEGER,
  size INTEGER
);
CREATE INDEX sessions_by_project ON sessions(project_path, last_timestamp DESC);

CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  uuid TEXT,
  role TEXT,
  ts INTEGER,
  text TEXT
);
CREATE INDEX msgs_by_session ON session_messages(session_id, ts);

CREATE VIRTUAL TABLE session_fts USING fts5(
  text,
  content='session_messages',
  content_rowid='id',
  tokenize='porter unicode61'
);
`,
  `
CREATE INDEX sessions_by_provider_project
ON sessions(provider, project_path, last_timestamp DESC);
`,
  `
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
`,
  `
ALTER TABLE sessions ADD COLUMN project_root TEXT;
CREATE INDEX sessions_by_project_root ON sessions(project_root, last_timestamp DESC);
`,
  // Full-text index over locally-stored works, for find_works. Standalone
  // (not content='works') on purpose: works.id is a TEXT primary key, so the
  // works rowid is implicit and not guaranteed stable — keying on work_id avoids
  // that coupling. Works are few and small, so the duplicated text costs little.
  // Project-storage works live in files, not this table, and are searched by
  // reading them (see folio/work-search.ts).
  `
CREATE VIRTUAL TABLE works_fts USING fts5(
  work_id UNINDEXED,
  title,
  content,
  tokenize='porter unicode61'
);

INSERT INTO works_fts(work_id, title, content)
  SELECT id, COALESCE(title, ''), COALESCE(content, '') FROM works WHERE storage = 'local';

CREATE TRIGGER works_fts_ai AFTER INSERT ON works WHEN new.storage = 'local' BEGIN
  INSERT INTO works_fts(work_id, title, content)
    VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.content, ''));
END;

CREATE TRIGGER works_fts_ad AFTER DELETE ON works BEGIN
  DELETE FROM works_fts WHERE work_id = old.id;
END;

CREATE TRIGGER works_fts_au AFTER UPDATE ON works BEGIN
  DELETE FROM works_fts WHERE work_id = old.id;
  INSERT INTO works_fts(work_id, title, content)
    SELECT new.id, COALESCE(new.title, ''), COALESCE(new.content, '') WHERE new.storage = 'local';
END;
`,
  // Composer drafts parked for later, scoped to a project. Attachments ride in
  // one JSON column: they are only ever read and written as the whole set
  // belonging to a prompt, so a child table would buy N inserts per save for no
  // query power. No updated_at — a saved prompt is immutable once written.
  `
CREATE TABLE saved_prompts (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX saved_prompts_by_project ON saved_prompts(project_root, created_at DESC);
`,
  // Session names — auto-generated from the first prompt or typed by the user.
  // Lives on the sessions row (not a side table) so every listing query that
  // already selects a session picks the name up for free.
  `
ALTER TABLE sessions ADD COLUMN custom_title TEXT;
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Sessions created by another session remain ordinary provider sessions;
  // these columns only preserve Solus orchestration lineage. Keeping them on
  // the indexed row makes every existing session listing surface receive the
  // relationship without a parallel cache or N+1 lookup.
  `
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
ALTER TABLE sessions ADD COLUMN root_session_id TEXT;
ALTER TABLE sessions ADD COLUMN delegation_exchange_id TEXT;
ALTER TABLE sessions ADD COLUMN delegation_depth INTEGER;
ALTER TABLE sessions ADD COLUMN delegation_intent TEXT;
ALTER TABLE sessions ADD COLUMN delegation_created_at INTEGER;
CREATE INDEX sessions_by_parent ON sessions(parent_session_id, last_timestamp DESC);
`,
  // The host outbox (ADR-0007): durable writes addressed to resources this host
  // cannot reach, ferried to their owner host by connected clients. `outbox_ops`
  // is the queue on the recording host; `applied_ops` is the owner-side
  // idempotence guard that makes redelivery and concurrent couriers harmless.
  // Every host carries both tables — any host can record and any host can own.
  `
CREATE TABLE outbox_ops (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  session_id TEXT,
  recorded_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);
CREATE INDEX outbox_ops_by_resource ON outbox_ops(domain, resource_id, id);

CREATE TABLE applied_ops (
  op_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Where the session itself lives. A machine cannot name itself — only the
  // client knows a host as "Studio" — so this is null for every session sitting
  // in its own host's index, and set only on the stub a client records when it
  // dispatches a session to another machine. That makes the session record, not
  // the task link, the thing every surface can ask "where did this run".
  `
ALTER TABLE sessions ADD COLUMN server_id TEXT;
`,
  // A pinned manifest is client-global but points at host-scoped sessions. The
  // empty host preserves legacy bare ids; new entries use the scoped tuple as
  // identity, so equal provider ids on two hosts can both be pinned.
  `
ALTER TABLE pinned_sessions RENAME TO pinned_sessions_unscoped;
CREATE TABLE pinned_sessions (
  session_id TEXT NOT NULL,
  server_id TEXT NOT NULL DEFAULT '',
  provider TEXT,
  title TEXT,
  cwd TEXT,
  pinned_at INTEGER,
  PRIMARY KEY (session_id, server_id)
);
INSERT INTO pinned_sessions(session_id, server_id, provider, title, cwd, pinned_at)
  SELECT session_id, '', provider, title, cwd, pinned_at
  FROM pinned_sessions_unscoped;
DROP TABLE pinned_sessions_unscoped;
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // New cross-provider handoffs only. Provider transcript files remain the
  // source of conversation content; this table records membership, order, and
  // the active endpoint. Sessions that never enter a Solus handoff have no row.
  `
CREATE TABLE session_handoff_members (
  handoff_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT,
  cwd TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (handoff_id, position)
);
CREATE UNIQUE INDEX session_handoff_member_provider_session
  ON session_handoff_members(provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;
`,
  // The lineage is now the identity record for every session, not just the ones
  // that changed provider. `session_id` is the stable Solus session id; a lineage
  // of length 1 has simply never been handed off. The partial unique index is what
  // makes registration first-writer-wins: a second client proposing its own name
  // for an already-registered provider thread loses.
  `
ALTER TABLE session_handoff_members RENAME TO session_lineage_members;
ALTER TABLE session_lineage_members RENAME COLUMN handoff_id TO session_id;
DROP INDEX IF EXISTS session_handoff_member_provider_session;
CREATE UNIQUE INDEX session_lineage_member_provider_session
  ON session_lineage_members(provider, provider_session_id)
  WHERE provider_session_id IS NOT NULL;
`,
  // Workspace plan rows are a query model, not a second source of truth. Provider
  // transcript readers update this table when a transcript changes; annotations
  // remain authoritative for review status, titles, comments, and bookmarks.
  // This makes opening Workspace proportional to its result set instead of the
  // total size of every provider transcript on the host.
  `
CREATE TABLE indexed_plans (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  plan_tool_use_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  cwd TEXT NOT NULL,
  project_root TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  plan_file_path TEXT,
  content TEXT NOT NULL,
  derived_status TEXT NOT NULL,
  PRIMARY KEY (provider, session_id, plan_tool_use_id)
);
CREATE INDEX indexed_plans_by_project
  ON indexed_plans(provider, project_root, timestamp DESC);
CREATE INDEX indexed_plans_by_cwd
  ON indexed_plans(provider, cwd, timestamp DESC);

CREATE TABLE plan_index_providers (
  provider TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
);
`,
  // A saved plan outlives its provider transcript. Claude can remove session
  // history after 30 days, so retain the artifact and record that its source
  // conversation can no longer be resumed.
  `
ALTER TABLE indexed_plans
  ADD COLUMN session_available INTEGER NOT NULL DEFAULT 1;
`,
  // Saved Insights queries. Durable user config, so it lives here — exempt from
  // metrics.db rollover. Exactly one form owns a row: a builder-editable
  // QuerySpec (JSON in `spec`) or editor-owned SQL text; SQL never round-trips
  // into the builder.
  `
CREATE TABLE saved_metrics_queries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  form TEXT NOT NULL,
  spec TEXT,
  sql TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Branch describes a session attempt, so it lives on the session row.
  `
ALTER TABLE sessions ADD COLUMN branch TEXT;
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // A plan revision can mirror the same provider document as a Folio work.
  // Keep the link with the plan's durable review annotations because provider
  // transcript content is an index, not the owner of user-managed state.
  `
ALTER TABLE plan_annotations ADD COLUMN mirrored_doc TEXT;
`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Reserved: this slot held a tasks migration. Tasks tables are now generated
  // from packages/server/src/tasks/schema.ts (docs/plans/cloud-service-model.md).
  `SELECT 1;`,
  // Named browser profiles: one project, several signed-in identities. Only the
  // named ones have rows — the project's automatic profile is the partition it
  // always was, so nothing here backfills a login that already exists.
  `
CREATE TABLE browser_profiles (
  project_root TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_root, profile_id)
);
CREATE TABLE browser_profile_defaults (
  project_root TEXT NOT NULL PRIMARY KEY,
  profile_id TEXT NOT NULL
);
`,
  // Preserve old provider thread references after a worktree fork.
  `
CREATE TABLE session_thread_aliases (
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (provider, provider_session_id)
);
CREATE INDEX session_thread_aliases_session ON session_thread_aliases(session_id);
`,

  // When this session was last read, so every client agrees. Read state used to
  // live in each renderer's tab, so opening a session on the desktop left it
  // unread on the phone. Null means never read — the session is unread as soon
  // as it completes anything.
  `
ALTER TABLE sessions ADD COLUMN viewed_at INTEGER;
`,

  // Reserved: PR summaries are now host memory only. Keep this slot so a
  // development host that applied the earlier migration retains its numbering.
  `SELECT 1;`,

]

export function runMigrations(db: DatabaseSync): void {
  // SAFETY: SQLite PRAGMA user_version always returns one row with this integer column.
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const currentVersion = row.user_version

  for (let index = currentVersion; index < migrations.length; index++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migrations[index])
      db.exec(`PRAGMA user_version = ${index + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
