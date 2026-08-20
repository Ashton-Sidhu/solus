import type { DatabaseSync } from 'node:sqlite'

const migrations = [
  `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',
  parent_id TEXT,
  assignee TEXT,
  due_date TEXT,
  priority TEXT,
  branch TEXT,
  pr TEXT,
  labels TEXT,
  raw TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX tasks_project_status ON tasks(project_key, status, updated_at DESC);
CREATE INDEX tasks_parent ON tasks(parent_id);

CREATE TABLE task_session_links (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project_key TEXT NOT NULL,
  linked_at INTEGER,
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX links_by_project ON task_session_links(project_key);

CREATE TABLE task_cache (
  project_key TEXT PRIMARY KEY,
  fetched_at INTEGER,
  truncated INTEGER,
  tasks TEXT
);

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
  // Full-text index over locally-stored works, for search_works. Standalone
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
  // Tasks become a Solus-owned, local-first record. This is intentionally a
  // clean-slate migration: provider-mirrored tasks and renderer-written session
  // bindings belong to the retired model and must not be interpreted as native
  // task history. Existing sessions are not walked or backfilled here.
  `
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS task_session_links;
DROP TABLE IF EXISTS task_cache;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  short_id INTEGER UNIQUE,
  project_key TEXT,
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'prompt',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  kind TEXT NOT NULL DEFAULT 'task',
  assignee TEXT,
  due_date TEXT,
  priority TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  pr TEXT,
  worktree_key TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  origin_session_id TEXT,
  origin_automation_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  triaged_at INTEGER,
  done_at INTEGER
);
CREATE INDEX tasks_by_project ON tasks(project_key, status, updated_at DESC);
CREATE INDEX tasks_by_status ON tasks(status, created_at DESC);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE INDEX tasks_by_worktree ON tasks(worktree_key, status, updated_at DESC);

CREATE TABLE task_session_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'working',
  branch TEXT,
  pr TEXT,
  injected_at INTEGER,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, session_id)
);
CREATE INDEX task_session_links_by_session ON task_session_links(session_id);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  origin_session_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX task_comments_by_task ON task_comments(task_id, created_at);

CREATE TABLE task_links (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  external_updated_at TEXT,
  snapshot TEXT,
  dirty_fields TEXT NOT NULL DEFAULT '[]',
  sync_state TEXT NOT NULL DEFAULT 'ok',
  sync_error TEXT,
  last_synced_at INTEGER
);
CREATE UNIQUE INDEX task_links_external ON task_links(provider, external_key, external_id);
`,
  // Task links and task activity. `task_links` becomes the generic "linked
  // anything" edge — docs/works, plans, automations and PRs — which is what the
  // name always read as. Its previous occupant was an external-ticket-sync
  // mirror that nothing ever wrote, so it is provably empty and dropped here
  // rather than migrated; external sync, when it lands, gets its own table.
  //
  // `target_scope` is the qualifier a bare key lacks: a PR number is only
  // unique within a repo, and a plan is identified by (session, tool use). It
  // is NOT NULL DEFAULT '' rather than nullable because SQLite permits NULLs in
  // a non-INTEGER primary key column, which would silently break uniqueness.
  //
  // `title`/`url` are a snapshot taken at link time so a row always renders,
  // even for a PR or a deleted target. Live titles are re-derived at read time
  // by LEFT JOIN for the kinds whose targets live in this database.
  `
DROP TABLE IF EXISTS task_links;

CREATE TABLE task_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_scope TEXT NOT NULL DEFAULT '',
  target_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  url TEXT,
  created_by TEXT NOT NULL DEFAULT 'user',
  origin_session_id TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, target_scope, target_key)
);
CREATE INDEX task_links_by_target ON task_links(kind, target_scope, target_key);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  actor_label TEXT,
  from_value TEXT,
  to_value TEXT,
  target_kind TEXT,
  target_scope TEXT,
  target_key TEXT,
  target_title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX task_events_by_task ON task_events(task_id, created_at, id);

INSERT INTO task_links(task_id, kind, target_scope, target_key, title, url, created_by, linked_at)
  SELECT
    id,
    'pr',
    COALESCE(project_key, ''),
    CAST(json_extract(pr, '$.number') AS TEXT),
    '#' || CAST(json_extract(pr, '$.number') AS TEXT),
    json_extract(pr, '$.url'),
    'migration',
    updated_at
  FROM tasks
  WHERE pr IS NOT NULL
    AND json_valid(pr)
    AND json_extract(pr, '$.number') IS NOT NULL
    AND json_extract(pr, '$.number') > 0;

