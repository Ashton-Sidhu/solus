import { serverConnections } from '@solus/client-core/server-connections'
import { DOCUMENT_SCHEMA_VERSION } from '@solus/document-model/schema'
import { DIAGRAM_LIVE_SCHEMA_VERSION } from '@solus/contracts/work-live'
import type { WorkType } from '@solus/contracts/types'
import { WorkLiveDoc, type LiveHost } from './work-live-doc.svelte'
import { indexedDbOffline, liveDatabaseName, recordUnsentLiveWork } from './work-live-offline'

/** The pane's hold on a live doc. Release it when the pane unmounts. */
export interface WorkLiveLease {
  readonly live: WorkLiveDoc
  release(): void
}

/** Whether people edit this kind of work live: documents and diagrams, never a Google-linked one. */
export function isLiveEditable(type: WorkType, googleLinked: boolean): boolean {
  return (type === 'doc' || type === 'diagram') && !googleLinked
}

function liveHost(serverId: string): LiveHost {
  return {
    api: () => serverConnections.apiFor(serverId),
    subscribe: (type, listener) => serverConnections.eventsFor(serverId).subscribe(type, listener),
    onConnection: (listener) => serverConnections.onStatusChange((changed, status) => {
      if (changed !== serverId) return
      if (status === 'connected') listener(true)
      else if (status === 'disconnected' || status === 'reconnecting') listener(false)
    }),
    isConnected: () => serverConnections.phaseFor(serverId) === 'connected',
  }
}

/**
 * The works open live in this window, one `WorkLiveDoc` per host and work,
 * shared by every pane that shows it and reference-counted, so two panes on one
 * work edit one doc (docs/plans/work-review-and-live-editing.md, phase 3b).
 */
export class WorkLiveStore {
  private readonly held = new Map<string, { live: WorkLiveDoc; refs: number }>()

  constructor(private readonly options: { title: (workId: string) => string }) {}

  /** `onLocalEdit` hears the reader's own edits (the presence roster's "editing"). */
  acquire(serverId: string, workId: string, type: 'doc' | 'diagram', onLocalEdit?: () => void): WorkLiveLease {
    const key = `${serverId}\u0000${workId}`
    let entry = this.held.get(key)
    if (!entry) {
      const database = liveDatabaseName(serverId, workId)
      const live = new WorkLiveDoc({
        workId,
        schemaVersion: type === 'doc' ? DOCUMENT_SCHEMA_VERSION : DIAGRAM_LIVE_SCHEMA_VERSION,
        host: liveHost(serverId),
        offline: indexedDbOffline(database) ?? undefined,
        onLocalEdit,
        onUnsentChange: (unsent) => recordUnsentLiveWork({ database, serverId, workId, title: this.options.title(workId), unsent }),
      })
      entry = { live, refs: 0 }
      this.held.set(key, entry)
      void live.start()
    }
    entry.refs += 1
    const held = entry
    let released = false
    return {
      live: held.live,
      release: () => {
        if (released) return
        released = true
        held.refs -= 1
        if (held.refs > 0) return
        this.held.delete(key)
        void held.live.destroy()
      },
    }
  }
}
