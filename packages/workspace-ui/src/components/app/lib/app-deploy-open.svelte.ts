import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { afterPaint } from '../../../lib/after-paint'
import { onScreenSessionId } from '../../session/artifacts/lib/artifacts-auto-open.svelte'
import { opensBesideConversation } from './app-deploy'

type DeployOpenShell = Pick<WorkspaceContext, 'router' | 'activeTabId' | 'sessionFor' | 'serverIdForSession' | 'openApp'>

/**
 * Open an app beside the conversation that deployed it (docs/plans/apps.md
 * §9): when an agent's deploy makes or changes an app and that session's
 * conversation leads, the app's surface joins the strip and shows. A load or a
 * reload of the list opens nothing. The open does not take the keyboard from
 * the pane the user is in. Call once from the component that hosts the workspace.
 *
 * The apps store loads after the first paint, not with the workspace. It then
 * watches every host for the life of the workspace, so the palette, a chip,
 * and the strip find an app's name and slug without a read of their own.
 */
export function useAppDeployOpen(shell: DeployOpenShell): void {
  $effect(() => {
    let stop: (() => void) | null = null
    let isDestroyed = false
    void afterPaint().then(() => import('../../../contexts/apps/apps.store.svelte')).then(({ appsStore }) => {
      if (isDestroyed) return
      const stopWatching = appsStore.watch()
      const stopDeploys = appsStore.onDeployed((deploy) => {
        const sessionId = onScreenSessionId(shell)
        const leading = sessionId ? { sessionId, serverId: shell.serverIdForSession(sessionId) } : null
        if (!opensBesideConversation(deploy, leading)) return
        const focusedPaneId = shell.router.focusedPaneId
        shell.openApp(deploy.serverId, deploy.app.slug)
        shell.router.focusPane(focusedPaneId)
      })
      stop = () => {
        stopWatching()
        stopDeploys()
      }
    })
    return () => {
      isDestroyed = true
      stop?.()
    }
  })
}
