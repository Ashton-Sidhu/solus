import type { Work } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { PresenceWatch } from '../../lib/presence-watch'

type WorkUpdates = Partial<Pick<Work, 'title' | 'preview' | 'content'>>
type CloudWorkApi = Pick<HostApi, 'loadWork' | 'loadWorkUpdatedAt'>

/** The saved copy a pane is reading. Checks never replace it or its draft. */
export class CloudWorkCopy {
  work: Work = $state()!
  ready = $state(false)
  changed = $state(false)
  error = $state<string | null>(null)
  reloading = $state(false)
  private generation = 0
  private closed = false
  private checks = new PresenceWatch(30_000)

  constructor(work: Work, private readonly api: CloudWorkApi) {
    this.work = { ...work }
  }

  watch(): () => void {
    const stop = this.checks.watch(this.work.id, () => this.check())
    return () => { this.closed = true; this.generation++; stop() }
  }

  async check(): Promise<void> {
    const generation = this.generation
    try {
      const version = await this.api.loadWorkUpdatedAt(this.work.id)
      if (this.closed || generation !== this.generation) return
      this.changed = version !== this.work.updatedAt
      this.error = version === null ? 'This work is no longer available in the cloud.' : null
    } catch {
      if (!this.closed && generation === this.generation) this.error = 'Could not check the cloud copy. Your current view is kept.'
    }
  }

  async reload(): Promise<boolean> {
    const generation = ++this.generation
    this.reloading = true
    try {
      const work = await this.api.loadWork(this.work.id)
      if (this.closed || generation !== this.generation) return false
      if (!work) throw new Error('This work is no longer available in the cloud.')
      this.work = work
      this.ready = true
      this.changed = false
      this.error = null
      return true
    } catch (error) {
      if (!this.closed && generation === this.generation) this.error = error instanceof Error ? error.message : 'Could not reload the cloud copy.'
      return false
    } finally {
      if (generation === this.generation) this.reloading = false
    }
  }

  async save(updates: WorkUpdates, write: (updates: WorkUpdates, expectedUpdatedAt: string) => Promise<Work>): Promise<void> {
    const generation = ++this.generation
    try {
      const saved = await write(updates, this.work.updatedAt)
      if (this.closed || generation !== this.generation) return
      Object.assign(this.work, saved)
      this.changed = false
      this.error = null
    } catch (error) {
      await this.check()
      throw error
    }
  }
}
