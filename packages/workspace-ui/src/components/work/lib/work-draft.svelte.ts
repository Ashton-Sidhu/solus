import type { Work } from '@solus/contracts/types'
import { isStaleWrite, type OpenWork, type UnavailableReason } from '../../../contexts/works/open-work.svelte'
import type { OpenWorkLease } from '../../../contexts/works/works.store.svelte'

export type WorkUpdates = Partial<Pick<Work, 'title' | 'preview' | 'content'>>

/** Shown when a save or restore is refused because the saved body moved. */
const WORK_CONFLICT_MESSAGE = 'This work changed since you started editing. Reload the saved copy to continue.'

interface DraftOptions {
  /** The store's saved record for this work, when one is held. */
  saved: () => Work | undefined
  /** The host that owns the work now. */
  serverId: () => string | null
  /** A clean editor took a newer saved body from someone else. */
  onAccepted?: () => void
  /** A write was refused as stale: read the saved record again. */
  onStale?: () => void
}

/**
 * One pane's editing state over a shared saved record. `content` is the body
 * the pane handed its editor; it changes only when the pane adopts a saved
 * body, never on the pane's own save (the editor already shows that text, and
 * a late echo must not overwrite newer typing). `base*` is the saved version
 * the draft is based on. A clean draft accepts a newer saved body; a dirty
 * one keeps its edits and reports a conflict.
 */
export class WorkDraft {
  content = $state('')
  loaded = $state(false)
  dirty = $state(false)
  conflict = $state(false)
  baseContentVersion = 0
  private baseUpdatedAt = ''
  private baseContentHash = ''
  private baseServerId: string | null = null
  private saving = 0

  constructor(private readonly options: DraftOptions) {}

  /** Re-evaluate against the saved record: after it changes, and after a save or dirty change. */
  reconcile(): void {
    const saved = this.options.saved()
    if (!saved || this.saving > 0) return
    const serverId = this.options.serverId()
    if (!this.loaded) {
      this.adopt(saved, serverId)
      return
    }
    if (serverId === this.baseServerId) {
      if (saved.contentVersion < this.baseContentVersion) return
      if (saved.contentVersion === this.baseContentVersion) {
        // Only the record moved (a rename): the draft still applies to this body.
        if (Date.parse(saved.updatedAt) > Date.parse(this.baseUpdatedAt)) this.baseUpdatedAt = saved.updatedAt
        return
      }
    } else if (saved.contentHash === this.baseContentHash) {
      // The work moved host (Share) with the body this draft is based on.
      this.rebase(saved, serverId)
      return
    }
    if (this.dirty) {
      this.conflict = true
      return
    }
    this.adopt(saved, serverId)
    this.options.onAccepted?.()
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty
    if (!dirty) this.reconcile()
  }

  /**
   * Write from this draft. The preconditions are the draft's base, never the
   * newest versions the store holds: a save must not overwrite a body its
   * author has not seen. A known conflict is refused without a request.
   */
  async save(updates: WorkUpdates, write: (updates: WorkUpdates, base: Pick<Work, 'updatedAt' | 'contentVersion'>) => Promise<Work>): Promise<void> {
    if (this.conflict) throw new Error(WORK_CONFLICT_MESSAGE)
    this.saving++
    try {
      const saved = await write(updates, { updatedAt: this.baseUpdatedAt, contentVersion: this.baseContentVersion })
      if (saved.contentVersion >= this.baseContentVersion) this.rebase(saved, this.baseServerId)
    } catch (error) {
      if (isStaleWrite(error)) {
        this.conflict = true
        this.options.onStale?.()
        throw new Error(WORK_CONFLICT_MESSAGE)
      }
      throw error
    } finally {
      this.saving--
      this.reconcile()
    }
  }

  /** Drop local edits and take the saved body, as after an explicit reload or a restore. */
  discard(): void {
    const saved = this.options.saved()
    this.dirty = false
    this.conflict = false
    if (saved) this.adopt(saved, this.options.serverId())
  }

  private adopt(saved: Work, serverId: string | null): void {
    this.content = saved.content
    this.loaded = true
    this.conflict = false
    this.rebase(saved, serverId)
  }

  private rebase(saved: Work, serverId: string | null): void {
    this.baseContentVersion = saved.contentVersion
    this.baseUpdatedAt = saved.updatedAt
    this.baseContentHash = saved.contentHash
    this.baseServerId = serverId
  }
}

interface PaneWorks {
  openWork(workId: string, serverIdHint?: string): OpenWorkLease
  savedWork(workId: string): Work | undefined
  hostFor(workId: string): string | null
}

/** One pane's hold on a work: the shared open state and its own draft. */
export interface WorkPaneHold {
  readonly work: OpenWork
  readonly draft: WorkDraft
  close(): void
}

/** Open `workId` for one pane. The draft follows every accepted saved change. */
export function holdWorkForPane(works: PaneWorks, workId: string, serverIdHint: string | undefined, onAccepted: () => void): WorkPaneHold {
  const lease = works.openWork(workId, serverIdHint)
  const draft = new WorkDraft({
    saved: () => works.savedWork(workId),
    serverId: () => works.hostFor(workId),
    onAccepted,
    onStale: () => void lease.work.refresh(),
  })
  draft.reconcile()
  const stop = lease.work.onSaved(() => draft.reconcile())
  return {
    work: lease.work,
    draft,
    close: () => {
      stop()
      lease.release()
    },
  }
}

/** What an unavailable work's panes say. The draft stays on screen. */
export function unavailableMessage(reason: UnavailableReason | null): string {
  return reason === 'no-access'
    ? 'You can no longer open this work. Unsaved edits stay on this screen until you close it.'
    : 'This work was deleted. Unsaved edits stay on this screen until you close it.'
}
