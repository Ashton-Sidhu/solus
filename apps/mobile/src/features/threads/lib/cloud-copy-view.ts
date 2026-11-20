import {
  sessionCloudCopyNote,
  sessionCloudCopyPlaceholder,
  type SessionCloudCopyState,
} from '@solus/client-core/session-cloud-copy'

/** The one thing the note beside a cloud copy offers. */
export type CloudCopyAction =
  | { kind: 'open-live'; hostId: string; label: string }
  | { kind: 'reload'; label: string }
  | { kind: 'retry'; label: string }

/**
 * What the thread shows of a session's copy from Solus Cloud
 * (docs/plans/portable-sessions-cloud.md, Phase 5B): the words that take the
 * conversation's place, a spinner, or the note beside the rows with its action.
 */
export interface CloudCopyView {
  /** Takes the conversation's place; null while rows or a spinner show. */
  placeholder: { title: string; detail: string } | null
  isLoading: boolean
  /** Above the composer, or above the asleep card when no host can run a prompt. */
  note: string | null
  action: CloudCopyAction | null
}

/** `runHostLabel` names the thread's host; `labelOf` names any host by its id. */
export function cloudCopyView(state: SessionCloudCopyState, runHostLabel: string, labelOf: (hostId: string) => string): CloudCopyView {
  if (state.kind === 'loading') return { placeholder: null, isLoading: true, note: null, action: null }
  if (state.kind === 'ready') {
    const stale = state.stale
    const action: CloudCopyAction | null = stale?.kind === 'host-online'
      ? { kind: 'open-live', hostId: stale.serverId, label: `Open on ${labelOf(stale.serverId)}` }
      : stale?.kind === 'head-changed' ? { kind: 'reload', label: 'Show newer turns' } : null
    return { placeholder: null, isLoading: false, note: sessionCloudCopyNote(state, labelOf), action }
  }
  const placeholder = sessionCloudCopyPlaceholder(state, runHostLabel)
  return state.kind === 'error'
    ? { placeholder, isLoading: false, note: 'Solus Cloud could not be read.', action: { kind: 'retry', label: 'Try again' } }
    : { placeholder, isLoading: false, note: null, action: null }
}
