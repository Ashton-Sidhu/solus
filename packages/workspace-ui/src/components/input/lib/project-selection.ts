import type { Place } from '@solus/contracts/types'
import { hostPathKey } from '@solus/contracts/host-path'
import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import type { SessionEnvironmentStore } from '../../../contexts/git/session-environment.store.svelte'
import type { WorkspaceContext } from '../../../contexts/workspace/workspace.context.svelte'
import { checkoutPlace, chooseCodebase, openFolder, pendingClone, refuseCodebase, runHost, workingPlace } from '../../../contexts/workspace/run-location'

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

/**
 * A codebase that the person chose for a run: its id and the root to open
 * when the folder changes too. A null id is "No codebase", unless `isNew`
 * says that the person chose the codebase that the host makes at the first
 * prompt (docs/plans/codebases.md decision 13).
 */
export interface CodebaseSelection {
  codebaseId: string | null
  root?: Place
  isNew?: true
}

/**
 * Start the run of `sourceId` with a codebase, with none, or with the new
 * codebase that the host makes. With a root, the
 * run opens that folder first, as a project choice does: a root on another
 * host moves the run there. The choice is the person's, so `decisions` keeps
 * it: the automatic choice does not replace "No codebase" for the same folder.
 */
export async function aimRunAtCodebase(
  workspace: SelectionWorkspace,
  environment: Pick<SessionEnvironmentStore, 'refresh'>,
  sourceId: string,
  selection: CodebaseSelection,
  decisions: CodebaseDecisions = codebaseDecisions,
): Promise<void> {
  if (selection.root) {
    await aimRunAtCheckout(workspace, environment, sourceId, { serverId: selection.root.serverId, projectRoot: selection.root.path })
  }
  const run = workspace.runFor(sourceId)
  if (!run) return
  decisions.note(sourceId, checkoutPlace(run))
  workspace.moveRun(sourceId, selection.codebaseId
    ? chooseCodebase(run.location, selection.codebaseId)
    // "No codebase" also tells the host to make none and to take none for this session.
    : refuseCodebase(run.location, !selection.isNew))
}

/**
 * For each tab or draft, the folder that its codebase was decided for. A run
 * gets the one codebase of its folder with no step by the person, one time
 * for each folder: a later look at the same folder must not put back a
 * codebase that the person took away.
 */
export class CodebaseDecisions {
  private readonly decidedFor = new Map<string, string>()

  isDecided(sourceId: string, folder: Place): boolean {
    return this.decidedFor.get(sourceId) === placeKey(folder)
  }

  note(sourceId: string, folder: Place): void {
    this.decidedFor.set(sourceId, placeKey(folder))
  }
}

function placeKey(place: Place): string {
  return `${place.serverId}\n${hostPathKey(place.path)}`
}

export const codebaseDecisions = new CodebaseDecisions()
