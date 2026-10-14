import type { Session } from '@solus/contracts/types'
import { loadServers } from '@solus/client-core/server-registry'
import { existingTaskId } from './session-draft.svelte'
import { firstActivityAt } from './session-activity'
import type { PersistedTab } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'
import { projectHome, runHost } from './run-location'

/** One tab snapshot builder for desktop and web. Reload state must not diverge
 * because two client entry points copied this mapping independently. */
export function snapshotPersistedTabs(session: WorkspaceContext): PersistedTab[] {
  const savedServers = loadServers()
  return session.tabOrder
    .filter((tabId) => session.tabs[tabId])
    .map((tabId) => {
      const tab = session.tabs[tabId]
      const restoredSession = session.sessionFor(tabId)
      return {
        tabId,
        sessionId: tab.sessionId,
        title: restoredSession?.title ?? 'New Tab',
        titleCustom: restoredSession?.titleCustom ?? false,
        serverInstallationId: savedServers.find(
          (server) => server.id === runHost(restoredSession?.run ?? session.defaultRunConfig),
        )?.installationId,
        projectInstallationId: savedServers.find(
          (server) => server.id === projectHome(restoredSession?.run ?? session.defaultRunConfig).serverId,
        )?.installationId,
        agentSessionId: restoredSession?.agentSessionId ?? null,
        pendingFork: restoredSession?.forked ? {
          messages: restoredSession.messages,
          excludeLatestTurn: restoredSession.forkExcludeLatestTurn ?? false,
        } : undefined,
        forkedFromSessionId: restoredSession?.forkedFromSessionId ?? null,
        provider: restoredSession?.run.provider ?? null,
        handoffFrom: restoredSession?.handoffFrom ? { ...restoredSession.handoffFrom } : undefined,
        location: (restoredSession?.run ?? session.defaultRunConfig).location,
        additionalDirs: restoredSession ? [...restoredSession.additionalDirs] : [],
        modelConfig: restoredSession
          ? { ...restoredSession.run.modelConfig }
          : { ...session.config.globalDefaults.modelConfig },
        permissionMode:
          restoredSession?.run.permissionMode ?? session.config.globalDefaults.permissionMode,
        hasUnread: tab.hasUnread ?? false,
        pendingTaskId: restoredSession ? existingTaskId(restoredSession.task) : null,
        terminalFailure: restoredSession?.terminalFailure
          ? { ...restoredSession.terminalFailure }
          : null,
        contextUsage: restoredSession?.contextUsage ? { ...restoredSession.contextUsage } : null,
        organizationId: restoredSession?.organizationId ?? null,
        // A rate limit belongs to the live server's RateLimitState. Do not
        // restore it after that server has restarted and lost the state.
        status: restoredSession?.status === 'rate_limited'
          ? 'idle'
          : restoredSession?.status ?? 'idle',
        currentTurnStartedAt: restoredSession?.currentTurnStartedAt ?? null,
        startedAt: restoredSession ? knownStartedAt(restoredSession) : null,
      }
    })
}

/** A session with no dated message yet has no start to keep. */
function knownStartedAt(session: Session): number | null {
  const startedAt = firstActivityAt(session)
  return startedAt === Number.MAX_SAFE_INTEGER ? null : startedAt
}
