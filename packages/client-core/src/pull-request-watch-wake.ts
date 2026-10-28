// The news a pull request watch woke the agent with, read back from the wake's
// own text (docs/plans/pr-watch.md §12). The host writes the wake as one prompt
// (`prs/pr-watch-rules.ts` `wakeText`), and a history row keeps no origin, so
// the text is what every client has — live and after a reload alike. The
// first line is the watch's signature; `tests/unit/pull-request-watch-wake.test.ts`
// runs the host's template through this reader so the two cannot drift.

export type PullRequestWatchNewsKind =
  | 'checks-failed'
  | 'checks-passed'
  | 'all-checks-passed'
  | 'no-checks'
  | 'remarks'
  | 'conflicting'
  | 'closed'

export interface PullRequestWatchNews {
  kind: PullRequestWatchNewsKind
  /** The checks or remarks the news names, or the minutes the head waited for
   *  a check; null for news that names no count. */
  count: number | null
}

export interface PullRequestWatchWake {
  number: number
  url: string
  /** Each kind of news once, in the order the wake lists it. */
  news: PullRequestWatchNews[]
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
  [/^- Every check that gates the merge passed: /, 'checks-passed'],
  [/^- Every other check has now finished and passed too: /, 'all-checks-passed'],
  [/^- No checks have reported on this head after (\d+) minutes/, 'no-checks'],
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
  const news: PullRequestWatchNews[] = []
  // The failed checks and the remarks are listed one per indented line below
  // their heading, with "and N more" past the host's limit.
  let listing: PullRequestWatchNews | null = null
  for (const line of trimmed.split('\n')) {
    const heading = NEWS_LINES.find(([pattern]) => pattern.test(line))
    if (heading) {
      const [pattern, kind] = heading
      const item = news.find((known) => known.kind === kind) ?? { kind, count: headingCount(kind, line, pattern) }
      if (!news.includes(item)) news.push(item)
      listing = kind === 'checks-failed' || kind === 'remarks' ? item : null
      continue
    }
    if (listing?.count != null && line.startsWith('  - ')) {
      const more = /^ {2}- and (\d+) more$/.exec(line)
      listing.count += more ? Number(more[1]) : 1
      continue
    }
    listing = null
  }
  const ended = /Solus stopped watching/.test(trimmed)
  return {
    number: Number(update[1]),
    url: update[2]!,
    news,
    ended,
    attention: news.some((item) => ATTENTION_NEWS.has(item.kind)),
  }
}

function headingCount(kind: PullRequestWatchNewsKind, line: string, pattern: RegExp): number | null {
  switch (kind) {
    case 'checks-failed':
    case 'remarks':
      return 0
    case 'no-checks':
      return Number(pattern.exec(line)![1])
    case 'checks-passed':
    case 'all-checks-passed':
      return namedCount(line.slice(line.indexOf(': ') + 2).replace(/\.$/, ''))
    default:
      return null
  }
}

/** The names in "build, test (ubuntu, 20), and 3 more": a comma inside a
 *  matrix job's parentheses does not part two names. */
function namedCount(list: string): number {
  const more = /, and (\d+) more$/.exec(list)
  const names = more ? list.slice(0, more.index) : list
  let count = names.trim() ? 1 : 0
  let depth = 0
  for (let index = 0; index < names.length; index++) {
    const char = names[index]
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ',' && depth === 0 && names[index + 1] === ' ') count++
  }
  return count + (more ? Number(more[1]) : 0)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function newsWords(item: PullRequestWatchNews): string {
  const count = item.count || null
  switch (item.kind) {
    case 'checks-failed':
      return count ? `${plural(count, 'check', 'checks')} failed` : 'checks failed'
    case 'checks-passed':
      return count ? `${plural(count, 'required check', 'required checks')} passed` : 'required checks passed'
    case 'all-checks-passed':
      return count ? `${plural(count, 'other check', 'other checks')} passed` : 'other checks passed'
    case 'no-checks':
      return `no checks after ${plural(item.count ?? 0, 'minute', 'minutes')}`
    case 'remarks':
      return count ? plural(count, 'new comment', 'new comments') : 'new comments'
    case 'conflicting':
      return 'merge conflict'
    case 'closed':
      return 'closed'
  }
}

function endWords(wake: PullRequestWatchWake): string {
  return wake.news.length === 0 ? 'could not be read, stopped watching' : 'stopped watching'
}

/** The wake in a few words, for the row's tooltip and a screen reader:
 *  "2 checks failed, 1 new comment". */
export function pullRequestWatchWakeSummary(wake: PullRequestWatchWake): string {
  const words = wake.news.map(newsWords)
  if (wake.ended) words.push(endWords(wake))
  return words.join(', ')
}

export type PullRequestWatchMarkTone = 'failing' | 'passing' | 'pending' | 'review' | 'quiet'

/** One piece of news as an icon and a short figure, for the folded row. Each
 *  client picks the icon by `kind` and the colour by `tone`. */
export interface PullRequestWatchMark {
  kind: PullRequestWatchNewsKind | 'stopped'
  /** Shown beside the icon: a count, "12m", or empty. */
  figure: string
  tone: PullRequestWatchMarkTone
}

const MARK_TONE = {
  'checks-failed': 'failing',
  'checks-passed': 'passing',
  'all-checks-passed': 'passing',
  'no-checks': 'pending',
  remarks: 'review',
  conflicting: 'failing',
  closed: 'failing',
} satisfies { [Kind in PullRequestWatchNewsKind]: PullRequestWatchMarkTone }

/** The wake as marks: ✕ 2 · 💬 3 · stopped, in the order the wake lists it. */
export function pullRequestWatchWakeMarks(wake: PullRequestWatchWake): PullRequestWatchMark[] {
  const marks: PullRequestWatchMark[] = wake.news.map((item) => ({
    kind: item.kind,
    figure: item.kind === 'no-checks' ? `${item.count ?? 0}m` : item.count ? String(item.count) : '',
    tone: MARK_TONE[item.kind],
  }))
  if (wake.ended) marks.push({ kind: 'stopped', figure: '', tone: 'quiet' })
  return marks
}
