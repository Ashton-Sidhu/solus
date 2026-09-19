// drizzle-kit's Postgres entry: every ported table as a `pg-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `sqlite.ts`.
import * as folioSchema from '../../folio/schema'
import * as outboxSchema from '../../outbox/schema'
import * as plansSchema from '../../plans/schema'
import * as sessionsSchema from '../../sessions/schema'
import * as sharingSchema from '../../sharing/schema'
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
export const works = folioSchema.works.pg
export const work_revisions = folioSchema.workRevisions.pg
export const work_annotations = folioSchema.workAnnotations.pg
export const plan_annotations = plansSchema.planAnnotations.pg
export const indexed_plans = plansSchema.indexedPlans.pg
export const plan_index_providers = plansSchema.planIndexProviders.pg
export const resource_owner = sharingSchema.resourceOwner.pg
export const share_grant = sharingSchema.shareGrant.pg
export const session_records = sessionsSchema.sessionRecords.pg
export const runner_cursors = outboxSchema.runnerCursors.pg
