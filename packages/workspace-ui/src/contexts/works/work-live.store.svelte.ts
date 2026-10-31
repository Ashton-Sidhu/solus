import { serverConnections } from '@solus/client-core/server-connections'
import { DIAGRAM_LIVE_SCHEMA_VERSION } from '@solus/contracts/work-live'
import type { WorkType } from '@solus/contracts/types'
import type { LiveHost, WorkLiveDoc } from './work-live-doc.svelte'

/**
 * The pane's hold on a live doc. Release it when the pane unmounts. The doc
 * arrives once its code loads: Yjs, and Tiptap for a document, load with the
 * first open work, not with the workspace.
 */
export interface WorkLiveLease {
  readonly live: Promise<WorkLiveDoc>
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
    onConnection: (listener) => serverConnections.onReadinessChange((changed, readiness) => {
      if (changed !== serverId) return
      if (readiness === 'ready') listener(true)
      else if (readiness === 'reconnecting' || readiness === 'unreachable' || readiness === 'refused') listener(false)
    }),
    isConnected: () => serverConnections.readinessFor(serverId).readiness === 'ready',
  }
}

/**
 * The works open live in this window, one `WorkLiveDoc` per host and work,
 * shared by every pane that shows it and reference-counted, so two panes on one
 * work edit one doc (docs/plans/work-review-and-live-editing.md, phase 3b).
 */
export class WorkLiveStore {
  private readonly held = new Map<string, { live: Promise<WorkLiveDoc>; refs: number }>()

  constructor(private readonly options: { title: (workId: string) => string }) {}

  /** `onLocalEdit` hears the reader's own edits (the presence roster's "editing"). */
  acquire(serverId: string, workId: string, type: 'doc' | 'diagram', onLocalEdit?: () => void): WorkLiveLease {
    const key = `${serverId}\u0000${workId}`
    let entry = this.held.get(key)
    if (!entry) {
      const live = this.open(serverId, workId, type, onLocalEdit)
      entry = { live, refs: 0 }
      this.held.set(key, entry)
      // A failed load is not kept: the next open tries again.
      live.catch(() => { if (this.held.get(key) === entry) this.held.delete(key) })
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
        void held.live.then((live) => live.destroy(), () => {})
      },
    }
  }

  private async open(serverId: string, workId: string, type: 'doc' | 'diagram', onLocalEdit?: () => void): Promise<WorkLiveDoc> {
    const [{ WorkLiveDoc }, { indexedDbOffline, liveDatabaseName, recordUnsentLiveWork }, schemaVersion] = await Promise.all([
      import('./work-live-doc.svelte'),
      import('./work-live-offline'),
      type === 'doc' ? import('@solus/document-model/schema').then((schema) => schema.DOCUMENT_SCHEMA_VERSION) : DIAGRAM_LIVE_SCHEMA_VERSION,
    ])
    const database = liveDatabaseName(serverId, workId)
    const live = new WorkLiveDoc({
      workId,
      schemaVersion,
      host: liveHost(serverId),
      offline: (await indexedDbOffline(database)) ?? undefined,
      onLocalEdit,
      onUnsentChange: (unsent) => recordUnsentLiveWork({ database, serverId, workId, title: this.options.title(workId), unsent }),
    })
    void live.start()
    return live
  }
}
