import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'

// plans/029-fresh-database-baseline.md decision 2 and P8: two person columns, no
// more. `created_by` is the user id of who made a row, set from the verified
// acting identity, immutable, and also the owner; `user_id` is the person a row
// is for, only where that can differ. Nothing else names a person. The rule is
// enforced here on the generated baselines, not by review: a table that gains a
// third person column, or loses its creator, fails this file.

const drizzle = join(import.meta.dir, '../../packages/server/drizzle')

interface Column {
  name: string
  notNull: boolean
  hasDefault: boolean
}

interface Table {
  name: string
  columns: Column[]
}

/** The names a person column must not have. Each was one of the columns decision 2 collapsed. */
const FORBIDDEN_NAME = /owner_key|person_key|recipient_key|actor_user_id|granted_by_user_id|by_user_key|target_user_key/

/** A column name that reads as a person: must be one of the two allowed, or a listed domain reference. */
const PERSON_LIKE_NAME = /(^|_)(user_id|user_key|person_key|owner|recipient|actor|creator)$/

/** Columns that reference a person as a domain fact, not as identity or ownership. */
const DOMAIN_PERSON_REFERENCES: Record<string, string> = {
  'tasks.assignee_user_id': 'who the task is assigned to; a relationship the creator sets, read beside `assignee`',
}

/**
 * Tables that carry no `created_by`, each with why: internal rows reach
 * ownership through their parent (decision 2). A name that leaves the schema
 * must leave this list.
 */
const NO_CREATOR: Record<string, string> = {
  // `__drizzle_migrations` is the migrator's own bookkeeping, made at runtime, so the baselines never declare it.
  kv: 'host key-value settings',
  projects: "the host's manifest of the folders on this machine",
  outbox_ops: 'queue of record operations awaiting delivery',
  delivery_queue: 'queue to the Solus API; the delivering person is `user_id`',
  runner_delivery_cursors: 'delivery cursor per host and delivering person (`user_id`)',
  transcript_mirror_rows: 'mirror rows of a session transcript',
  activity_mirror_rows: 'mirror rows of a session activity',
  transcript_index: "this host's index of its transcript files, one row per provider thread; the session row owns the facts",
  session_messages: 'indexed messages of a transcript file',
  session_files: 'how far the indexer read each transcript file',
  session_keys: 'a short number per session for the keyboard',
  session_lineage_members: 'the provider threads a session ran as',
  session_thread_aliases: 'a provider thread id that names a session',
  pinned_sessions: 'a pin on this host, keyed by session and server; personal ownership is a deferred decision (plan 029)',
  runs: 'the execution ledger of a session; the session row owns it',
  run_queue: 'queued prompts of a session; the session row owns them',
  run_exchanges: 'exchanges between two sessions; the session rows own them',
  async_questions: 'questions a session asked; the session row owns them',
  session_transcripts: 'mirrored transcript rows; the session row names the owner',
  insight_spans: 'mirrored spans of a turn; `user_id` names who ran it',
  insight_log_events: 'mirrored log events of a span',
  insight_span_texts: 'mirrored span texts; the span row names the host and organization',
  operation_receipts: 'receipts of writes that happen once',
  notifications: 'written by the hub for its recipient (`user_id`); no person makes a row',
  notification_pr_observations: "cache of a person's pending pull requests (`user_id`)",
  integration_connection: "a person's connection state on an integration (`user_id`); the integration carries the creator",
  member_folder: "a person's folder name on this host (`user_id`)",
  automation_runs: 'derived rows of an automation run',
  webhook_deliveries: 'log of requests to a webhook',
  task_counters: 'one global short-id counter',
  task_session_links: 'child of a task; `started_by` is display attribution',
  task_comments: 'child of a task; `author` is display attribution, external authors included',
  task_external_links: 'sync state of a task with its upstream',
  upstream_task_cache: 'cache of upstream tasks',
  asset_publications: 'cache of where an asset was published',
  work_revisions: 'child of a work; `author` is display attribution',
  work_annotations: 'child of a work; comment attribution is inside the JSON',
  work_reviewers: 'child of a work; `requested_by` is display attribution of who asked',
  work_live_docs: 'derived live state of a work',
  work_storage: 'storage mapping of a work',
  work_storage_bodies: 'pending bodies of a work',
  works_fts: 'FTS table',
  works_fts_rows: 'FTS row mapping',
  session_fts: 'FTS table',
  session_transcripts_fts: 'FTS table',
  plan_annotations: "child of a session's plan; comment attribution is inside the JSON",
  indexed_plans: 'index of plan files on this host',
  plan_index_providers: 'index state per provider',
}

/**
 * Tables another plan-029 group is still reshaping; every check here skips them.
 * Each lands with `created_by` or a reason in `NO_CREATOR`: move it there as it
 * lands, and this list ends empty.
 */
const RESHAPING_ELSEWHERE = new Set([
  // Relationships (plan 029 §5.1): these fold into `resource_links`, whose `created_by` is a user id.
  'session_links', 'session_pull_requests', 'session_pull_request_watches', 'task_session_links',
])

