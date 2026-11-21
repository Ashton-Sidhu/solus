import { useCallback } from 'react'
import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { RESOURCE_WATCHES } from '@solus/client-core/resource-watch-row'
import { useSessionHostRecords } from './use-session-host-records'

export interface ResourceWatchesView {
  /** The live resource watches, and those that ended since the newest turn started. */
  readonly watches: readonly ResourceWatch[]
  readonly stop: (watch: ResourceWatch) => Promise<void>
}

/** A thread's resource watches (docs/plans/mcp-first-class.md §11.5), and the command of their rows. */
export function useResourceWatches(hostId: string, sessionId: string, turnActive: boolean): ResourceWatchesView {
  const { records: watches, hostApi } = useSessionHostRecords(hostId, sessionId, turnActive, RESOURCE_WATCHES)
  const stop = useCallback(async (watch: ResourceWatch) => {
    await hostApi().integrationResourceWatchStop({ sessionId: watch.sessionId, id: watch.id })
  }, [hostApi])
  return { watches, stop }
}
