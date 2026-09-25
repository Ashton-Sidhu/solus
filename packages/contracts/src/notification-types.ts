import { z } from 'zod'
import type { AttentionEntry, AttentionKind } from './attention-types'

const NOTIFIABLE_KINDS = new Set<AttentionKind>(['needs_approval', 'question', 'failed'])

// ─── Preferences ───
//
// Two independent axes. A channel is how a notification reaches the user; an
// event is what happened. A notification is delivered only when its event is
// on and the channel it would use is on, so "none" is every channel off.

export const NOTIFICATION_CHANNELS = ['sound', 'toast', 'system'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/** Session events: what an agent did. Delivered through the channels. */
export const SESSION_NOTIFICATION_EVENTS = [
  'needs_approval',
  'question',
  'turn_finished',
  'session_failed',
  'plan_ready',
  'work_created',
  'task_created',
  'automation_saved',
  'agent_conversation',
] as const
export type SessionNotificationEvent = (typeof SESSION_NOTIFICATION_EVENTS)[number]

/** App notices: something happened around the workspace rather than in a
 *  session. Always an in-app toast; the event switch is the only gate. */
export const APP_NOTICE_EVENTS = [
  'review_guide_ready',
  'review_lens_ready',
  'update_available',
  'host_discovered',
  'teammate_presence',
  'share_revoked',
] as const
export type AppNoticeEvent = (typeof APP_NOTICE_EVENTS)[number]

export const NOTIFICATION_EVENTS = [...SESSION_NOTIFICATION_EVENTS, ...APP_NOTICE_EVENTS] as const
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

export interface NotificationPreferences {
  channels: Record<NotificationChannel, boolean>
  events: Record<NotificationEvent, boolean>
}

/** Sound and system alerts on, toasts off: the behavior before preferences
 *  existed, so an upgrade changes nothing a user did not choose. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: { sound: true, toast: false, system: true },
  events: {
    needs_approval: true,
    question: true,
    turn_finished: true,
    session_failed: true,
    plan_ready: true,
    work_created: true,
    task_created: true,
    automation_saved: true,
    agent_conversation: true,
    review_guide_ready: true,
    review_lens_ready: true,
    update_available: true,
    host_discovered: true,
    teammate_presence: true,
    share_revoked: true,
  },
}

/** Partial on both axes: a settings switch sends the one flag it moved. */
export const notificationPreferencesPatchSchema = z.object({
  channels: z.object({
    sound: z.boolean().optional(),
    toast: z.boolean().optional(),
    system: z.boolean().optional(),
  }).strict().optional(),
  events: z.object({
    needs_approval: z.boolean().optional(),
    question: z.boolean().optional(),
    turn_finished: z.boolean().optional(),
    session_failed: z.boolean().optional(),
    plan_ready: z.boolean().optional(),
    work_created: z.boolean().optional(),
    task_created: z.boolean().optional(),
    automation_saved: z.boolean().optional(),
    agent_conversation: z.boolean().optional(),
    review_guide_ready: z.boolean().optional(),
    review_lens_ready: z.boolean().optional(),
    update_available: z.boolean().optional(),
    host_discovered: z.boolean().optional(),
    teammate_presence: z.boolean().optional(),
    share_revoked: z.boolean().optional(),
  }).strict().optional(),
}).strict()

export type NotificationPreferencesPatch = z.infer<typeof notificationPreferencesPatchSchema>

export function mergeNotificationPreferences(
  base: NotificationPreferences,
  patch: NotificationPreferencesPatch | undefined,
): NotificationPreferences {
  return {
    channels: { ...base.channels, ...patch?.channels },
    events: { ...base.events, ...patch?.events },
  }
}

export function shouldDeliverNotification(
  preferences: NotificationPreferences,
  channel: NotificationChannel,
  event: SessionNotificationEvent,
): boolean {
  return preferences.channels[channel] && preferences.events[event]
}

export function notificationEventForAttentionKind(kind: AttentionKind): SessionNotificationEvent {
  switch (kind) {
    case 'needs_approval': return 'needs_approval'
    case 'question': return 'question'
    case 'failed': return 'session_failed'
    case 'finished': return 'turn_finished'
  }
}

/** A trigger is finer than an event so the sound log can tell an artifact
 *  from a document; the preference switch is per event. */
export function notificationEventForSoundTrigger(trigger: NotificationSoundTrigger): SessionNotificationEvent {
  switch (trigger) {
    case 'turn_settled': return 'turn_finished'
    case 'permission_request': return 'needs_approval'
    case 'question_request': return 'question'
    case 'plan': return 'plan_ready'
    case 'work_created':
    case 'artifact_created':
      return 'work_created'
    case 'automation_saved': return 'automation_saved'
    case 'task_created': return 'task_created'
    case 'agent_conversation_new_card':
    case 'agent_conversation_needs_attention':
      return 'agent_conversation'
  }
}

export interface AttentionNotificationPayload {
  title: string
  body: string
  sessionId: string
  kind: AttentionKind
  entryKey: string
  installationId?: string
}

export interface ClientNotificationRequest extends AttentionNotificationPayload {
  route: string
  dedupKey: string
}

export type NotificationSoundTrigger =
  | 'turn_settled'
  | 'permission_request'
  | 'question_request'
  | 'plan'
  | 'work_created'
  | 'artifact_created'
  | 'automation_saved'
  | 'task_created'
  | 'agent_conversation_new_card'
  | 'agent_conversation_needs_attention'

export interface NotificationSoundLog {
  event: 'notification_sound_play_requested' | 'notification_sound_play_failed'
  sessionId: string
  agentSessionId: string | null
  trigger: NotificationSoundTrigger
  error?: string
}

export function isNotifiableAttentionEntry(entry: Pick<AttentionEntry, 'kind'>): boolean {
  return NOTIFIABLE_KINDS.has(entry.kind)
}

export function attentionEntryKey(entry: Pick<AttentionEntry, 'sessionId' | 'kind'>): string {
  return `${entry.sessionId}:${entry.kind}`
}

export function attentionNotificationDedupKey(
  hostId: string,
  entry: Pick<AttentionEntry, 'sessionId' | 'kind'>,
): string {
  return `${hostId}:${attentionEntryKey(entry)}`
}

export function payloadForAttentionEntry(
  entry: AttentionEntry,
  options: { installationId?: string; hostLabel?: string } = {},
): AttentionNotificationPayload {
  const summary = entry.summary || 'A Solus session needs attention.'
  const payload: AttentionNotificationPayload = {
    title: titleForKind(entry.kind),
    body: options.hostLabel ? `${summary} on ${options.hostLabel}` : summary,
    sessionId: entry.sessionId,
    kind: entry.kind,
    entryKey: attentionEntryKey(entry),
  }
  if (options.installationId) payload.installationId = options.installationId
  return payload
}

/** A scoped chat route. A notification click always names the host that owns
 * the run — a bare session route would resolve against whichever host answers. */
export function notificationSessionRoute(sessionId: string, serverId: string): string {
  return `/chat/${encodeURIComponent(sessionId)}~${encodeURIComponent(serverId)}`
}

function titleForKind(kind: AttentionKind): string {
  switch (kind) {
    case 'needs_approval': return 'Solus - needs approval'
    case 'question': return 'Solus - has a question'
    case 'failed': return 'Solus - session failed'
    case 'finished': return 'Turn finished'
  }
}
