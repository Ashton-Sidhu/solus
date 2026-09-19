// drizzle-kit's SQLite entry: every ported table as a `sqlite-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `postgres.ts`.
import * as tasksSchema from '../../tasks/schema'

export const tasks = tasksSchema.tasks.sqlite
export const task_counters = tasksSchema.taskCounters.sqlite
export const task_session_links = tasksSchema.taskSessionLinks.sqlite
export const task_comments = tasksSchema.taskComments.sqlite
export const task_links = tasksSchema.taskLinks.sqlite
export const task_events = tasksSchema.taskEvents.sqlite
export const task_external_links = tasksSchema.taskExternalLinks.sqlite
export const upstream_task_cache = tasksSchema.upstreamTaskCache.sqlite
export const asset_publications = tasksSchema.assetPublications.sqlite