/**
 * Tables whose `created_by` does not yet meet the rule as declared (NOT NULL, no
 * default, a user id). Each is a decision the plan did not settle, kept visible here.
 */
const CREATED_BY_DEVIATIONS: Record<string, string> = {
  activity: 'nullable: an agent, automation, or system row has no acting person today',
  task_links: "an `Attribution` JSON with a default, not a user id; shares its shape with `session_pull_requests.created_by`",
}

/** An FTS5 virtual table's shadow tables, which SQLite makes and nothing declares. */
const FTS_SHADOW = /_fts_(data|idx|docsize|config|content)$/

function sqliteTables(): Table[] {
  const db = new Database(':memory:')
  try {
    for (const migration of readMigrationFiles({ migrationsFolder: join(drizzle, 'sqlite') })) {
      for (const statement of migration.sql) db.exec(statement)
    }
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    return names
      .filter(({ name }) => !FTS_SHADOW.test(name))
      .map(({ name }) => ({
        name,
        columns: db.query<{ name: string; notnull: number; dflt_value: string | null }, []>(`PRAGMA table_info("${name}")`).all()
          .map((column) => ({ name: column.name, notNull: column.notnull === 1, hasDefault: column.dflt_value !== null })),
      }))
  } finally {
    db.close()
  }
}

/** The Postgres baseline as text: each `CREATE TABLE` block's quoted column lines. */
function postgresTables(): Table[] {
  const text = readFileSync(join(drizzle, 'postgres', '0000_baseline.sql'), 'utf8')
  const tables: Table[] = []
  for (const match of text.matchAll(/CREATE TABLE "([a-z_]+)" \(([\s\S]*?)\n\);/g)) {
    const columns: Column[] = []
    for (const line of match[2].split('\n')) {
      const column = /^\s*"([a-z_]+)" (.*)$/.exec(line)
      if (!column) continue
      const definition = column[2]
      columns.push({ name: column[1], notNull: /\bNOT NULL\b/.test(definition), hasDefault: /\bDEFAULT\b/.test(definition) })
    }
    tables.push({ name: match[1], columns })
  }
  return tables
}

function checkTables(tables: Table[]): void {
  expect(tables.length).toBeGreaterThan(10)
  const seen = new Set(tables.map((table) => table.name))
  for (const table of tables) {
    if (RESHAPING_ELSEWHERE.has(table.name)) continue
    const names = table.columns.map((column) => column.name)
    for (const name of names) {
      expect({ table: table.name, column: name, forbidden: FORBIDDEN_NAME.test(name) }).toEqual({ table: table.name, column: name, forbidden: false })
      if (PERSON_LIKE_NAME.test(name) && name !== 'created_by' && name !== 'user_id') {
        expect({ table: table.name, column: name, domainReference: DOMAIN_PERSON_REFERENCES[`${table.name}.${name}`] ?? null }).not.toMatchObject({ domainReference: null })
      }
    }
    const creator = table.columns.find((column) => column.name === 'created_by')
    if (!creator) {
      expect({ table: table.name, reason: NO_CREATOR[table.name] ?? null }).not.toMatchObject({ reason: null })
      continue
    }
    if (table.name in CREATED_BY_DEVIATIONS) continue
    expect({ table: table.name, notNull: creator.notNull, hasDefault: creator.hasDefault }).toEqual({ table: table.name, notNull: true, hasDefault: false })
  }
  for (const name of Object.keys(DOMAIN_PERSON_REFERENCES)) {
    const [table, column] = name.split('.')
    if (!seen.has(table)) continue
    expect(tables.find((candidate) => candidate.name === table)?.columns.map((candidate) => candidate.name)).toContain(column)
  }
}

describe('the data model names a person in two columns', () => {
  const sqlite = sqliteTables()
  const postgres = postgresTables()

  test('every SQLite table has created_by, or a reason not to, and no other person column', () => {
    checkTables(sqlite)
  })

  test('every Postgres table has created_by, or a reason not to, and no other person column', () => {
    checkTables(postgres)
  })

  test('the lists name only tables that exist, so a removed table leaves them', () => {
    const existing = new Set([...sqlite, ...postgres].map((table) => table.name))
    for (const name of [...Object.keys(NO_CREATOR), ...RESHAPING_ELSEWHERE, ...Object.keys(CREATED_BY_DEVIATIONS)]) {
      expect({ name, exists: existing.has(name) }).toEqual({ name, exists: true })
    }
  })

  test('a creator column holds the acting person: the renamed owners are created_by', () => {
    const creators = new Map(sqlite.map((table) => [table.name, table.columns.some((column) => column.name === 'created_by')]))
    for (const name of ['tasks', 'works', 'webhooks', 'automations', 'integration', 'workspace_projects', 'acl_entry', 'browser_profiles']) {
      expect({ name, hasCreator: creators.get(name) }).toEqual({ name, hasCreator: true })
    }
    const forPerson = new Map(sqlite.map((table) => [table.name, table.columns.some((column) => column.name === 'user_id')]))
    for (const name of ['notifications', 'activity', 'delivery_queue', 'runner_delivery_cursors']) {
      expect({ name, hasUserId: forPerson.get(name) }).toEqual({ name, hasUserId: true })
    }
  })
})
