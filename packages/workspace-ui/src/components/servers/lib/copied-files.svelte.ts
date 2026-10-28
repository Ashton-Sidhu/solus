import { SvelteSet } from 'svelte/reactivity'
import type { SolusAPI } from '@solus/contracts/host-api'
import type { IgnoredProjectFile, IgnoredProjectFiles } from '@solus/contracts/types'
import { includeChanges, initialSelection, isCopyable } from './copied-files'

type CopiedFilesApi = Pick<SolusAPI, 'listIgnoredProjectFiles' | 'setWorktreeIncluded'>

/**
 * The draft behind the copied files dialog (docs/run-on.md#copied-files): the
 * ignored files of one checkout, and the boxes the person has checked. Nothing
 * is written until Save.
 */
export class CopiedFilesDraft {
  files = $state<IgnoredProjectFile[]>([])
  truncated = $state(false)
  hasIncludeFile = $state(true)
  status = $state<'loading' | 'ready' | 'saving' | 'failed'>('loading')
  error = $state('')
  readonly chosen = new SvelteSet<string>()

  constructor(private readonly api: CopiedFilesApi, private readonly cwd: string) {}

  copyable = $derived(this.files.filter(isCopyable))
  changes = $derived(includeChanges(this.files, this.chosen))
  chosenBytes = $derived(this.files.reduce((total, file) => total + (this.chosen.has(file.path) ? file.byteLength : 0), 0))
  allChosen = $derived(this.copyable.length > 0 && this.copyable.every((file) => this.chosen.has(file.path)))

  async load(): Promise<void> {
    this.status = 'loading'
    this.error = ''
    try {
      this.#show(await this.api.listIgnoredProjectFiles(this.cwd))
    } catch {
      this.status = 'failed'
      this.error = 'Could not read the files git ignores in this project.'
    }
  }

  toggle(path: string, checked: boolean): void {
    if (checked) this.chosen.add(path)
    else this.chosen.delete(path)
  }

  /** Checks every file that fits, or clears them all when they are all checked. */
  toggleAll(): void {
    const next = !this.allChosen
    for (const file of this.copyable) this.toggle(file.path, next)
  }

  /** Writes the changes to `.worktreeinclude`. Answers whether it saved. */
  async save(): Promise<boolean> {
    if (this.status !== 'ready') return false
    this.status = 'saving'
    this.error = ''
    try {
      this.#show(await this.api.setWorktreeIncluded(this.cwd, this.changes))
      return true
    } catch {
      this.status = 'ready'
      this.error = 'Could not save .worktreeinclude. Try again.'
      return false
    }
  }

  #show(list: IgnoredProjectFiles): void {
    this.files = list.files
    this.truncated = list.truncated
    this.hasIncludeFile = list.hasIncludeFile
    this.chosen.clear()
    for (const path of initialSelection(list.files, list.hasIncludeFile)) this.chosen.add(path)
    this.status = 'ready'
  }
}
