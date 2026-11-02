import { ACTIVITY_TABLES } from '../../data/activity/schema'
import { WORK_TABLES } from '../../data/works/schema'
import { NOTIFICATION_TABLES } from '../../data/notifications/schema'
import { RECEIPT_TABLES } from '../../data/receipts/schema'
import { insightLogEvents, insightSpans, insightSpanTexts } from '../../data/insights/insight-schema'
import { OUTBOX_TABLES } from '../../sync/outbox/schema'
import { PLAN_TABLES } from '../../plans/schema'
import { PROJECT_TABLES } from '../../projects/schema'
import { SESSION_TABLES } from '../../data/sessions/schema'
import { sessionTranscripts } from '../../data/sessions/transcript-schema'
import { SHARING_TABLES } from '../../sharing/schema'
import { TASK_TABLES } from '../../data/tasks/schema'
import { WEBHOOK_TABLES } from '../../data/webhooks/schema'
import type { TableDefinition } from './define-table'

/** The mirrored transcript and Insights tables, in their registration order. */
const MIRROR_TABLES = [sessionTranscripts, insightSpans, insightSpanTexts, insightLogEvents]

/** Every table a ported domain declares. A domain adds its list here when it is ported. */
export const PORTED_TABLES: readonly TableDefinition[] = [
  ...TASK_TABLES, ...WORK_TABLES, ...PLAN_TABLES, ...SHARING_TABLES, ...SESSION_TABLES, ...OUTBOX_TABLES, ...MIRROR_TABLES,
  ...PROJECT_TABLES, ...ACTIVITY_TABLES, ...NOTIFICATION_TABLES, ...WEBHOOK_TABLES, ...RECEIPT_TABLES,
]
