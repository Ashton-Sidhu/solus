import {
  getOrCreateWorkerPoolSingleton,
  type WorkerInitializationRenderOptions,
  type WorkerPoolManager,
  type WorkerPoolOptions,
  type WorkerStats,
} from '@pierre/diffs/worker'

// Keep the pool small so background tokenizers never starve the user's cores.
// Mirrors diffshub's sizing: (cores - 1), clamped to a low ceiling.
const POOL_OPTIONS: WorkerPoolOptions = {
  poolSize: Math.min(Math.max(1, (navigator.hardwareConcurrency ?? 1) - 1), 3),
  totalASTLRUCacheSize: 100,
  workerFactory: () => new Worker(
    new URL('@pierre/diffs/worker/worker.js', import.meta.url),
    { type: 'module' },
  ),
}

type SolusDiffThemeName = 'github-dark-default' | 'github-light-default'

export function getDiffThemeName(isDark: boolean): SolusDiffThemeName {
  return isDark ? 'github-dark-default' : 'github-light-default'
}

// Token (word-level) diff highlighting. Persisted by DiffPanel under this key;
// only an explicit "off" disables it. Read here so the pool initializes with the
// user's choice and the first diff render doesn't flash word-highlights they
// turned off (the pool's render options win over per-instance options).
const TOKEN_HIGHLIGHT_KEY = 'solus-diff-token-highlight'

function storedTokenHighlight(): boolean {
  return typeof localStorage === 'undefined' || localStorage.getItem(TOKEN_HIGHLIGHT_KEY) !== 'off'
}

function lineDiffTypeFor(tokenHighlight: boolean): 'word-alt' | 'none' {
  return tokenHighlight ? 'word-alt' : 'none'
}

// The theme MUST match the `theme` option every CodeView/FileDiff instance
// passes — when a pool is attached the render theme is taken from the pool, not
// the instance. Use an active single theme instead of a light/dark pair: in
// Solus's Electron runtime the dual-theme output relies on `light-dark(...)`
// inside Pierre's shadow DOM, which leaves token spans monochrome. A single
// theme makes Shiki emit concrete inline token colors. Keep the worker options
// limited to the documented render options; @pierre/diffs resolves languages per
// render task, and forcing token transformation globally changes the worker AST
// shape even for diffs that only need normal syntax colors.
const HIGHLIGHTER_OPTIONS: WorkerInitializationRenderOptions = {
  theme: getDiffThemeName(true),
  lineDiffType: lineDiffTypeFor(storedTokenHighlight()),
  preferredHighlighter: 'shiki-js',
}

/**
 * Shared worker pool that moves Shiki tokenization off the main thread and
 * caches highlighted ASTs (LRU). Without it, CodeView/FileDiff tokenize
 * synchronously on the main thread as virtualized rows scroll into view, which
 * drops frames on fast scroll. A single singleton is shared across every diff
 * view so the AST cache stays warm across opens. The pool auto-initializes its
 * workers and degrades to main-thread highlighting if a worker fails to spawn.
 */
export function getDiffWorkerPool(): WorkerPoolManager | undefined {
  if (typeof window === 'undefined') return undefined
  return getOrCreateWorkerPoolSingleton({
    poolOptions: POOL_OPTIONS,
    highlighterOptions: HIGHLIGHTER_OPTIONS,
  })
}

export function isDiffWorkerPoolReady(): boolean {
  const pool = getDiffWorkerPool()
  return pool == null || pool.isInitialized() || !pool.isWorkingPool()
}

export async function setDiffWorkerPoolTheme(isDark: boolean): Promise<void> {
  await getDiffWorkerPool()?.setRenderOptions({ theme: getDiffThemeName(isDark) })
}

// Toggle token (word-level) diff highlighting across every diff view. The pool's
// render options take precedence over per-instance options, so this — not the
// CodeView option — is what actually flips the word-diff decorations. The pool
// clears its AST caches and re-renders subscribed instances on change.
export async function setDiffWorkerPoolLineDiffType(tokenHighlight: boolean): Promise<void> {
  await getDiffWorkerPool()?.setRenderOptions({ lineDiffType: lineDiffTypeFor(tokenHighlight) })
}

export function onDiffWorkerPoolReady(callback: (pool: WorkerPoolManager) => void): () => void {
  const pool = getDiffWorkerPool()
  if (!pool) return () => {}

  let fired = false
  const maybeFire = (stats?: WorkerStats) => {
    if (fired) return
    const ready = stats
      ? stats.managerState === 'initialized' || stats.workersFailed
      : pool.isInitialized() || !pool.isWorkingPool()
    if (!ready) return
    fired = true
    callback(pool)
  }

  const unsubscribe = pool.subscribeToStatChanges(maybeFire)
  maybeFire()
  return unsubscribe
}

let warmScheduled = false

/**
 * Spin up the worker pool (spawn workers + load Shiki themes/languages) during
 * the first idle window after launch, so the *first* diff open of a session
 * doesn't pay the cold-start cost on the critical path. Scheduled on idle — not
 * at boot — so it never competes with app startup; the `timeout` still warms it
 * if the app stays busy. Idempotent: an on-demand open before the idle callback
 * fires creates the singleton, making this a no-op. Tradeoff: the workers exist
 * even if no diff is ever opened this session.
 */
export function warmDiffWorkerPool(): void {
  if (typeof window === 'undefined' || warmScheduled) return
  warmScheduled = true
  const warm = () => void getDiffWorkerPool()
  if ('requestIdleCallback' in window) {
    requestIdleCallback(warm, { timeout: 2000 })
  } else {
    setTimeout(warm, 1000)
  }
}
