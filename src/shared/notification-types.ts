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
  return {
    title: titleForKind(entry.kind),
    body: options.hostLabel ? `${summary} on ${options.hostLabel}` : summary,
    sessionId: entry.sessionId,
    kind: entry.kind,
    entryKey: attentionEntryKey(entry),
    ...(options.installationId ? { installationId: options.installationId } : {}),
  }
}

/** A scoped chat route. The `~` suffix is optional so older bare-session routes
 * remain valid while notification clicks can name the host that owns the run. */
export function notificationSessionRoute(sessionId: string, serverId?: string): string {
  const session = encodeURIComponent(sessionId)
  return serverId
    ? `/chat/${session}~${encodeURIComponent(serverId)}`
    : `/chat/${session}`
}

function titleForKind(kind: AttentionKind): string {
  switch (kind) {
    case 'needs_approval': return 'Solus - needs approval'
    case 'question': return 'Solus - has a question'
    case 'failed': return 'Solus - session failed'
    case 'finished': return 'Solus - finished'
  }
}