INSERT INTO task_events(id, task_id, kind, actor, to_value, created_at)
  SELECT
    'backfill-' || id,
    id,
    'created',
    CASE source
      WHEN 'user' THEN 'user'
      WHEN 'session' THEN 'agent'
      WHEN 'agent' THEN 'agent'
      WHEN 'automation' THEN 'automation'
      ELSE 'system'
    END,
    status,
    created_at
  FROM tasks;
`,
  // Upstream providers remain remote-owned, but their last successful list is
  // retained so a temporary auth/network failure does not make those rows
  // disappear beside native Solus tasks. Scope is part of the key because an
  // assignee-filtered read must never replace the project's complete snapshot.
  `
CREATE TABLE upstream_task_cache (
  project_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  scope TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  truncated INTEGER,
  tasks TEXT NOT NULL,
  PRIMARY KEY (project_key, provider, scope)
);
`,
  // `task_comments.dirty` was a speculative upstream-push flag nothing ever
  // read or set.
  `
ALTER TABLE task_comments DROP COLUMN dirty;
`,
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
  // Where the attempt actually ran. A link is always written on the *task's*
  // host (ADR-0006), so without this column a dispatched session was
  // indistinguishable from one that ran here — and every surface that reads a
  // closed attempt reported it as local. Null means "the task's own host",
  // which is what a non-dispatch is; a value is the execution host's id.
  `
ALTER TABLE task_session_links ADD COLUMN execution_server_id TEXT;
`,
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
  // Durable task-sidebar presentation state. Snooze preserves the task's
  // workflow status; reminders can be projected into a linked session when
  // the wake time passes.
  `
ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER;
ALTER TABLE tasks ADD COLUMN snoozed_at INTEGER;
ALTER TABLE tasks ADD COLUMN snooze_note TEXT;
ALTER TABLE tasks ADD COLUMN last_read_at INTEGER;
CREATE INDEX tasks_by_snooze ON tasks(snoozed_until) WHERE snoozed_until IS NOT NULL;
`,
  // Native tasks own their state. An external ticket is an optional sync edge,
  // separate from the generic task_links table that points at workspace
  // artifacts. Dirty fields are coalesced because SQLite and the main process
  // are the durable queue; there is no second outbox to reconcile.
  `
CREATE TABLE task_external_links (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  external_updated_at TEXT,
  snapshot TEXT,
  dirty_fields TEXT NOT NULL DEFAULT '[]',
  sync_state TEXT NOT NULL DEFAULT 'ok',
  sync_error TEXT,
  last_synced_at INTEGER,
  retry_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX task_external_links_external
  ON task_external_links(provider, external_key, external_id);

ALTER TABLE task_comments ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX task_comments_external
  ON task_comments(task_id, external_id)
  WHERE external_id IS NOT NULL;
`,
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
  // A first dispatch was briefly linked twice: the renderer used the stable
  // Solus session id while ControlPlane used the provider thread id. Fold the
  // provider aliases into their lineage id so existing task rows stop showing
  // the same conversation twice. New writes use the stable id at both edges.
  `
INSERT INTO task_session_links(
  task_id, session_id, role, branch, pr, execution_server_id, linked_at
)
SELECT
  task_session_links.task_id,
  session_lineage_members.session_id,
  task_session_links.role,
  task_session_links.branch,
  task_session_links.pr,
  task_session_links.execution_server_id,
  task_session_links.linked_at
FROM task_session_links
JOIN session_lineage_members
  ON session_lineage_members.provider_session_id = task_session_links.session_id
WHERE session_lineage_members.session_id <> task_session_links.session_id
ON CONFLICT(task_id, session_id) DO UPDATE SET
  role = excluded.role,
  branch = COALESCE(excluded.branch, task_session_links.branch),
  pr = COALESCE(excluded.pr, task_session_links.pr),
  execution_server_id = COALESCE(excluded.execution_server_id, task_session_links.execution_server_id),
  linked_at = MIN(excluded.linked_at, task_session_links.linked_at);

UPDATE tasks
SET origin_session_id = (
  SELECT session_lineage_members.session_id
  FROM session_lineage_members
  WHERE session_lineage_members.provider_session_id = tasks.origin_session_id
)
WHERE EXISTS (
  SELECT 1
  FROM session_lineage_members
  WHERE session_lineage_members.provider_session_id = tasks.origin_session_id
    AND session_lineage_members.session_id <> tasks.origin_session_id
);

DELETE FROM task_session_links
WHERE EXISTS (
  SELECT 1
  FROM session_lineage_members
  WHERE session_lineage_members.provider_session_id = task_session_links.session_id
    AND session_lineage_members.session_id <> task_session_links.session_id
);
`,
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
