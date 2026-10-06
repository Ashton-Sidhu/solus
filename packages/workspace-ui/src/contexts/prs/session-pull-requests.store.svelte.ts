import { SvelteMap } from 'svelte/reactivity'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { TaskSidebarPrLink } from '@solus/contracts/task-types'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The pull requests sessions work on (docs/plans/session-pull-requests.md).
 *
 * A session owns its links on its host. This store holds them for the rows
 * that stand for a session. A task's pull requests are not here: the host
 * answers those with the task, from the links of the task's sessions.
 */
export class SessionPullRequestsStore {
  /** Links by stable session id. A session with none has no entry. */
  private linksBySession = new SvelteMap<string, SessionPullRequestLink[]>()
  /** The sessions each host last answered for, so a reload drops what is gone. */
  private sessionIdsByServer = new Map<string, Set<string>>()
  private watchedServerIds = new Set<string>()

  /** Read every connected host's links. A host that fails the read keeps the
   *  links it answered with last time. */
  async load(): Promise<void> {
    await Promise.all(serverConnections.connectedServerIds().map(async (serverId) => {
      this.watchHost(serverId)
      let answer: Awaited<ReturnType<ReturnType<typeof serverConnections.apiFor>['sessionPullRequestsList']>>
      try {
        answer = await serverConnections.apiFor(serverId).sessionPullRequestsList()
      } catch {
        return
      }
      const answered = new Set(Object.keys(answer))
      for (const sessionId of this.sessionIdsByServer.get(serverId) ?? []) {
        if (!answered.has(sessionId)) this.linksBySession.delete(sessionId)
      }
      for (const [sessionId, links] of Object.entries(answer)) this.linksBySession.set(sessionId, links)
      this.sessionIdsByServer.set(serverId, answered)
    }))
  }

  /** Each host announces its own changes, so each is subscribed once. */
  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('session.pullRequestsChanged', ({ sessionId }) => {
      void this.refresh(serverId, sessionId)
    })
  }

  private async refresh(serverId: string, sessionId: string): Promise<void> {
    const answer = await serverConnections.apiFor(serverId).sessionPullRequestsList([sessionId]).catch(() => null)
    if (!answer) return
    const known = this.sessionIdsByServer.get(serverId) ?? new Set<string>()
    this.sessionIdsByServer.set(serverId, known)
    // The host answers under the stable id, which the event may not name.
    const answered = Object.entries(answer)
    if (!answered.length) {
      this.linksBySession.delete(sessionId)
      known.delete(sessionId)
      return
    }
    for (const [sessionId, links] of answered) {
      this.linksBySession.set(sessionId, links)
      known.add(sessionId)
    }
  }

  /** The links of one session. */
  linksFor(sessionId: string | null | undefined): SessionPullRequestLink[] {
    return sessionId ? this.linksBySession.get(sessionId) ?? [] : []
  }

  /** Link a pull request to a session by its URL. */
  async link(serverId: string, sessionId: string, url: string): Promise<void> {
    await serverConnections.apiFor(serverId).sessionPullRequestLink(sessionId, url)
    await this.refresh(serverId, sessionId)
  }

  /** Remove a pull request from a session. PR sync does not link it again. */
  async unlink(serverId: string, link: Pick<SessionPullRequestLink, 'sessionId' | 'repository' | 'number'>): Promise<void> {
    await serverConnections.apiFor(serverId).sessionPullRequestUnlink(link.sessionId, link.repository, link.number)
    await this.refresh(serverId, link.sessionId)
  }
}

export const sessionPullRequestsStore = new SessionPullRequestsStore()

/** A session's link in the shape the linked pull request reads take. */
export function sessionPrLink(link: SessionPullRequestLink): TaskSidebarPrLink {
  const prLink: TaskSidebarPrLink = {
    number: link.number,
    url: link.url,
    title: link.title || `#${link.number}`,
    targetScope: link.repository,
    ownerSessionId: link.sessionId,
  }
  if (link.snapshot) prLink.snapshot = link.snapshot
  if (link.missing) prLink.missing = true
  if (link.createdBy) prLink.createdBy = link.createdBy
  return prLink
}
