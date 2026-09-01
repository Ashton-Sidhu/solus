import type { AttentionState } from '../../lib/sessionUtils'
import { ATTENTION_RANK } from '../../components/session/lib/task-list'

export interface TaskSessionSelectionCandidate {
  attention: AttentionState
  lastActivityAt: number
}

/** Pick the session that matters most for a task. Attention uses the same rank
 * as the task bar; equal states fall back to the newest indexed activity. */
export function taskSessionTarget<T extends TaskSessionSelectionCandidate>(
  sessions: readonly T[],
): T | undefined {
  let best: T | undefined
  let bestRank = -1
  for (const session of sessions) {
    const rank = session.attention ? ATTENTION_RANK[session.attention] : 0
    if (
      rank > bestRank
      || (rank === bestRank && session.lastActivityAt > (best?.lastActivityAt ?? -1))
    ) {
      best = session
      bestRank = rank
    }
  }
  return best
}

/** Pick the nearest still-open sidebar conversation after the selected one is
 * removed. The left neighbour wins a tie, which matches the tab strip's close
 * behavior. Shelved conversations can remain in `sidebarTabIds`, but only ids
 * in `openTabIds` are eligible navigation targets. */
export function closestOpenSidebarTabAfterClose(
  sidebarTabIds: string[],
  openTabIds: string[],
  closingTabIds: string[],
  activeTabId: string,
): string | null {
  const eligible = new Set(openTabIds.filter((tabId) => !closingTabIds.includes(tabId)))
  if (!eligible.size) return null

  const activeIndex = sidebarTabIds.indexOf(activeTabId)
  if (activeIndex === -1) return openTabIds.find((tabId) => eligible.has(tabId)) ?? null

  for (let distance = 1; distance < sidebarTabIds.length; distance++) {
    const left = sidebarTabIds[activeIndex - distance]
    if (left && eligible.has(left)) return left
    const right = sidebarTabIds[activeIndex + distance]
    if (right && eligible.has(right)) return right
  }
  return null
}
