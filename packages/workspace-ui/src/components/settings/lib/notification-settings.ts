import {
  APP_NOTICE_EVENTS,
  NOTIFICATION_CHANNELS,
  SESSION_NOTIFICATION_EVENTS,
  type AppNoticeEvent,
  type NotificationChannel,
  type SessionNotificationEvent,
} from '@solus/contracts/notification-types'

export interface NotificationSettingRow<Id extends string> {
  id: Id
  label: string
  description: string
  keywords: string[]
}

/** The one condition delivery turns on. A channel belongs to exactly one
 *  situation, so the page states the condition once per group and each row
 *  is only the channel. */
export type DeliverySituation = 'in_front' | 'in_background'

export interface DeliverySituationGroup {
  id: DeliverySituation
  label: string
  description: string
}

export const DELIVERY_SITUATIONS: DeliverySituationGroup[] = [
  {
    id: 'in_front',
    label: 'While Solus is in front',
    description: 'A session off screen needs you while Solus has focus.',
  },
  {
    id: 'in_background',
    label: 'While Solus is in the background',
    description: 'Solus is hidden, minimized, or behind another app.',
  },
]

export interface NotificationChannelRow extends NotificationSettingRow<NotificationChannel> {
  situation: DeliverySituation
}

/** One row per channel. Order is the order within its situation. */
export const NOTIFICATION_CHANNEL_ROWS: NotificationChannelRow[] = [
  {
    id: 'toast',
    situation: 'in_front',
    label: 'Toast',
    description: 'An in-app toast with an Open session action.',
    keywords: ['toast', 'background', 'activity', 'popup', 'in-app', 'front'],
  },
  {
    id: 'sound',
    situation: 'in_background',
    label: 'Sound',
    description: 'Play the notification sound.',
    keywords: ['sound', 'audio', 'chime', 'bell', 'mute', 'background'],
  },
  {
    id: 'system',
    situation: 'in_background',
    label: 'System alert',
    description: 'A desktop, browser, or push notification.',
    keywords: ['system', 'native', 'alert', 'push', 'desktop', 'browser', 'os', 'background'],
  },
]

/** One row per session event. Order is the order on the page. */
export const SESSION_EVENT_ROWS: NotificationSettingRow<SessionNotificationEvent>[] = [
  {
    id: 'needs_approval',
    label: 'Needs approval',
    description: 'An agent waits for permission to run a tool.',
    keywords: ['approval', 'permission', 'approve', 'tool'],
  },
  {
    id: 'question',
    label: 'Question',
    description: 'An agent asks you a question.',
    keywords: ['question', 'ask', 'answer'],
  },
  {
    id: 'turn_finished',
    label: 'Turn finished',
    description: 'An agent completes a turn.',
    keywords: ['turn', 'finished', 'done', 'complete', 'settled'],
  },
  {
    id: 'session_failed',
    label: 'Session failed',
    description: 'A session stops with an error.',
    keywords: ['failed', 'error', 'crash', 'stopped'],
  },
  {
    id: 'plan_ready',
    label: 'Plan ready',
    description: 'An agent writes a plan for review.',
    keywords: ['plan', 'review', 'ready'],
  },
  {
    id: 'work_created',
    label: 'Work created',
    description: 'An agent creates a document, deck, diagram, or artifact.',
    keywords: ['work', 'document', 'artifact', 'diagram', 'slides', 'created'],
  },
  {
    id: 'task_created',
    label: 'Task created',
    description: 'An agent creates a task.',
    keywords: ['task', 'created'],
  },
  {
    id: 'automation_saved',
    label: 'Automation saved',
    description: 'An agent creates or updates an automation.',
    keywords: ['automation', 'saved', 'schedule'],
  },
  {
    id: 'agent_conversation',
    label: 'Agent conversation',
    description: 'A sub-agent posts a new card or needs attention.',
    keywords: ['agent', 'conversation', 'subagent', 'card', 'attention'],
  },
]

/** One row per app notice. Order is the order on the page. */
export const APP_NOTICE_ROWS: NotificationSettingRow<AppNoticeEvent>[] = [
  {
    id: 'review_guide_ready',
    label: 'Review guide ready',
    description: 'A review guide finishes for a pull request or a session.',
    keywords: ['review', 'guide', 'pull request', 'pr', 'companion'],
  },
  {
    id: 'update_available',
    label: 'Software updates',
    description: 'An update is ready for Solus, Claude Code, or Codex.',
    keywords: ['update', 'upgrade', 'release', 'version', 'restart', 'download', 'solus', 'claude', 'codex'],
  },
  {
    id: 'host_discovered',
    label: 'Host found nearby',
    description: 'A Solus host appears on the local network.',
    keywords: ['host', 'server', 'nearby', 'discover', 'network', 'lan', 'connection'],
  },
  {
    id: 'teammate_presence',
    label: 'Teammates',
    description: 'A teammate joins your host, or leaves while you follow them.',
    keywords: ['teammate', 'presence', 'joined', 'left', 'follow', 'people'],
  },
  {
    id: 'share_revoked',
    label: 'Sharing',
    description: 'You lose access to a shared session, task, or work.',
    keywords: ['share', 'sharing', 'access', 'removed', 'revoked'],
  },
]

/** Every list must cover its part of the contract in full: an event with no
 *  switch is one the user cannot turn off. */
export function notificationSettingsCoverContract(): boolean {
  return (
    coversExactly(NOTIFICATION_CHANNEL_ROWS, NOTIFICATION_CHANNELS) &&
    coversExactly(SESSION_EVENT_ROWS, SESSION_NOTIFICATION_EVENTS) &&
    coversExactly(APP_NOTICE_ROWS, APP_NOTICE_EVENTS)
  )
}

function coversExactly<Id extends string>(
  rows: NotificationSettingRow<Id>[],
  ids: readonly Id[],
): boolean {
  const seen = new Set(rows.map((row) => row.id))
  return ids.every((id) => seen.has(id)) && seen.size === ids.length && rows.length === ids.length
}

export function notificationRowMatches<Id extends string>(
  row: NotificationSettingRow<Id>,
  searchQuery: string,
): boolean {
  if (!searchQuery) return true
  const query = searchQuery.toLowerCase()
  return (
    row.label.toLowerCase().includes(query) ||
    row.keywords.some((keyword) => keyword.includes(query))
  )
}
