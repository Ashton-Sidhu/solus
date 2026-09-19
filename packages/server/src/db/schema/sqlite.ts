// drizzle-kit's SQLite entry: every ported table as a `sqlite-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `postgres.ts`.
import * as folioSchema from '../../folio/schema'
import * as mirrorSchema from '../../mirror/schema'
import * as outboxSchema from '../../outbox/schema'
import * as plansSchema from '../../plans/schema'
import * as sessionsSchema from '../../sessions/schema'
import * as sharingSchema from '../../sharing/schema'
import * as tasksSchema from '../../tasks/schema'
import * as vaultSchema from '../../vault/schema'

export const tasks = tasksSchema.tasks.sqlite
export const task_counters = tasksSchema.taskCounters.sqlite
export const task_session_links = tasksSchema.taskSessionLinks.sqlite
export const task_comments = tasksSchema.taskComments.sqlite
export const task_links = tasksSchema.taskLinks.sqlite
export const task_events = tasksSchema.taskEvents.sqlite
export const task_external_links = tasksSchema.taskExternalLinks.sqlite
export const upstream_task_cache = tasksSchema.upstreamTaskCache.sqlite
export const asset_publications = tasksSchema.assetPublications.sqlite
export const works = folioSchema.works.sqlite
export const work_revisions = folioSchema.workRevisions.sqlite
export const work_annotations = folioSchema.workAnnotations.sqlite
export const plan_annotations = plansSchema.planAnnotations.sqlite
export const indexed_plans = plansSchema.indexedPlans.sqlite
export const plan_index_providers = plansSchema.planIndexProviders.sqlite
export const resource_owner = sharingSchema.resourceOwner.sqlite
export const share_grant = sharingSchema.shareGrant.sqlite
export const session_records = sessionsSchema.sessionRecords.sqlite
export const runner_cursors = outboxSchema.runnerCursors.sqlite
export const session_transcripts = mirrorSchema.sessionTranscripts.sqlite
export const insight_spans = mirrorSchema.insightSpans.sqlite
export const insight_log_events = mirrorSchema.insightLogEvents.sqlite
export const credential_vault = vaultSchema.credentialVault.sqlite
export const credential_locks = vaultSchema.credentialLocks.sqlite
export const organization_members = vaultSchema.organizationMembers.sqlite
