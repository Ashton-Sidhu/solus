import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'

// WHY (plans/029-fresh-database-baseline.md §10, §11): the data model is one
// generated baseline per database, and its table and index set is a decision,
// not a side effect. A table or index that appears or disappears here without
// this test changing is a mistake: either an unreviewed schema change or a
// generator that no longer writes what the declarations say. Keep the lists
// sorted; add a table only with its reader named in the declaration's comment.

const drizzle = join(import.meta.dir, '..', '..', 'packages', 'server', 'drizzle')
const FTS_SHADOW = /_fts_(data|idx|docsize|config|content)$/

/** The `solus.db` tables: the host's own, and the records when SQLite is the engine. */
const SOLUS_TABLES = [
  'acl_entry', 'activity', 'activity_mirror_rows', 'app_calls', 'app_schedules', 'app_versions', 'apps',
  'asset_publications', 'async_questions', 'automation_runs',
  'automations', 'browser_profiles', 'comment_threads', 'delivery_queue', 'host_list', 'indexed_plans', 'insight_log_events',
  'insight_span_texts', 'insight_spans', 'integration', 'integration_connection', 'kv', 'member_folder',
  'notification_pr_observations', 'notifications', 'operation_receipts', 'outbox_ops', 'personal_resource_state',
  'pinned_sessions', 'plan_annotations', 'plan_index_providers', 'projects', 'pull_request_observations',
  'resource_links', 'run_exchanges', 'run_queue', 'runner_delivery_cursors', 'runs', 'saved_metrics_queries',
  'session_files', 'session_fts', 'session_keys', 'session_lineage_members', 'session_messages', 'session_records',
  'session_thread_aliases', 'session_transcripts', 'session_transcripts_fts', 'task_source_access', 'task_source_items',
  'task_sources', 'tasks', 'transcript_index', 'transcript_mirror_rows', 'turn_flags', 'webhook_deliveries',
  'webhooks', 'work_live_docs', 'work_reviewers', 'work_revisions', 'work_storage', 'work_storage_bodies', 'works',
  'works_fts', 'works_fts_rows', 'workspace_projects',
]

const SOLUS_INDEXES = [
  'acl_entry_by_subject', 'acl_entry_secret_idx', 'acl_entry_subject', 'activity_by_subject', 'activity_for_user',
  'app_calls_by_app', 'app_schedules_due', 'apps_by_creator', 'apps_by_slug',
  'async_questions_by_agent', 'async_questions_by_session', 'async_questions_retained', 'browser_profiles_default',
  'comment_threads_external', 'comment_threads_pending', 'comment_threads_position', 'comment_threads_task_order',
  'delivery_queue_by_destination', 'delivery_queue_by_key', 'indexed_plans_by_project', 'indexed_plans_by_session',
  'indexed_plans_by_thread', 'insight_log_events_time_idx', 'insight_log_events_trace_idx', 'insight_spans_time_idx',
  'insight_spans_trace_idx', 'insight_turns_host_page', 'insight_turns_page', 'insight_turns_provider_page',
  'insight_turns_session_page', 'insight_turns_user_page', 'integration_slug', 'member_folder_folder_unique',
  'notifications_by_resource', 'notifications_event', 'notifications_for_user', 'operation_receipts_expiry',
  'outbox_ops_by_resource', 'personal_resource_state_by_person', 'personal_resource_state_snoozed',
  'resource_links_by_pull_request', 'resource_links_by_source', 'resource_links_by_target', 'resource_links_edge', 'resource_links_open_session',
  'resource_links_watch', 'resource_links_working_owner', 'run_queue_by_session', 'runs_by_automation',
  'saved_metrics_queries_by_creator', 'session_api_activity_page', 'session_api_page', 'session_api_provider_page',
  'session_by_activity', 'session_by_parent', 'session_by_parent_activity', 'session_by_place',
  'session_by_project_path', 'session_keys_session_id_unique', 'session_lineage_member_provider_session',
  'session_messages_by_session', 'session_transcripts_search_pending', 'task_source_items_task',
  'transcript_index_by_project_root', 'transcript_index_recent_branches', 'webhook_deliveries_by_webhook',
  'webhooks_by_creator', 'webhooks_by_project', 'work_reviewers_reviewer', 'work_storage_due', 'works_api_page',
  'works_api_type_page', 'works_by_session', 'workspace_projects_by_repository',
]

