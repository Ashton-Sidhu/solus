import type { HostSessionSearchHit, SessionSearchHome } from '@solus/client-core/session-search'
import { usesWindowFilter, visibleInWindow } from '@solus/client-core/organization-filter'
import { worktreeProjectRoot } from '@solus/contracts/types'
import { SearchQuery } from '@solus/contracts/search-query'
import { sessionNameScore } from '@solus/contracts/session-search'
import type { SolusThreadShell, SolusProjectShell } from '../threads/thread-directory'
import { isChatSession, threadProjectKey } from '../threads/threadListV2'

export interface NativeSearchScope {
  hostId: string | null
  projectKeys: ReadonlySet<string> | null
}

/** A project includes all its checkouts, including two clones on one host. */
export function nativeSearchHomes(hostIds: readonly string[], projects: readonly SolusProjectShell[], scope: NativeSearchScope): SessionSearchHome[] {
  return hostIds.filter(hostId => !scope.hostId || hostId === scope.hostId).flatMap(serverId => {
    if (!scope.projectKeys) return [{ serverId }]
    const roots = new Set(projects.filter(project => project.hostId === serverId && scope.projectKeys?.has(project.key)).map(project => worktreeProjectRoot(project.project.path)))
    const homes: SessionSearchHome[] = [...roots].map(projectRoot => ({ serverId, scope: { projectRoot } }))
    // A chat belongs to no project, so a project scope searches the chats as well.
    homes.push({ serverId, scope: { chats: true } })
    return homes
  })
}

/** Loaded names appear at once. Message results keep their arrival order. */
export function nativeSearchHits(input: NativeSearchScope & {
  query: string
  threads: readonly SolusThreadShell[]
  remote: readonly HostSessionSearchHit[]
  organizationId: string | null
  /** The hosts provisioned for an organization: only their results, and the Solus API's, go through the organization filter. */
  managedHostIds?: ReadonlySet<string>
}): HostSessionSearchHit[] {
  const managed = input.managedHostIds ?? new Set<string>()
  const search = new SearchQuery(input.query)
  const named: HostSessionSearchHit[] = input.threads.flatMap(thread => {
    if (input.hostId && thread.hostId !== input.hostId) return []
    if (input.projectKeys && !isChatSession(thread.record) && !input.projectKeys.has(threadProjectKey(thread, input.projectKeys))) return []
    if (!visibleInWindow(thread.record.organizationId, input.organizationId, usesWindowFilter(thread.hostId, managed))) return []
    const match = sessionNameScore({ id: thread.record.sessionId, title: thread.record.customTitle, branch: thread.record.branch, pullRequest: thread.record.pullRequests?.map(pr => `#${pr.number} ${pr.title}`).join(' ') }, search)
    return match ? [{ serverId: thread.hostId, result: { record: thread.record, snippet: '', ts: thread.record.lastActivityAt, messageId: -1, rank: -match.score, reason: match.reason, additionalMatches: [] } }] : []
  }).sort((a, b) => a.result.rank - b.result.rank || b.result.ts - a.result.ts)
  const seen = new Set<string>()
  return [...named, ...input.remote].filter(hit => {
    const key = `${hit.serverId}\0${hit.result.record.sessionId}`
    if (seen.has(key) || !visibleInWindow(hit.result.record.organizationId, input.organizationId, usesWindowFilter(hit.serverId, managed))) return false
    seen.add(key)
    return true
  })
}
