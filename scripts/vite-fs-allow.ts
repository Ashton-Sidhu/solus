import { existsSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Directories the dev server must be allowed to serve from.
 *
 * A git worktree has no `node_modules` of its own, so Node resolution walks up
 * and finds the primary checkout's. Vite's default `fs.allow` is the project
 * root — the worktree — so that directory is outside it. Pre-bundled imports
 * survive (the optimizer copies them into the project's own `.vite` cache), but
 * an asset referenced by URL does not: the `@pierre/diffs` highlighter worker is
 * spawned from `new URL('@pierre/diffs/worker/worker.js', import.meta.url)` and
 * is served over `/@fs/`, which answers 403. The worker then never spawns, the
 * pool never reports ready, and every surface that waits for it — the diff
 * views and the raw markdown editor — renders nothing at all.
 *
 * So allow every `node_modules` on the lookup path, which is the same set Node
 * itself will resolve from. Reading the directories rather than resolving a
 * package keeps this independent of any one dependency's export conditions.
 */
export function devServeRoots(projectRoot: string): string[] {
  const roots = [projectRoot]
  for (let dir = projectRoot; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules')
    if (dir !== projectRoot && existsSync(candidate)) roots.push(candidate)
    if (dirname(dir) === dir) break
  }
  return roots
}
