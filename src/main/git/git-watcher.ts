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
  retry: ReturnType<typeof setTimeout> | null
  attachVersion: number
}

export interface GitWatchPaths {
  commonDir: string
  headPath: string
  indexPath: string
}

export interface GitWatchTarget {
  directory: string
  recursive: boolean
  names: Set<string> | null
}

/** Watch stable parent directories rather than HEAD/index themselves. Git replaces
 * both files atomically, which can strand a file-level fs.watch handle on the old
 * inode. Linked worktrees keep these files outside the common git directory. */
export function buildGitWatchTargets(paths: GitWatchPaths): GitWatchTarget[] {
  const targets = new Map<string, GitWatchTarget>()
  const add = (directory: string, recursive: boolean, name?: string) => {
    const existing = targets.get(directory)
    if (!existing) {
      targets.set(directory, {
        directory,
        recursive,
        names: name ? new Set([name]) : null,
      })
      return
    }
    existing.recursive ||= recursive
    if (!name || existing.names === null) {
      existing.names = null
    } else {
      existing.names.add(name)
    }
  }

  add(path.dirname(paths.headPath), false, path.basename(paths.headPath))
  add(path.dirname(paths.indexPath), false, path.basename(paths.indexPath))
  add(paths.commonDir, false, 'packed-refs')
  add(path.join(paths.commonDir, 'refs', 'heads'), true)
  return [...targets.values()]
}

/**
 * Watches a git repo's HEAD / refs/heads / index for external changes — branch
 * switch, commit, stage done in a terminal — and fires a debounced callback so
 * the Environment panel and pill can mirror reality instead of drifting.
 *
 * Keyed and ref-counted by checkout cwd so tabs on the same checkout share one
 * set of handles, while linked worktrees retain distinct HEAD/index watches.
 * Shared refs resolve through `--git-common-dir`; checkout identity resolves
 * through `--git-path`.
 */
export class GitWatcher {
  private entries = new Map<string, WatchEntry>()

  constructor(private onChange: (checkoutCwd: string) => void) {}

  register(checkoutCwd: string): void {
    const existing = this.entries.get(checkoutCwd)
    if (existing) {
      existing.refCount++
      return
    }
    // Insert the entry synchronously so concurrent register/deregister calls
    // ref-count against the same slot while we await the git dir resolution.
    const entry: WatchEntry = { refCount: 1, watchers: [], debounce: null, retry: null, attachVersion: 0 }
    this.entries.set(checkoutCwd, entry)
    void this._attach(checkoutCwd, entry)
  }

  deregister(checkoutCwd: string): void {
    const entry = this.entries.get(checkoutCwd)
    if (!entry) return
    entry.refCount--
    if (entry.refCount > 0) return
    this.entries.delete(checkoutCwd)
    if (entry.debounce) clearTimeout(entry.debounce)
    if (entry.retry) clearTimeout(entry.retry)
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
      if (entry.retry) clearTimeout(entry.retry)
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

  private async _attach(checkoutCwd: string, entry: WatchEntry): Promise<void> {
    const attachVersion = ++entry.attachVersion
    const paths = await this._resolveGitPaths(checkoutCwd)
    // Bail if the entry was released (all tabs closed) while we awaited.
    if (this.entries.get(checkoutCwd) !== entry || entry.attachVersion !== attachVersion) return
    if (!paths) {
      this._retryAttach(checkoutCwd, entry)
      return
    }

    for (const watcher of entry.watchers) watcher.close()
    entry.watchers = []
    for (const target of buildGitWatchTargets(paths)) {
      try {
        const w = watch(target.directory, { recursive: target.recursive }, (_eventType, filename) => {
          if (target.names && filename && !target.names.has(filename.toString())) return
          this._schedule(checkoutCwd)
        })
        w.on('error', () => {
          this._retryAttach(checkoutCwd, entry)
        })
        entry.watchers.push(w)
      } catch {
        // A fresh repository may not have local refs yet. Stable parent targets
        // still cover HEAD/index, and the retry repairs transient directory loss.
      }
    }
    log.info(`Watching git checkout ${checkoutCwd} (${entry.watchers.length} targets)`)
  }

  private _retryAttach(checkoutCwd: string, entry: WatchEntry): void {
    if (this.entries.get(checkoutCwd) !== entry || entry.retry) return
    for (const watcher of entry.watchers) {
      try { watcher.close() } catch { /* already closed */ }
    }
    entry.watchers = []
    entry.retry = setTimeout(() => {
      entry.retry = null
      if (this.entries.get(checkoutCwd) === entry) void this._attach(checkoutCwd, entry)
    }, 500)
    ;(entry.retry as unknown as { unref?: () => void }).unref?.()
  }

  private _schedule(checkoutCwd: string): void {
    const entry = this.entries.get(checkoutCwd)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    entry.debounce = setTimeout(() => {
      entry.debounce = null
      this.onChange(checkoutCwd)
    }, DEBOUNCE_MS)
    ;(entry.debounce as unknown as { unref?: () => void }).unref?.()
  }

  private async _resolveGitPaths(checkoutCwd: string): Promise<GitWatchPaths | null> {
    try {
      const [commonDirRaw, headPathRaw, indexPathRaw] = await Promise.all([
        runAsync('git', ['rev-parse', '--git-common-dir'], checkoutCwd),
        runAsync('git', ['rev-parse', '--git-path', 'HEAD'], checkoutCwd),
        runAsync('git', ['rev-parse', '--git-path', 'index'], checkoutCwd),
      ])
      const absolute = (value: string) => path.isAbsolute(value) ? value : path.resolve(checkoutCwd, value)
      return {
        commonDir: absolute(commonDirRaw),
        headPath: absolute(headPathRaw),
        indexPath: absolute(indexPathRaw),
      }
    } catch {
      return null
    }
  }
}
