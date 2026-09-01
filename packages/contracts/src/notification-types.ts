import type { AttentionEntry, AttentionKind } from './attention-types'

const NOTIFIABLE_KINDS = new Set<AttentionKind>(['needs_approval', 'question', 'failed'])

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
    case 'finished': return 'Solus - finished'
  }
}
