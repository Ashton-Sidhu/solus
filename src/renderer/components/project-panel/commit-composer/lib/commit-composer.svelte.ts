import { SvelteSet } from 'svelte/reactivity'
import type { ChangedFileStat, IpcContext } from '../../../../../shared/types'
import type { HostApi } from '@client-core/host-api'
import { orderedSelection } from './commit-composer'

/** Ephemeral state for one open Commit composer: the changed-file list it
 *  fetched, the user's selection, and their draft message. Lives only as long
 *  as the modal is mounted — nothing here is durable or shared. */
export class CommitComposerState {
  files = $state<ChangedFileStat[]>([])
  loading = $state(true)
  loadError = $state<string | null>(null)
  selected = new SvelteSet<string>()
  message = $state('')

  async load(api: HostApi, ctx: IpcContext): Promise<void> {
    this.loading = true
    this.loadError = null
    try {
      const files = await api.diffStats(ctx, { scope: { kind: 'working-tree' } })
      this.files = files
      this.selected.clear()
      for (const file of files) this.selected.add(file.path)
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
    }
  }

  toggle(path: string): void {
    if (this.selected.has(path)) this.selected.delete(path)
    else this.selected.add(path)
  }

  selectAll(): void {
    for (const file of this.files) this.selected.add(file.path)
  }

  selectNone(): void {
    this.selected.clear()
  }

  get selectedPaths(): string[] {
    return orderedSelection(this.files, this.selected)
  }

  get canSubmit(): boolean {
    return !this.loading && this.selectedPaths.length > 0
  }
}
