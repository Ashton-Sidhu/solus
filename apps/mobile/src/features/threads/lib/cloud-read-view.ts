import { sessionCloudReadText } from '@solus/client-core/session-cloud-read-text'
import type { SessionCloudReadProgress, SessionCloudReadSource, SessionCloudReadStatus, SessionCloudReadView } from '@solus/client-core/session-cloud-read'

export type CloudReadAction =
  | { kind: 'open-live'; hostId: string; label: string }
  | { kind: 'reload'; label: string }
  | { kind: 'retry'; label: string }

export interface CloudReadView {
  placeholder: { title: string; detail: string } | null
  isLoading: boolean
  note: string | null
  action: CloudReadAction | null
}

/**
 * How far this phone read the copy, for the shared view rule. With no Solus
 * API connection there is nothing to ask, and no read starts: the copy has no
 * rows. Null while no read started, and when a host shows the conversation.
 */
export function cloudReadProgress(input: {
  status: SessionCloudReadStatus
  source: SessionCloudReadSource | null
  hasConnection: boolean
  hasNewerRows: boolean
}): SessionCloudReadProgress | null {
  const { status } = input
  if (status.kind !== 'idle') return { status: status.kind, error: status.kind === 'error' ? status.message : null, hasNewerRows: input.hasNewerRows }
  return input.source === 'cloud' && !input.hasConnection ? { status: 'ready', error: null, hasNewerRows: false } : null
}

/** The phone layout of the shared cloud read words and action. */
export function cloudReadView(state: SessionCloudReadView, runHostLabel: string, liveServerId: string | null, labelOf: (hostId: string) => string): CloudReadView {
  const hostLabel = state.kind === 'stale' && state.reason === 'host-online' && liveServerId ? labelOf(liveServerId) : runHostLabel
  const words = sessionCloudReadText(state, hostLabel)
  const action: CloudReadAction | null = words.action === 'show-live' && liveServerId
    ? { kind: 'open-live', hostId: liveServerId, label: `Open on ${hostLabel}` }
    : words.action === 'show-newer' ? { kind: 'reload', label: 'Show newer turns' }
    : words.action === 'retry' ? { kind: 'retry', label: 'Try again' } : null
  if (state.kind === 'loading') return { placeholder: null, isLoading: true, note: null, action: null }
  if (state.kind === 'ready' || state.kind === 'stale') return { placeholder: null, isLoading: false, note: [words.message, words.detail].filter(Boolean).join(' '), action }
  return { placeholder: { title: words.message, detail: words.detail ?? '' }, isLoading: false, note: state.kind === 'error' ? words.message : null, action }
}
