import { untrack } from 'svelte'
import type { IpcContext } from '@solus/contracts/types'
import type { WorkspaceContext } from '../../../contexts'
import { reviewGuideStore, sessionGuideIdentity, type ReviewGuideIdentity } from '../review-guide.store.svelte'

/**
 * One probe per session guide, owned here rather than by each mounted action
 * orb. A guide is probed once, when its session first has an identity; the
 * answer renders from the store from then on, and generation progress arrives
 * as host events. Whether a guide is still current is checked only when it is
 * opened. Nothing else re-probes: host bindings are read untracked, so a
 * settings flip such as the active agent does not fan out into one request
 * per open tab.
 *
 * Every probe due in one pass goes to its host as one request. A restored
 * workspace makes every tab due at once, and one request per tab was one
 * round trip per tab.
 */
export function trackSessionReviewGuides(workspace: Pick<WorkspaceContext, 'tabOrder' | 'sessionFor' | 'apiFor' | 'serverIdFor' | 'ctxFor'>): void {
  const probedGuides = new Map<string, string>()
  $effect(() => {
    const liveSessionIds = new Set<string>()
    const probesByServer = new Map<string, { tabId: string; ctx: IpcContext; identity: ReviewGuideIdentity }[]>()
    for (const tabId of workspace.tabOrder) {
      const session = workspace.sessionFor(tabId)
      const identity = sessionGuideIdentity(session)
      if (!session || !identity) continue
      liveSessionIds.add(session.id)
      const probeKey = `${identity.repoRoot}::${identity.key}`
      if (probedGuides.get(session.id) === probeKey) continue
      probedGuides.set(session.id, probeKey)
      untrack(() => {
        const serverId = workspace.serverIdFor(tabId)
        let probes = probesByServer.get(serverId)
        if (!probes) {
          probes = []
          probesByServer.set(serverId, probes)
        }
        probes.push({ tabId, ctx: workspace.ctxFor(tabId), identity })
      })
    }
    for (const [serverId, probes] of probesByServer) {
      untrack(() => {
        void reviewGuideStore.loadSessions(workspace.apiFor(probes[0].tabId), serverId, probes)
      })
    }
    for (const sessionId of probedGuides.keys()) {
      if (!liveSessionIds.has(sessionId)) probedGuides.delete(sessionId)
    }
  })
}
