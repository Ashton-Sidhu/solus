// drizzle-kit's SQLite entry: everything `solus.db` holds — the host tables
// (`./host`) and every ported table as a `sqlite-core` table. drizzle-kit reads
// named exports only, so each table is listed by hand; a ported domain adds its
// tables here and in `postgres.ts`, a host table in `./host`.
export * from './host'
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

export const tasks = tasksSchema.tasks.sqlite
export const task_sources = tasksSchema.taskSources.sqlite
export const task_source_items = tasksSchema.taskSourceItems.sqlite
export const task_source_access = tasksSchema.taskSourceAccess.sqlite
export const asset_publications = tasksSchema.assetPublications.sqlite
export const works = folioSchema.works.sqlite
export const work_revisions = folioSchema.workRevisions.sqlite
export const work_reviewers = folioSchema.workReviewers.sqlite
export const work_live_docs = folioSchema.workLiveDocs.sqlite
export const work_storage = folioSchema.workStorage.sqlite
export const work_storage_bodies = folioSchema.workStorageBodies.sqlite
export const plan_annotations = plansSchema.planAnnotations.sqlite
export const indexed_plans = plansSchema.indexedPlans.sqlite
export const plan_index_providers = plansSchema.planIndexProviders.sqlite
export const comment_threads = commentsSchema.commentThreads.sqlite
export const acl_entry = sharingSchema.aclEntry.sqlite
export const session = sessionsSchema.session.sqlite
export const resource_links = linksSchema.resourceLinks.sqlite
export const pull_request_observations = linksSchema.pullRequestObservations.sqlite
export const personal_resource_state = personalStateSchema.personalResourceState.sqlite
export const runner_delivery_cursors = outboxSchema.runnerDeliveryCursors.sqlite
export const session_transcripts = transcriptSchema.sessionTranscripts.sqlite
export const insight_spans = insightSchema.insightSpans.sqlite
export const insight_span_texts = insightSchema.insightSpanTexts.sqlite
export const insight_log_events = insightSchema.insightLogEvents.sqlite
export const workspace_projects = projectsSchema.workspaceProjects.sqlite
export const activity = activitySchema.activity.sqlite
export const notifications = notificationsSchema.notifications.sqlite
export const webhooks = webhooksSchema.webhooks.sqlite
export const webhook_deliveries = webhooksSchema.webhookDeliveries.sqlite
export const operation_receipts = receiptsSchema.operationReceipts.sqlite
