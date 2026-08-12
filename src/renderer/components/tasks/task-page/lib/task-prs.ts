// Shaping for the task page's Pull requests section.
import type { TaskLink } from '../../../../../shared/task-types'

/** Lifecycle for a linked PR, as the PR store knows it. Null when nothing has
 *  loaded that PR yet: the row then renders without a state rather than
 *  guessing that it is open. */
export interface LinkedPrLifecycle {
  state: 'open' | 'closed' | 'merged'
  draft: boolean
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

/** Newest PR first — the most recent one is the work in flight, and the older
 *  ones are the trail behind it. */
export function taskPrRows(
  links: TaskLink[],
  lifecycleFor: (number: number) => LinkedPrLifecycle | null,
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
        title: titleWithoutPrRef(link.liveTitle || link.title, ref),
        url: link.url ?? null,
        state: valid ? lifecycleFor(number) : null,
      }
    })
    .sort((left, right) => right.number - left.number)
}
