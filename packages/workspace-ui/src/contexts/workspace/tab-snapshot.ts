import type { Session } from '@solus/contracts/types'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { existingTaskId } from './session-draft.svelte'
import { firstActivityAt } from './session-activity'
import type { PersistedTab } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'
import { projectHome, runHost } from './run-location'

/** One tab snapshot builder for desktop and web. Reload state must not diverge
 * because two client entry points copied this mapping independently. */
export function snapshotPersistedTabs(session: WorkspaceContext): PersistedTab[] {
  const knownHosts = hostCatalog.hosts()
  return session.tabOrder
    .filter((tabId) => session.tabs[tabId])
    .map((tabId) => {
      const tab = session.tabs[tabId]
      const restoredSession = session.sessionFor(tabId)
      // A run host that is not current yet has no copy of the conversation.
      const persistedLocation = restoredSession
        ? session.runHosts.persistedLocation(restoredSession)
        : session.defaultRunConfig.location
      return {
        tabId,
        sessionId: tab.sessionId,
        title: restoredSession?.title ?? 'New Tab',
        titleCustom: restoredSession?.titleCustom ?? false,
        serverInstallationId: knownHosts.find(
          (server) => server.id === runHost({ location: persistedLocation }),
        )?.installationId,
        projectInstallationId: knownHosts.find(
          (server) => server.id === projectHome(restoredSession?.run ?? session.defaultRunConfig).serverId,
        )?.installationId,
        agentSessionId: restoredSession?.agentSessionId ?? null,
        pendingFork: restoredSession?.forked ? pendingForkOf(restoredSession) : undefined,
        forkedFromSessionId: restoredSession?.forkedFromSessionId ?? null,
        provider: restoredSession?.run.provider ?? null,
        handoffFrom: restoredSession?.handoffFrom ? { ...restoredSession.handoffFrom } : undefined,
        location: persistedLocation,
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
        lastSentAt: restoredSession?.lastSentAt ?? null,
      }
    })
}

/** What a fork that has no provider thread yet keeps across a reload. */
function pendingForkOf(session: Session): NonNullable<PersistedTab['pendingFork']> {
  const pendingFork: NonNullable<PersistedTab['pendingFork']> = {
    messages: session.messages,
    excludeLatestTurn: session.forkExcludeLatestTurn ?? false,
  }
  if (session.forkSourceSessionId) pendingFork.sourceSessionId = session.forkSourceSessionId
  return pendingFork
}

/** A session with no dated message yet has no start to keep. */
function knownStartedAt(session: Session): number | null {
  const startedAt = firstActivityAt(session)
  return startedAt === Number.MAX_SAFE_INTEGER ? null : startedAt
}
