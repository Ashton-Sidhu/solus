import type { DatabaseSync } from 'node:sqlite'

/**
 * The metrics file's schema, indexed by `PRAGMA user_version`. Slot 0 is the
 * baseline every file starts from; a later change appends a slot. A file whose
 * version is past the list predates the baseline and cannot be read.
 *
 * Each index has a reader: `spans_kind_time` the turn list, `spans_kind_name_time`
 * the tool filter, `spans_trace` a trace and the turn view's child times,
 * `spans_session` a session summary, `spans_time` the retention rollover, and
 * `log_events_span_time` the cascade a rollover deletes events through.
 */
const migrations = [`
CREATE TABLE spans (
  span_id TEXT PRIMARY KEY,
  parent_span_id TEXT,
  trace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  session_id TEXT, provider TEXT, model TEXT, project_root TEXT, origin TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  status TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}',
  -- Attribution (docs/plans/organization-scope.md §6.1): who ran the turn, as
  -- the host verified them, and which organization the session belongs to.
  user_id TEXT,
  user_email TEXT,
  organization_id TEXT
);
CREATE INDEX spans_kind_time ON spans(kind, started_at);
CREATE INDEX spans_kind_name_time ON spans(kind, name, started_at);
CREATE INDEX spans_trace ON spans(trace_id);
CREATE INDEX spans_session ON spans(session_id, started_at) WHERE session_id IS NOT NULL;
CREATE INDEX spans_time ON spans(started_at);

CREATE TABLE log_events (
  event_id INTEGER PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  file TEXT NOT NULL,
  attrs TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (span_id) REFERENCES spans(span_id) ON DELETE CASCADE
);
CREATE INDEX log_events_trace_time ON log_events(trace_id, occurred_at);
CREATE INDEX log_events_span_time ON log_events(span_id, occurred_at);
`]

export function runMetricsMigrations(db: DatabaseSync): void {
  const rawRow: unknown = db.prepare('PRAGMA user_version').get()
  // SAFETY: `PRAGMA user_version` always returns one row holding that single column.
  const row = rawRow as { user_version: number }
  if (row.user_version > migrations.length) {
    throw new Error('metrics.db predates the current schema. Delete metrics.db (and its -wal and -shm files) in the Solus data directory; it is recreated empty.')
  }

  for (let index = row.user_version; index < migrations.length; index++) {
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
