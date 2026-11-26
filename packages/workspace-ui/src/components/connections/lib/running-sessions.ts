import { hostPathBaseName } from '@solus/contracts/host-path'
import { isSessionBusyStatus, modelLabelFor, REASONING_EFFORT_LABELS } from '@solus/contracts/types'
import { codebasesStore, presenceStore } from '../../../contexts'
import { runGroupKey, type SessionSidebarStore } from '../../../contexts/workspace/session-sidebar.store.svelte'
import { existingTaskId } from '../../../contexts/workspace/session-draft.svelte'
import { turnStartedAt } from '../../../contexts/workspace/session-activity'
import { codebaseOf, projectRoot, runHost } from '../../../contexts/workspace/run-location'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { worktreeDisplayName } from '../../../lib/git-context'
import { attentionLabel, sessionTitle } from '../../../lib/sessionUtils'
import { prChipForChoices } from '../../session/lib/sidebar-rows'
import { activeTurnAuthorOf } from '../../presence/lib/presence-people'

/**
 * The sessions with a turn open on one host, each with the facts its sidebar
 * row states: the same state mark, the model and its effort, the branch and
 * whether it is a worktree, the codebase and the project, the task and pull
 * request, when the turn started, and who is in it.
 */
export function runningSessionRows(workspace: WorkspaceContext, sidebarStore: SessionSidebarStore, hostId: string) {
  return Object.values(workspace.sessions.byId)
    .filter((session) => runHost(session.run) === hostId && isSessionBusyStatus(session.status))
    .map((session) => {
      const attention = sidebarStore.sessionAttention(hostId, session.id)
      const live = sidebarStore.liveFactsOf({ sessionId: session.id, serverId: hostId }, attention)
      const environment = workspace.environment.environmentFor(session.run)
      const project = projectRoot(session.run)
      const codebaseId = codebaseOf(session.run)
      const provider = session.run.provider
      const taskId = existingTaskId(session.task)
      const tabId = workspace.tabIdForHostSession(session.id, hostId) ?? null
      const pullRequest = prChipForChoices(sidebarStore.prChoicesForSession(hostId, session.id, tabId))
      const people = presenceStore.peopleFocusedOn(hostId, { kind: 'session', sessionId: session.id })
      return {
        id: session.id,
        title: sessionTitle(session),
        attention,
        live,
        state: attentionLabel(attention, null, live),
        providerMark: provider === 'claude-code' ? 'claude' as const : provider === 'codex' ? 'codex' as const : null,
        model: modelLabelFor(provider, session.sessionModel ?? session.run.modelConfig.modelId),
        effort: REASONING_EFFORT_LABELS[session.run.modelConfig.reasoningEffort],
        branch: environment.branch ? worktreeDisplayName(environment.branch) : null,
        isWorktree: !!environment.worktreePath,
        project: project ? hostPathBaseName(project) : null,
        groupKey: project ? runGroupKey(session.run, project) : null,
        codebaseId,
        codebase: codebaseId ? codebasesStore.codebaseOf(codebaseId)?.name ?? null : null,
        task: taskId ? workspace.issuesStore.get(taskId).title || null : null,
        pullRequest,
        runStartedAt: workspace.sessions.executionFor(hostId, session.id)?.current?.startedAt ?? turnStartedAt(session),
        people,
        activeUserId: activeTurnAuthorOf(people),
      }
    })
}

export type RunningSessionRow = ReturnType<typeof runningSessionRows>[number]
