import { SvelteMap } from 'svelte/reactivity'
import type { SessionPullRequestLink, SessionPullRequestWatchOutcome } from '@solus/contracts/session-pull-requests'
import type { TaskSidebarPrLink } from '@solus/contracts/task-types'
import type { SessionRecord } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * The pull requests sessions work on (docs/plans/session-pull-requests.md).
 *
 * A session's home keeps its links (docs/plans/session-archive.md): the
 * organization's Solus API for an organization session, else its machine. The
 * session list carries each session's links; a change is read again from the
 * home that announced it. A task's pull requests are not here: the home
 * answers those with the task, from the links of the task's sessions.
 */
export class SessionPullRequestsStore {
  /** Links by stable session id. A session with none has no entry. */
  private linksBySession = new SvelteMap<string, SessionPullRequestLink[]>()
  /** The home each listed session's links came from. */
  private homeBySession = new Map<string, string>()
  private watchedServerIds = new Set<string>()

  /** Take the links a home's session list carries. A listed session of this
   *  home that has none now has none here. */
  adopt(homeServerId: string, records: readonly Pick<SessionRecord, 'sessionId' | 'pullRequests'>[]): void {
    this.watchHost(homeServerId)
    const answered = new Set(records.map((record) => record.sessionId))
    for (const [sessionId, home] of this.homeBySession) {
      if (home !== homeServerId || answered.has(sessionId)) continue
      this.homeBySession.delete(sessionId)
      this.linksBySession.delete(sessionId)
    }
    for (const record of records) {
      this.homeBySession.set(record.sessionId, homeServerId)
      this.write(record.sessionId, record.pullRequests ?? [])
    }
  }

  /** Each home announces its own changes, so each is subscribed once. */
  private watchHost(serverId: string): void {
    if (this.watchedServerIds.has(serverId)) return
    this.watchedServerIds.add(serverId)
    serverConnections.eventsFor(serverId).subscribe('session.pullRequestsChanged', ({ sessionId }) => {
      const home = this.homeBySession.get(sessionId)
      if (!home || home === serverId) void this.refresh(serverId, sessionId)
    })
  }

  /** The home of a session's links: the one its list named, else the machine the caller acts through. */
  private homeFor(serverId: string, sessionId: string): string {
    return this.homeBySession.get(sessionId) ?? serverId
  }

  private async refresh(serverId: string, sessionId: string): Promise<void> {
    const home = this.homeFor(serverId, sessionId)
    const api = serverConnections.apiFor(home)
    const links = await api.sessionPullRequests(sessionId).catch(() => null)
    if (!links || serverConnections.apiFor(home) !== api) return
    this.write(sessionId, links)
  }

  private write(sessionId: string, links: SessionPullRequestLink[]): void {
    if (links.length) this.linksBySession.set(sessionId, links)
    else this.linksBySession.delete(sessionId)
  }

  /** The links of one session. */
  linksFor(sessionId: string | null | undefined): SessionPullRequestLink[] {
    return sessionId ? this.linksBySession.get(sessionId) ?? [] : []
  }

  /** Link a pull request to a session by its URL, at the session's home. */
  async link(serverId: string, sessionId: string, url: string): Promise<void> {
    const home = this.homeFor(serverId, sessionId)
    this.watchHost(home)
    await serverConnections.apiFor(home).sessionPullRequestPut(sessionId, url)
    await this.refresh(home, sessionId)
  }

  /** Watch a session's pull request, or stop: the session's agent wakes on
   *  its news (docs/plans/pr-watch.md). Watching is the machine's: it is
   *  where the agent runs. Answers what the machine did. */
  async setWatching(
    serverId: string,
    link: Pick<SessionPullRequestLink, 'sessionId' | 'repository' | 'number'>,
    watching: boolean,
  ): Promise<SessionPullRequestWatchOutcome> {
    const outcome = await serverConnections.apiFor(serverId).sessionPullRequestWatch(link.sessionId, link.repository, link.number, watching)
    await this.refresh(serverId, link.sessionId)
    return outcome
  }

  /** Remove a pull request from a session, at its home. PR sync does not link it again. */
  async unlink(serverId: string, link: Pick<SessionPullRequestLink, 'sessionId' | 'repository' | 'number'>): Promise<void> {
    const home = this.homeFor(serverId, link.sessionId)
    this.watchHost(home)
    await serverConnections.apiFor(home).sessionPullRequestDelete(link.sessionId, link)
    await this.refresh(home, link.sessionId)
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
