import type { BrowserPage } from '@solus/contracts/browser-types'
import type { BrowserPageEntry } from '../../../contexts/browser/browser.store.svelte'

/**
 * The strip along the top of the pane: pages, grouped by the worktree serving
 * them.
 *
 * Two worktrees serving the same app look identical in an address bar — same
 * host, same routes, different port — so the port is the worst possible thing to
 * read a browser page by. The branch is what the user is actually working on, so
 * it leads. Pages use their document title, like ordinary browser tabs; the route
 * appears in the label only when two pages in one branch need disambiguation.
 */

export interface BrowserPageGroup {
  /** Stable across renders: the branch is the identity, and a group with no
   *  branch is the one bucket for everything served from outside a worktree. */
  key: string
  label: string
  entries: BrowserPageEntry[]
}

/** Pages served from outside any git worktree. Named rather than blank, because
 *  a group heading with no words reads as a rendering bug. */
const UNTRACKED_GROUP = 'Other'

function branchOf(entry: BrowserPageEntry): string {
  const { target } = entry.page
  if (target.kind !== 'url') return UNTRACKED_GROUP
  return target.branch ?? UNTRACKED_GROUP
}

/**
 * Group the open pages by branch, keeping the order the pages were opened in
 * both within a group and between groups.
 *
 * Insertion order is the whole ordering rule: a strip that re-sorted itself
 * would move the page under the pointer between one click and the next.
 */
export function groupPagesByBranch(entries: BrowserPageEntry[]): BrowserPageGroup[] {
  const groups = new Map<string, BrowserPageGroup>()
  for (const entry of entries) {
    const key = branchOf(entry)
    const group = groups.get(key)
    if (group) {
      group.entries.push(entry)
      continue
    }
    groups.set(key, { key, label: key, entries: [entry] })
  }
  return [...groups.values()]
}

/**
 * The one thing a page's pill says about itself beyond its route.
 *
 * A page that is loading or has fallen over is the page the user wants to look
 * at next, and the strip is where they choose. Without this the strip is inert:
 * a dev server that died takes the frame with it, and every pill still reads as
 * though nothing happened.
 *
 * `no-surface` is deliberately not a failure. It says nothing about the page —
 * only that nothing is currently rendering it — and a dot on every quietly
 * opened page would make the one that matters unreadable.
 */
export type BrowserPageStatus = 'failed' | 'loading' | null

export function pageStatus(page: BrowserPage): BrowserPageStatus {
  if (page.problem && page.problem.kind !== 'no-surface') return 'failed'
  if (page.loadState === 'loading') return 'loading'
  return null
}

/** A short route for disambiguation and the page pill's tooltip. */
export function routeLabel(url: string): string {
  try {
    const { pathname, search } = new URL(url)
    const route = `${pathname}${search}`
    return route === '/' ? '/' : route.replace(/\/$/, '')
  } catch {
    return url || '/'
  }
}

/**
 * The label one page's pill shows.
 *
 * Browser tabs lead with the document title because that is the name the page
 * chose for people. A route is implementation detail until two pages in the
 * same branch have the same title; then it is the smallest useful qualifier.
 * Pages that have not reported a title yet fall back to their route rather than
 * showing a blank pill.
 */
export function pageLabel(page: BrowserPage, siblings: BrowserPageEntry[]): string {
  const title = page.title.trim()
  if (!title) return routeLabel(page.url)

  const hasDuplicateTitle = siblings.some(
    (candidate) =>
      candidate.page.browserPageId !== page.browserPageId &&
      candidate.page.title.trim() === title,
  )
  return hasDuplicateTitle ? `${title} · ${routeLabel(page.url)}` : title
}
