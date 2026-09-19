// drizzle-kit's Postgres entry: every ported table as a `pg-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `sqlite.ts`.
import * as tasksSchema from '../../tasks/schema'

export const tasks = tasksSchema.tasks.pg
export const task_counters = tasksSchema.taskCounters.pg
export const task_session_links = tasksSchema.taskSessionLinks.pg
export const task_comments = tasksSchema.taskComments.pg
export const task_links = tasksSchema.taskLinks.pg
export const task_events = tasksSchema.taskEvents.pg
export const task_external_links = tasksSchema.taskExternalLinks.pg
export const upstream_task_cache = tasksSchema.upstreamTaskCache.pg
export const asset_publications = tasksSchema.assetPublications.pg
