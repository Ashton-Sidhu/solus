// The files the viewer marked viewed on one pull request, as the code host
// keeps them.
//
// The host is the only record (`capabilities.viewedFiles`): GitHub shows the
// same marks on its own page, so this holds no local copy. A toggle shows at
// once, goes to the host in a batch after a short pause, and goes back to what
// it was if the host refuses it. The refusal stays in `writeError` until a
// later write succeeds.

import { SvelteMap } from 'svelte/reactivity'
import type { PrViewedFileChange, PrViewedFileState, PrViewedFiles as HostViewedFiles } from '@solus/contracts/providers'

/** `unknown`: the host listed fewer files than the pull request has, and not this one. */
export type ViewedFileState = PrViewedFileState | 'unknown'

/** The most changes one `prSetFilesViewed` call takes. */
export const VIEWED_FILES_BATCH_LIMIT = 3000

/** How long a read answers for a surface that opens again. Each read goes to
 *  the code host, so a pane that mounts again soon after shows what it read. */
export const VIEWED_FILES_FRESH_MS = 30_000

export interface PrViewedFilesDeps {
  read: () => Promise<HostViewedFiles>
  write: (changes: PrViewedFileChange[]) => Promise<void>
  /** How long toggles wait for more toggles before they go to the host. */
  debounceMs?: number
}

export class PrViewedFiles {
  /** False until the first read answers. */
  loaded = $state(false)
  /** False when the host listed only part of the files. */
  complete = $state(true)
  loadError = $state<string | null>(null)
  /** Why the host refused the last write; the marks went back. */
  writeError = $state<string | null>(null)

  readonly #states = new SvelteMap<string, PrViewedFileState>()
  /** Toggles not yet sent: the last one for a path wins. */
  readonly #pending = new Map<string, boolean>()
  /** What each pending path showed before its first unsent toggle. */
  readonly #before = new Map<string, PrViewedFileState | undefined>()
  /** Paths whose write the host has not answered yet. */
  readonly #writing = new Map<string, number>()
  readonly #deps: PrViewedFilesDeps
  #timer: ReturnType<typeof setTimeout> | null = null
  #readGeneration = 0
  /** When the last read answered; 0 before one did. */
  #readAt = 0
  #reading: Promise<void> | null = null

  constructor(deps: PrViewedFilesDeps) {
    this.#deps = deps
  }

  stateFor(path: string): ViewedFileState {
    return this.#states.get(path) ?? (this.complete ? 'unviewed' : 'unknown')
  }

  isViewed(path: string): boolean {
    return this.#states.get(path) === 'viewed'
  }

  /** How many of `paths` are marked viewed now. */
  viewedCount(paths: readonly string[]): number {
    let count = 0
    for (const path of paths) if (this.#states.get(path) === 'viewed') count++
    return count
  }

  /**
   * Read the marks again. A read on the wire answers every caller, and a read
   * that answered within `VIEWED_FILES_FRESH_MS` is not repeated unless
   * `force`. A path with a toggle not yet answered keeps the toggle.
   */
  async load(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force) {
      if (this.#reading) return this.#reading
      if (this.loaded && Date.now() - this.#readAt < VIEWED_FILES_FRESH_MS) return
    }
    const reading = this.#read()
    this.#reading = reading
    try {
      await reading
    } finally {
      if (this.#reading === reading) this.#reading = null
    }
  }

  async #read(): Promise<void> {
    const generation = ++this.#readGeneration
    try {
      const answer = await this.#deps.read()
      if (generation !== this.#readGeneration) return
      const listed = new Set<string>()
      for (const file of answer.files) {
        listed.add(file.path)
        if (!this.#isUnanswered(file.path)) this.#states.set(file.path, file.state)
      }
      for (const path of this.#states.keys()) {
        if (!listed.has(path) && !this.#isUnanswered(path)) this.#states.delete(path)
      }
      this.complete = answer.complete
      this.loadError = null
      this.loaded = true
      this.#readAt = Date.now()
    } catch (error) {
      if (generation !== this.#readGeneration) return
      this.loadError = error instanceof Error ? error.message : String(error)
    }
  }

  /** Mark a file viewed, or take the mark back. A file that changed since it
   *  was viewed (`dismissed`) becomes viewed again. */
  toggle(path: string): void {
    this.setViewed(path, this.#states.get(path) !== 'viewed')
  }

  setViewed(path: string, viewed: boolean): void {
    if (!this.#before.has(path)) this.#before.set(path, this.#states.get(path))
    this.#states.set(path, viewed ? 'viewed' : 'unviewed')
    this.#pending.set(path, viewed)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => void this.flush(), this.#deps.debounceMs ?? 400)
  }

  /** Send every unsent toggle now. */
  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#pending.size === 0) return
    const changes = [...this.#pending].map(([path, viewed]) => ({ path, viewed }))
    const before = new Map(this.#before)
    this.#pending.clear()
    this.#before.clear()
    for (const { path } of changes) this.#writing.set(path, (this.#writing.get(path) ?? 0) + 1)
    try {
      for (let start = 0; start < changes.length; start += VIEWED_FILES_BATCH_LIMIT) {
        await this.#deps.write(changes.slice(start, start + VIEWED_FILES_BATCH_LIMIT))
      }
      this.writeError = null
    } catch (error) {
      for (const { path, viewed } of changes) {
        // A newer toggle of the same path is the reader's latest choice.
        if (this.#pending.has(path) || this.#states.get(path) !== (viewed ? 'viewed' : 'unviewed')) continue
        const previous = before.get(path)
        if (previous === undefined) this.#states.delete(path)
        else this.#states.set(path, previous)
      }
      this.writeError = error instanceof Error ? error.message : String(error)
    } finally {
      for (const { path } of changes) {
        const count = (this.#writing.get(path) ?? 1) - 1
        if (count > 0) this.#writing.set(path, count)
        else this.#writing.delete(path)
      }
    }
  }

  #isUnanswered(path: string): boolean {
    return this.#pending.has(path) || this.#writing.has(path)
  }
}
