import { loadServers, LOCAL_SERVER_ID } from '../../../client-core/server-registry'
import { taskTargetFields } from './session-draft.svelte'
import type { PersistedTab } from './tab-persistence'
import type { WorkspaceContext } from './workspace.context.svelte'

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
        serverId: restoredSession?.run.serverId ?? LOCAL_SERVER_ID,
        serverInstallationId: savedServers.find(
          (server) => server.id === restoredSession?.run.serverId,
        )?.installationId,
        agentSessionId: restoredSession?.agentSessionId ?? null,
        provider: restoredSession?.run.provider ?? null,
        handoffFrom: restoredSession?.handoffFrom ? { ...restoredSession.handoffFrom } : undefined,
        workingDirectory:
          restoredSession?.run.workingDirectory ?? session.globalDefaults.workingDirectory,
        projectGroupPath: restoredSession?.run.projectGroupPath ?? null,
        additionalDirs: restoredSession ? [...restoredSession.additionalDirs] : [],
        gitContext: restoredSession?.run.gitContext ? { ...restoredSession.run.gitContext } : null,
        worktreeBaseBranch: restoredSession?.run.worktree?.baseBranch ?? null,
        worktreeRequested: !!restoredSession?.run.worktree,
        taskServerId: restoredSession?.run.taskServerId ?? LOCAL_SERVER_ID,
        modelConfig: restoredSession
          ? { ...restoredSession.run.modelConfig }
          : { ...session.globalDefaults.modelConfig },
        permissionMode:
          restoredSession?.run.permissionMode ?? session.globalDefaults.permissionMode,
        hasUnread: tab.hasUnread ?? false,
        pendingTaskId: restoredSession ? taskTargetFields(restoredSession.task).pendingTaskId : null,
        pendingParentTaskId: restoredSession ? taskTargetFields(restoredSession.task).pendingParentTaskId : null,
        taskCreationDisabled: restoredSession ? taskTargetFields(restoredSession.task).taskCreationDisabled : false,
        terminalFailure: restoredSession?.terminalFailure
          ? { ...restoredSession.terminalFailure }
          : null,
        contextUsage: restoredSession?.contextUsage ? { ...restoredSession.contextUsage } : null,
        // A rate limit belongs to the live server's RateLimitState. Do not
        // restore it after that server has restarted and lost the state.
        status: restoredSession?.status === 'rate_limited'
          ? 'idle'
          : restoredSession?.status ?? 'idle',
        currentTurnStartedAt: restoredSession?.currentTurnStartedAt ?? null,
      }
    })
}
