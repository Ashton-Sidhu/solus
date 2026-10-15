import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import type { SessionEnvironmentStore } from '../../../contexts/git/session-environment.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { openFolder, pendingClone, runHost, workingPlace } from '../../../contexts/workspace/run-location'

type SelectionWorkspace = Pick<WorkspaceContext, 'runFor' | 'defaultRunConfig' | 'moveRun' | 'config'>

/**
 * Open a project — or a new chat — in one checkout, for the tab or draft that
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
  if (checkout.serverId === runHost(current) && !pendingClone(current)) {
    await workspace.config.setBaseDirectory(checkout.projectRoot, sourceId)
    return
  }
  // The run moves to the folder's host at once: a path is read on the host that
  // holds it. Send connects first if that host is not online yet.
  workspace.moveRun(sourceId, openFolder(current.location, { serverId: checkout.serverId, path: checkout.projectRoot }))
  const place = workingPlace(workspace.runFor(sourceId) ?? workspace.defaultRunConfig)
  if (place.path) void environment.refresh(place.serverId, place.path, { force: true })
}
