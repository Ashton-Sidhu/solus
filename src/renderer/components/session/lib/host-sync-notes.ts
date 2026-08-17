import type { DomainSyncState } from '@client-core/freshness'

export interface HostSyncNote {
  serverId: string
  /** Ready to render: "laptop · last known", "studio · sync error". */
  text: string
}

/**
 * The hosts whose history rows are not live, for the picker's honesty line
 * (dispatch-client step 2): cached rows render, and this says so. A
 * `synchronizing` host is the loading ellipsis's business, not a note; a
 * live host with a recorded error is the "connected, sync error" case.
 */
export function hostSyncNotes(
  hostStates: Iterable<[string, DomainSyncState]>,
  labelFor: (serverId: string) => string | null,
): HostSyncNote[] {
  const notes: HostSyncNote[] = []
  for (const [serverId, state] of hostStates) {
    if (state.freshness === 'synchronizing') continue
    if (state.freshness === 'live' && !state.error) continue
    const label = labelFor(serverId) ?? serverId
    const wording = state.error
      ? 'sync error'
      : state.freshness === 'empty' ? 'no history' : 'last known'
    notes.push({ serverId, text: `${label} · ${wording}` })
  }
  return notes
}
