import { bigint, defineTable, integer, json, text } from '../db/schema/define-table'

/**
 * The plans domain's tables, declared once for both engines
 * (docs/plans/cloud-service-model.md). `plan_annotations` is the review state
 * a person owns; `indexed_plans` is the query model the provider transcript
 * readers keep in step, and `plan_index_providers` records which providers
 * have been indexed in full. Column names and nullability are the ones the
 * hand-written SQLite migrations established; `organization_id` is new.
 */

const ORGANIZATION = text({ notNull: true, default: 'local' })

export const planAnnotations = defineTable('plan_annotations', {
  session_id: text({ notNull: true }),
  plan_tool_use_id: text({ notNull: true }),
  status: text(),
  title: text(),
  bookmarked: integer(),
  bookmarked_at: bigint(),
  project_path: text(),
  cwd: text(),
  comments: json(),
  updated_at: bigint(),
  mirrored_doc: json(),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['session_id', 'plan_tool_use_id'],
})

export const indexedPlans = defineTable('indexed_plans', {
  provider: text({ notNull: true }),
  session_id: text({ notNull: true }),
  plan_tool_use_id: text({ notNull: true }),
  project_path: text({ notNull: true }),
  cwd: text({ notNull: true }),
  project_root: text({ notNull: true }),
  timestamp: bigint({ notNull: true }),
  title: text({ notNull: true }),
  excerpt: text({ notNull: true }),
  plan_file_path: text(),
  content: text({ notNull: true }),
  derived_status: text({ notNull: true }),
  session_available: integer({ notNull: true, default: 1 }),
  organization_id: ORGANIZATION,
}, {
  primaryKey: ['provider', 'session_id', 'plan_tool_use_id'],
  indexes: [
    { name: 'indexed_plans_by_project', columns: ['provider', 'project_root', 'timestamp'], descending: ['timestamp'] },
    { name: 'indexed_plans_by_cwd', columns: ['provider', 'cwd', 'timestamp'], descending: ['timestamp'] },
  ],
})

export const planIndexProviders = defineTable('plan_index_providers', {
  provider: text({ primaryKey: true }),
  completed_at: bigint({ notNull: true }),
  organization_id: ORGANIZATION,
})

export const PLAN_TABLES = [planAnnotations, indexedPlans, planIndexProviders]
