// drizzle-kit's Postgres entry: every ported table as a `pg-core` table.
// drizzle-kit reads named exports only, so each table is listed by hand; a
// ported domain adds its tables here and in `sqlite.ts`.
import * as activitySchema from '../../data/activity/schema'
import * as commentsSchema from '../../data/comments/schema'
import * as folioSchema from '../../data/works/schema'
import * as notificationsSchema from '../../data/notifications/schema'
import * as insightSchema from '../../data/insights/insight-schema'
import * as linksSchema from '../../data/links/schema'
import * as outboxSchema from '../../sync/outbox/schema'
import * as plansSchema from '../../plans/schema'
import * as personalStateSchema from '../../data/personal-state/schema'
import * as projectsSchema from '../../projects/schema'
import * as receiptsSchema from '../../data/receipts/schema'
import * as sessionsSchema from '../../data/sessions/schema'
import * as transcriptSchema from '../../data/sessions/transcript-schema'
import * as sharingSchema from '../../sharing/schema'
import * as tasksSchema from '../../data/tasks/schema'
import * as webhooksSchema from '../../data/webhooks/schema'

export const tasks = tasksSchema.tasks.pg
export const task_counters = tasksSchema.taskCounters.pg
export const task_external_links = tasksSchema.taskExternalLinks.pg
export const upstream_task_cache = tasksSchema.upstreamTaskCache.pg
export const asset_publications = tasksSchema.assetPublications.pg
export const works = folioSchema.works.pg
export const work_revisions = folioSchema.workRevisions.pg
export const work_reviewers = folioSchema.workReviewers.pg
export const work_live_docs = folioSchema.workLiveDocs.pg
export const work_storage = folioSchema.workStorage.pg
export const work_storage_bodies = folioSchema.workStorageBodies.pg
export const plan_annotations = plansSchema.planAnnotations.pg
export const indexed_plans = plansSchema.indexedPlans.pg
export const plan_index_providers = plansSchema.planIndexProviders.pg
export const comment_threads = commentsSchema.commentThreads.pg
export const acl_entry = sharingSchema.aclEntry.pg
export const session = sessionsSchema.session.pg
export const resource_links = linksSchema.resourceLinks.pg
export const pull_request_observations = linksSchema.pullRequestObservations.pg
export const personal_resource_state = personalStateSchema.personalResourceState.pg
export const runner_delivery_cursors = outboxSchema.runnerDeliveryCursors.pg
export const session_transcripts = transcriptSchema.sessionTranscripts.pg
export const insight_spans = insightSchema.insightSpans.pg
export const insight_span_texts = insightSchema.insightSpanTexts.pg
export const insight_log_events = insightSchema.insightLogEvents.pg
export const workspace_projects = projectsSchema.workspaceProjects.pg
export const activity = activitySchema.activity.pg
export const notifications = notificationsSchema.notifications.pg
export const webhooks = webhooksSchema.webhooks.pg
export const webhook_deliveries = webhooksSchema.webhookDeliveries.pg
export const operation_receipts = receiptsSchema.operationReceipts.pg
