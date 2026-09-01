// Shaping for the task page's Pull requests section.
import type { TaskLink } from '@solus/contracts/task-types'

/** Lifecycle for a linked PR, as the PR store knows it. Null when nothing has
 *  loaded that PR yet: the row then renders without a state rather than
 *  guessing that it is open. */
export interface LinkedPrLifecycle {
  state: 'open' | 'closed' | 'merged'
  draft: boolean
}

/** The lifecycle half of what the PR store knows, or null when it knows
 *  nothing. Shared by every surface that names a task's linked pull requests —
 *  the task page, the project rail, and the session preview — so none of them
 *  can decide differently what "no facts yet" looks like. */
export function prLifecycleOf(
  pr: { state: LinkedPrLifecycle['state']; draft: boolean } | null | undefined,
): LinkedPrLifecycle | null {
  return pr ? { state: pr.state, draft: pr.draft } : null
}

export interface TaskPrRow {
  key: string
  link: TaskLink
  /** The PR number; 0 when a legacy link stored something that is not one. */
  number: number
  ref: string
  title: string
  url: string | null
  state: LinkedPrLifecycle | null
}

/** The PR reference has its own column, so discard only an identical leading
 * prefix that a link source included in its title. */
function titleWithoutPrRef(title: string, ref: string): string {
  if (!title.startsWith(ref)) return title
  const remainder = title.slice(ref.length)
  if (!remainder || /^[-\s:–—]/.test(remainder)) {
    return remainder.replace(/^[-\s:–—]+/, '')
  }
  return title
}

/**
 * What a linked PR row calls the pull request.
 *
 * The live title wins, because a link's snapshot is written when the link is
 * made and never updated. It also has to: a link created from a path that knew
 * only the number stores `#65`, which is exactly the reference the row already
 * shows in its own column — strip that duplicate and the row has no name left
 * at all. `PrsStore` supplies the live title once some surface has read
 * the PR; until then the snapshot is all there is.
 */
export function linkedPrTitle(link: TaskLink, ref: string, liveTitle?: string): string {
  return titleWithoutPrRef(liveTitle || link.liveTitle || link.title, ref)
}

/** Newest PR first — the most recent one is the work in flight, and the older
 *  ones are the trail behind it. */
export function taskPrRows(
  links: TaskLink[],
  lifecycleFor: (number: number, link: TaskLink) => LinkedPrLifecycle | null,
  titleFor: (number: number, link: TaskLink) => string | undefined = () => undefined,
): TaskPrRow[] {
  return links
    .filter((link) => link.kind === 'pr')
    .map((link) => {
      const number = Number(link.targetKey)
      const valid = Number.isSafeInteger(number) && number > 0
      const ref = valid ? `#${number}` : link.targetKey
      return {
        key: `pr:${link.targetScope}:${link.targetKey}`,
        link,
        number: valid ? number : 0,
        ref,
        title: linkedPrTitle(link, ref, valid ? titleFor(number, link) : undefined),
        url: link.url ?? null,
        state: valid ? lifecycleFor(number, link) : null,
      }
    })
    .sort((left, right) => right.link.linkedAt - left.link.linkedAt)
}
