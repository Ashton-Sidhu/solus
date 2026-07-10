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
]

export function runMigrations(db: DatabaseSync): void {
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
