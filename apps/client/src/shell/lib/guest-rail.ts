import type { TaskSessionLink } from '@solus/contracts/task-types'
import type { ShareResource, ShareRole } from '@solus/contracts/sharing'
import { relativeTime } from '@solus/workspace-ui/lib/relative-time'

/**
 * The rows of the guest rail (docs/plans/multiplayer-sharing.md §4.2): what the
 * guest was let in to see, in words, and the sessions under a shared task. Every
 * fact here is one the host already sent the guest; the rail names nothing it
 * would have to ask for.
 */

export interface GuestRailSessionRow {
  sessionId: string
  title: string
  /** "claude · 2h ago", or just the time when the session is not indexed yet. */
  meta: string
  isOpen: boolean
}

export function guestSessionRows(
  links: readonly TaskSessionLink[],
  openSessionId: string | null,
  liveTitles: (sessionId: string) => string | null,
): GuestRailSessionRow[] {
  // Newest first, as the task page orders its attempts.
  return [...links]
    .sort((a, b) => (b.startedAt ?? b.linkedAt) - (a.startedAt ?? a.linkedAt))
    .map((link) => {
      const at = link.lastActivityAt ?? link.startedAt ?? link.linkedAt
      const when = relativeTime(at)
      return {
        sessionId: link.sessionId,
        title: liveTitles(link.sessionId) ?? link.sessionTitle ?? 'Session',
        meta: link.provider ? `${link.provider} · ${when}` : when,
        isOpen: link.sessionId === openSessionId,
      }
    })
}

/** The one line that says what the guest may do here. */
export function guestAccessLine(kind: ShareResource['kind'], role: ShareRole): string {
  const thing = kind === 'work' ? 'this document' : kind === 'task' ? 'this task and its sessions' : 'this session'
  return role === 'editor' ? `You can read and edit ${thing}.` : `You can read ${thing}.`
}
