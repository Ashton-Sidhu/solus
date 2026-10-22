// The news a pull request watch woke the agent with, read back from the wake's
// own text (docs/plans/pr-watch.md §12). The host writes the wake as one prompt
// (`prs/pr-watch-rules.ts` `wakeText`), and a history row keeps no origin, so
// the text is what every client has — live and after a reload alike. The
// first line is the watch's signature; `tests/unit/pull-request-watch-wake.test.ts`
// runs the host's template through this reader so the two cannot drift.

export type PullRequestWatchNewsKind = 'checks-failed' | 'checks-passed' | 'remarks' | 'conflicting' | 'closed'

export interface PullRequestWatchWake {
  number: number
  url: string
  /** Each kind of news once, in the order the wake lists it. */
  news: PullRequestWatchNewsKind[]
  /** The watch ended with this wake: the pull request closed, the remarks
   *  limit was reached, or the host could not read it. */
  ended: boolean
  /** The news needs the agent: a failure, a conflict, a close, or an end the
   *  agent did not ask for. */
  attention: boolean
}

const UPDATE_LINE = /^Update on pull request #(\d+) \((\S+)\), which Solus is watching for you/
const UNREADABLE_LINE = /^Solus stopped watching pull request #(\d+) \((\S+)\) because it could not read it/

const NEWS_LINES: ReadonlyArray<readonly [RegExp, PullRequestWatchNewsKind]> = [
  [/^- Checks failed:/, 'checks-failed'],
  [/^- Every check that gates the merge passed/, 'checks-passed'],
  [/^- New comments and reviews:/, 'remarks'],
  [/^- The branch now conflicts with its base\./, 'conflicting'],
  [/^- The pull request was closed without merging\./, 'closed'],
]

const ATTENTION_NEWS = new Set<PullRequestWatchNewsKind>(['checks-failed', 'conflicting', 'closed'])

/** The wake this prompt is, or null for any other prompt. Reads only the first
 *  line before it commits, so a transcript of ordinary prompts pays nothing. */
export function pullRequestWatchWake(text: string): PullRequestWatchWake | null {
  const trimmed = text.trimStart()
  const firstLine = trimmed.slice(0, trimmed.indexOf('\n') === -1 ? undefined : trimmed.indexOf('\n'))
  const unreadable = UNREADABLE_LINE.exec(firstLine)
  if (unreadable) {
    return { number: Number(unreadable[1]), url: unreadable[2]!, news: [], ended: true, attention: true }
  }
  const update = UPDATE_LINE.exec(firstLine)
  if (!update) return null
  const news: PullRequestWatchNewsKind[] = []
  for (const line of trimmed.split('\n')) {
    const kind = NEWS_LINES.find(([pattern]) => pattern.test(line))?.[1]
    if (kind && !news.includes(kind)) news.push(kind)
  }
  const ended = /Solus stopped watching/.test(trimmed)
  return {
    number: Number(update[1]),
    url: update[2]!,
    news,
    ended,
    attention: news.some((kind) => ATTENTION_NEWS.has(kind)),
  }
}

const NEWS_WORDS = {
  'checks-failed': 'checks failed',
  'checks-passed': 'checks passed',
  remarks: 'new comments',
  conflicting: 'merge conflict',
  closed: 'closed',
} satisfies Record<PullRequestWatchNewsKind, string>

/** The wake in a few words, for the row that folds its text away:
 *  "checks failed, new comments". */
export function pullRequestWatchWakeSummary(wake: PullRequestWatchWake): string {
  const words = wake.news.map((kind) => NEWS_WORDS[kind])
  if (wake.ended) words.push(wake.news.length === 0 ? 'could not be read, stopped watching' : 'stopped watching')
  return words.join(', ')
}
