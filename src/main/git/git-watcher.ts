import { watch, type FSWatcher } from 'fs'
import path from 'path'
import { runAsync } from './exec'
import { createLogger } from '../logger'

const log = createLogger('main', 'git-watcher')

/** Coalesce bursts (a checkout touches HEAD + several refs + index in quick succession). */
const DEBOUNCE_MS = 250

interface WatchEntry {
  refCount: number
  watchers: FSWatcher[]
  debounce: ReturnType<typeof setTimeout> | null
}

/**
 * Watches a git repo's HEAD / refs/heads / index for external changes — branch
 * switch, commit, stage done in a terminal — and fires a debounced callback so
 * the Environment panel and pill can mirror reality instead of drifting.
 *
 * Keyed and ref-counted by `repoRoot` so multiple tabs sharing a repo share one
 * set of `fs.watch` handles. The real git dir is resolved via
 * `git rev-parse --git-common-dir` (worktrees use a `.git` *file*, so we resolve
 * rather than assume `<repoRoot>/.git`).
 */
export class GitWatcher {
  private entries = new Map<string, WatchEntry>()

  constructor(private onChange: (repoRoot: string) => void) {}

  register(repoRoot: string): void {
    const existing = this.entries.get(repoRoot)
    if (existing) {
      existing.refCount++
      return
    }
    // Insert the entry synchronously so concurrent register/deregister calls
    // ref-count against the same slot while we await the git dir resolution.
    const entry: WatchEntry = { refCount: 1, watchers: [], debounce: null }
    this.entries.set(repoRoot, entry)
    void this._attach(repoRoot, entry)
  }

  deregister(repoRoot: string): void {
    const entry = this.entries.get(repoRoot)
    if (!entry) return
    entry.refCount--
    if (entry.refCount > 0) return
    this.entries.delete(repoRoot)
    if (entry.debounce) clearTimeout(entry.debounce)
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        /* already closed */
      }
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.debounce) clearTimeout(entry.debounce)
      for (const w of entry.watchers) {
        try {
          w.close()
        } catch {
          /* already closed */
        }
      }
    }
    this.entries.clear()
  }

  private async _attach(repoRoot: string, entry: WatchEntry): Promise<void> {
    const gitDir = await this._resolveGitDir(repoRoot)
    // Bail if the entry was released (all tabs closed) while we awaited.
    if (!gitDir || this.entries.get(repoRoot) !== entry) return

    const targets: Array<{ p: string; recursive: boolean }> = [
      { p: path.join(gitDir, 'HEAD'), recursive: false },
      { p: path.join(gitDir, 'refs', 'heads'), recursive: true },
      { p: path.join(gitDir, 'index'), recursive: false },
    ]
    for (const { p, recursive } of targets) {
      try {
        const w = watch(p, { recursive }, () => this._schedule(repoRoot))
        w.on('error', () => {
          /* file vanished (e.g. index rewritten); fs.watch self-heals or the next register re-attaches */
        })
        entry.watchers.push(w)
      } catch {
        // The path may not exist yet (fresh repo with no index, no local refs).
        // The other targets still cover the common cases.
      }
    }
    log.info(`Watching git dir for ${repoRoot} (${entry.watchers.length} targets)`)
  }

  private _schedule(repoRoot: string): void {
    const entry = this.entries.get(repoRoot)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = null
      this.onChange(repoRoot)
    }, DEBOUNCE_MS)
    ;(entry.debounce as unknown as { unref?: () => void }).unref?.()
  }

  private async _resolveGitDir(repoRoot: string): Promise<string | null> {
    try {
      const commonDir = await runAsync('git', ['rev-parse', '--git-common-dir'], repoRoot)
      return path.isAbsolute(commonDir) ? commonDir : path.resolve(repoRoot, commonDir)
    } catch {
      return null
    }
  }
}