/** The search triggers, hand-written in `db/schema/custom/sqlite.sql`. */
const SOLUS_TRIGGERS = [
  'session_transcripts_search_delete', 'session_transcripts_search_insert', 'session_transcripts_search_update',
  'works_fts_ad', 'works_fts_ai', 'works_fts_au',
]

/** The records on a Postgres host: every ported table, nothing host-local. */
const POSTGRES_TABLES = [
  'acl_entry', 'activity', 'app_calls', 'app_schedules', 'app_versions', 'apps', 'asset_publications',
  'comment_threads', 'indexed_plans', 'insight_log_events',
  'insight_span_texts', 'insight_spans', 'notifications', 'operation_receipts', 'personal_resource_state',
  'plan_annotations', 'plan_index_providers', 'pull_request_observations', 'resource_links',
  'runner_delivery_cursors', 'session_records', 'session_transcripts', 'task_source_access', 'task_source_items',
  'task_sources', 'tasks', 'webhook_deliveries', 'webhooks', 'work_live_docs', 'work_reviewers',
  'work_revisions', 'work_storage', 'work_storage_bodies', 'works', 'workspace_projects',
]

const METRICS_TABLES = ['log_events', 'span_texts', 'spans']
const METRICS_INDEXES = [
  'log_events_span_time', 'log_events_trace_time', 'spans_kind_name_time', 'spans_kind_time', 'spans_session', 'spans_time',
  'spans_trace', 'spans_turn_open', 'spans_turn_pulled',
]

function sqliteObjects(folder: string): { tables: string[]; indexes: string[]; triggers: string[]; files: number } {
  const migrations = readMigrationFiles({ migrationsFolder: join(drizzle, folder) })
  const db = new Database(':memory:')
  try {
    for (const migration of migrations) for (const statement of migration.sql) db.exec(statement)
    const names = (type: string) => db
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(type)
      .map((row) => row.name)
      .filter((name) => !FTS_SHADOW.test(name))
    return { tables: names('table'), indexes: names('index'), triggers: names('trigger'), files: migrations.length }
  } finally {
    db.close()
  }
}

describe('the data model is one baseline per database', () => {
  test('solus.db holds exactly the declared tables, indexes, and triggers, from one file', () => {
    const { tables, indexes, triggers, files } = sqliteObjects('sqlite')
    expect(files).toBe(1)
    expect(tables).toEqual(SOLUS_TABLES)
    expect(indexes).toEqual(SOLUS_INDEXES)
    expect(triggers).toEqual(SOLUS_TRIGGERS)
  })

  test('metrics.db holds exactly the declared tables and indexes, from one file', () => {
    const { tables, indexes, triggers, files } = sqliteObjects('metrics')
    expect(files).toBe(1)
    expect(tables).toEqual(METRICS_TABLES)
    expect(indexes).toEqual(METRICS_INDEXES)
    expect(triggers).toEqual([])
  })

  test('the Postgres baseline is one file with exactly the ported tables', () => {
    const migrations = readMigrationFiles({ migrationsFolder: join(drizzle, 'postgres') })
    expect(migrations.length).toBe(1)
    const text = readFileSync(join(drizzle, 'postgres', '0000_baseline.sql'), 'utf8')
    const tables = [...text.matchAll(/^CREATE TABLE "([a-z_]+)"/gm)].map((match) => match[1]).sort()
    expect(tables).toEqual(POSTGRES_TABLES)
  })

  test('no record table takes a name of the cloud account tables', () => {
    // WHY: Solus Cloud keeps Better Auth's account tables and these records in one
    // Postgres schema (solus-cloud docs/deploy-cloudflare.md). A record table named
    // like an account table fails the cloud's boot migration; \`session\` did once.
    const ACCOUNT_TABLES = ['account', 'invitation', 'jwks', 'member', 'organization', 'session', 'team', 'team_member', 'user', 'verification']
    expect(POSTGRES_TABLES.filter((table) => ACCOUNT_TABLES.includes(table))).toEqual([])
  })

  test('nothing that only lived in a migration history remains: no legacy slot runner, no second baseline', () => {
    // WHY: plans/029 decision 1 — a file an older build made cannot be opened, so
    // nothing may read `PRAGMA user_version` as a schema slot any more.
    const sqlite = readFileSync(join(drizzle, 'sqlite', '0000_baseline.sql'), 'utf8')
    expect(sqlite).not.toMatch(/user_version/)
    expect(sqlite).not.toMatch(/ALTER TABLE/)
  })
})
