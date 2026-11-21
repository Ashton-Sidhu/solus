import type { ResourceWatch } from '@solus/contracts/integrations/resource-watch'
import { RESOURCE_WATCHES } from '@solus/client-core/resource-watch-row'
import { SessionHostRecords } from './session-host-records.svelte'

/** Each session's resource watches (docs/plans/mcp-first-class.md §11.5), and the command of their rows. */
export class ResourceWatchesStore extends SessionHostRecords<ResourceWatch, 'integration.resourceWatchChanged'> {
  constructor() {
    super(RESOURCE_WATCHES)
  }

  /** The row ends from the host's event. */
  async stop(watch: Pick<ResourceWatch, 'id' | 'sessionId'>): Promise<void> {
    await this.sessions.hostApiOf(watch.sessionId).integrationResourceWatchStop({ sessionId: watch.sessionId, id: watch.id })
  }
}

export const resourceWatchesStore = new ResourceWatchesStore()
