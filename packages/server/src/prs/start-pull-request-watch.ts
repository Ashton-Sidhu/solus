import { ANY_ORGANIZATION } from '../admission/principal'
import { readPullRequestWatches, startPullRequestWatch } from '../data/sessions/pull-request-watches'
import { readSessionPullRequests } from '../data/sessions/session-pull-requests'
import { settledSessionIds } from '../data/sessions/session-states'
import { initialWatchState } from './pr-watch-rules'

/** What starting a watch did (docs/plans/pr-watch.md §4). */
export type WatchStartOutcome = 'started' | 'already-watching' | 'not-linked' | 'session-settled' | 'merged' | 'closed' | 'missing'

/**
 * Watch a pull request the session links, for its agent or for a person.
 * Refused when nothing would act on the news: a settled session, or a pull
 * request that is merged, closed, or gone. A pull request PR sync has not
 * answered for yet is watched; the first read ends the watch if it was not open.
 */
export async function startSessionPullRequestWatch(sessionId: string, repository: string, number: number): Promise<WatchStartOutcome> {
  repository = repository.toLowerCase()
  if ((await settledSessionIds([sessionId])).has(sessionId)) return 'session-settled'
  const watched = await readPullRequestWatches([sessionId])
  if (watched.some((watch) => watch.repository === repository && watch.number === number)) return 'already-watching'
  const link = ((await readSessionPullRequests(ANY_ORGANIZATION, [sessionId]))[sessionId] ?? [])
    .find((candidate) => candidate.repository === repository && candidate.number === number)
  if (!link) return 'not-linked'
  if (link.missing) return 'missing'
  if (link.snapshot?.state === 'merged' || link.snapshot?.state === 'closed') return link.snapshot.state
  await startPullRequestWatch(sessionId, repository, number, initialWatchState(Date.now()))
  return 'started'
}
