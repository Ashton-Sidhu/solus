import type { PrSyncChange } from '@solus/contracts/providers'
import { SESSION_LIST_IDLE_MS } from '@solus/contracts/session-state'
import { liveSessionBranches } from '../data/sessions/session-records'
import { PrSync } from './pr-sync'

/**
 * PR sync at an organization's Solus API (docs/plans/session-archive.md): the
 * home of every organization session keeps its pull requests fresh, because the
 * machines that run sessions rotate and go offline. It reads the branches the
 * session records name, and each repository as a person whose live session
 * works in it, with that person's own GitHub connection.
 */
export function organizationPrSync(publish: (change: PrSyncChange) => void): PrSync {
  let running = new Set<string>()
  let ownersByRepository = new Map<string, string>()
  return new PrSync({
    publish,
    isSessionBusy: (sessionId) => running.has(sessionId),
    liveCheckouts: async (now) => {
      const live = await liveSessionBranches(now - SESSION_LIST_IDLE_MS)
      running = new Set(live.filter((session) => session.isRunning).map((session) => session.sessionId))
      ownersByRepository = new Map(live.flatMap((session) => session.ownerUserId ? [[session.repositoryKey.toLowerCase(), session.ownerUserId] as const] : []))
      return live.map((session) => ({ projectScope: session.repositoryKey, branch: session.branch, sessionId: session.sessionId }))
    },
    repositoryReader: (repositoryKey) => ownersByRepository.get(repositoryKey) ?? null,
    // Runners report sessions here, and no turn end is heard: interest is read on a clock.
    pollsForInterest: true,
  })
}
