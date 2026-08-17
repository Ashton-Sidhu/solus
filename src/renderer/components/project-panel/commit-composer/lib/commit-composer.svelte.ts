import { SvelteSet } from 'svelte/reactivity'
import type { ChangedFileStat, IpcContext } from '../../../../../shared/types'
import type { HostApi } from '@client-core/host-api'
import { filterFiles, orderedSelection } from './commit-composer'

/** Ephemeral state for one open Commit composer: the changed-file list it
 *  fetched, the user's selection, and their draft message. Lives only as long
 *  as the modal is mounted — nothing here is durable or shared. */
export class CommitComposerState {
  files = $state<ChangedFileStat[]>([])
  loading = $state(true)
  loadError = $state<string | null>(null)
  selected = new SvelteSet<string>()
  message = $state('')
  query = $state('')

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

  /** Both act on what the search currently shows: with a query up, "Select all"
   *  that reached past the visible rows would commit files the user cannot see. */
  selectAll(): void {
    for (const file of this.visibleFiles) this.selected.add(file.path)
  }

  selectNone(): void {
    for (const file of this.visibleFiles) this.selected.delete(file.path)
  }

  get visibleFiles(): ChangedFileStat[] {
    return filterFiles(this.files, this.query)
  }

  get visibleSelectedCount(): number {
    return this.visibleFiles.reduce((count, file) => count + (this.selected.has(file.path) ? 1 : 0), 0)
  }

  get selectedFiles(): ChangedFileStat[] {
    return orderedSelection(this.files, this.selected)
  }

  get selectedPaths(): string[] {
    return this.selectedFiles.map((file) => file.path)
  }

  get canSubmit(): boolean {
    return !this.loading && this.selectedPaths.length > 0
  }
}
