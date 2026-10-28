import type { WorkspaceContext } from '../../../../contexts/workspace/workspace.context.svelte'
import { sessionArtifactsStore } from '../../../../contexts/sessions/session-artifacts.store.svelte'
import { shouldOpenArtifacts } from './auto-open'

type AutoOpenShell = Pick<WorkspaceContext, 'router' | 'activeTabId' | 'sessionFor' | 'serverIdForSession' | 'openArtifacts'>

/** The session of the conversation in the leading pane, or null when a page or a draft leads. */
function onScreenSessionId(shell: AutoOpenShell): string | null {
  const destination = shell.router.destination
  if (destination.name !== 'chat') return null
  return destination.params.sessionId ?? shell.sessionFor(shell.activeTabId)?.id ?? null
}

/**
 * Open the Artifacts surface when the conversation on screen links something
 * new. The store reads that conversation's artifacts once, so it has a count to
 * compare, and every later read that finds more opens the surface beside it.
 * The open does not take the keyboard from the pane the user is in.
 * Call once from the component that hosts the workspace.
 */
export function useArtifactsAutoOpen(shell: AutoOpenShell): void {
  $effect(() => {
    const sessionId = onScreenSessionId(shell)
    if (sessionId) sessionArtifactsStore.ensure(shell.serverIdForSession(sessionId), sessionId)
  })

  $effect(() =>
    sessionArtifactsStore.onChange((change) => {
      if (!shouldOpenArtifacts(change.previousCount, change.count)) return
      if (onScreenSessionId(shell) !== change.sessionId) return
      const focusedPaneId = shell.router.focusedPaneId
      shell.openArtifacts(change.sessionId)
      shell.router.focusPane(focusedPaneId)
    }),
  )
}
