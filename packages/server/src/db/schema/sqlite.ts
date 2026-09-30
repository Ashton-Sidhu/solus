// drizzle-kit's SQLite entry: every ported table as a `sqlite-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `postgres.ts`.
import * as activitySchema from '../../data/activity/schema'
import * as folioSchema from '../../data/works/schema'
import * as insightSchema from '../../data/insights/insight-schema'
import * as outboxSchema from '../../sync/outbox/schema'
import * as plansSchema from '../../plans/schema'
import * as projectsSchema from '../../projects/schema'
import * as sessionsSchema from '../../data/sessions/schema'
import * as transcriptSchema from '../../data/sessions/transcript-schema'
import * as sharingSchema from '../../sharing/schema'
import * as tasksSchema from '../../data/tasks/schema'

export const tasks = tasksSchema.tasks.sqlite
export const task_counters = tasksSchema.taskCounters.sqlite
export const task_session_links = tasksSchema.taskSessionLinks.sqlite
export const task_comments = tasksSchema.taskComments.sqlite
export const task_links = tasksSchema.taskLinks.sqlite
export const task_external_links = tasksSchema.taskExternalLinks.sqlite
export const upstream_task_cache = tasksSchema.upstreamTaskCache.sqlite
export const asset_publications = tasksSchema.assetPublications.sqlite
export const works = folioSchema.works.sqlite
export const work_revisions = folioSchema.workRevisions.sqlite
export const work_annotations = folioSchema.workAnnotations.sqlite
export const work_reviewers = folioSchema.workReviewers.sqlite
export const work_live_docs = folioSchema.workLiveDocs.sqlite
export const plan_annotations = plansSchema.planAnnotations.sqlite
export const indexed_plans = plansSchema.indexedPlans.sqlite
export const plan_index_providers = plansSchema.planIndexProviders.sqlite
export const resource_owner = sharingSchema.resourceOwner.sqlite
export const share_grant = sharingSchema.shareGrant.sqlite
export const session_records = sessionsSchema.sessionRecords.sqlite
export const session_admissions = sessionsSchema.sessionAdmissions.sqlite
export const session_pull_requests = sessionsSchema.sessionPullRequests.sqlite
export const session_states = sessionsSchema.sessionStates.sqlite
export const runner_cursors = outboxSchema.runnerCursors.sqlite
export const session_transcripts = transcriptSchema.sessionTranscripts.sqlite
export const insight_spans = insightSchema.insightSpans.sqlite
export const insight_log_events = insightSchema.insightLogEvents.sqlite
export const workspace_projects = projectsSchema.workspaceProjects.sqlite
export const activity = activitySchema.activity.sqlite
export { solusApiReceiptsSqlite as workspace_api_receipts } from '../../data/workspace/schema'
