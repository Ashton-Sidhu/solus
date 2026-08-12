import type { DatabaseSync } from 'node:sqlite'

const migrations = [
  `
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
  attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX spans_kind_time ON spans(kind, started_at);
CREATE INDEX spans_kind_name_time ON spans(kind, name, started_at);
CREATE INDEX spans_service_time ON spans(service, started_at);
CREATE INDEX spans_trace ON spans(trace_id);
CREATE INDEX spans_session ON spans(session_id, started_at) WHERE session_id IS NOT NULL;
`,
]

export function runMetricsMigrations(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }

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
