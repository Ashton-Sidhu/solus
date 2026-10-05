// drizzle-kit's Postgres entry: every ported table as a `pg-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `sqlite.ts`.
import * as activitySchema from '../../data/activity/schema'
import * as folioSchema from '../../data/works/schema'
import * as notificationsSchema from '../../data/notifications/schema'
import * as insightSchema from '../../data/insights/insight-schema'
import * as outboxSchema from '../../sync/outbox/schema'
import * as plansSchema from '../../plans/schema'
import * as projectsSchema from '../../projects/schema'
import * as sessionsSchema from '../../data/sessions/schema'
import * as transcriptSchema from '../../data/sessions/transcript-schema'
import * as sharingSchema from '../../sharing/schema'
import * as tasksSchema from '../../data/tasks/schema'

export const tasks = tasksSchema.tasks.pg
export const task_counters = tasksSchema.taskCounters.pg
export const task_session_links = tasksSchema.taskSessionLinks.pg
export const task_comments = tasksSchema.taskComments.pg
export const task_links = tasksSchema.taskLinks.pg
export const task_external_links = tasksSchema.taskExternalLinks.pg
export const upstream_task_cache = tasksSchema.upstreamTaskCache.pg
export const asset_publications = tasksSchema.assetPublications.pg
export const works = folioSchema.works.pg
export const work_revisions = folioSchema.workRevisions.pg
export const work_annotations = folioSchema.workAnnotations.pg
export const work_reviewers = folioSchema.workReviewers.pg
export const work_live_docs = folioSchema.workLiveDocs.pg
export const plan_annotations = plansSchema.planAnnotations.pg
export const indexed_plans = plansSchema.indexedPlans.pg
export const plan_index_providers = plansSchema.planIndexProviders.pg
export const resource_owner = sharingSchema.resourceOwner.pg
export const share_grant = sharingSchema.shareGrant.pg
export const session_records = sessionsSchema.sessionRecords.pg
export const session_admissions = sessionsSchema.sessionAdmissions.pg
export const session_pull_requests = sessionsSchema.sessionPullRequests.pg
export const session_states = sessionsSchema.sessionStates.pg
export const runner_cursors = outboxSchema.runnerCursors.pg
export const session_transcripts = transcriptSchema.sessionTranscripts.pg
export const insight_spans = insightSchema.insightSpans.pg
export const insight_log_events = insightSchema.insightLogEvents.pg
export const workspace_projects = projectsSchema.workspaceProjects.pg
export const activity = activitySchema.activity.pg
export const notifications = notificationsSchema.notifications.pg
export { solusApiReceiptsPostgres as workspace_api_receipts } from '../../data/workspace/schema'
