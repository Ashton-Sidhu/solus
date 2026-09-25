import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import { serversStore } from '../../../contexts/connections/servers.store.svelte'
import type { SessionEnvironmentStore } from '../../../contexts/git/session-environment.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { withCheckoutOnHost } from '../../servers/run-on'

type SelectionWorkspace = Pick<WorkspaceContext, 'runFor' | 'defaultRunConfig' | 'sessionFor' | 'drafts' | 'config'>

/**
 * Open a project — or Scratchpad — in one checkout, for the tab or draft that
 * `sourceId` names. A checkout on the run's own host is a folder change; one on
 * another host moves the run there too. Resolves once the run names the checkout; the caller returns focus.
 */
export async function aimRunAtCheckout(
  workspace: SelectionWorkspace,
  environment: Pick<SessionEnvironmentStore, 'refresh'>,
  sourceId: string,
  checkout: ProjectRef,
): Promise<void> {
  const current = workspace.runFor(sourceId) ?? workspace.defaultRunConfig
  if (checkout.serverId === current.serverId && !current.pendingHostDispatch) {
    await workspace.config.setBaseDirectory(checkout.projectRoot, sourceId)
    return
  }
  const next = withCheckoutOnHost(current, checkout.serverId, checkout.projectRoot, {
    immediate: serversStore.hostFor(checkout.serverId)?.local ?? false,
    isolate: serversStore.isolatesSessions(checkout.serverId),
  })
  // Inert until Send: nothing connects or moves, so changing your mind is free.
  const owner = workspace.sessionFor(sourceId) ?? workspace.drafts.sessionDrafts.get(sourceId)
  if (owner) owner.run = next
  const settled = workspace.runFor(sourceId) ?? workspace.defaultRunConfig
  const cwd = settled.gitContext?.worktreePath ?? settled.workingDirectory
  if (cwd) void environment.refresh(settled.serverId, cwd, { force: true })
}
