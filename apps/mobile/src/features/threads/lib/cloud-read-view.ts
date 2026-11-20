import { sessionCloudReadText } from '@solus/client-core/session-cloud-read-text'
import type { SessionCloudReadView } from '@solus/client-core/session-cloud-read'

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
