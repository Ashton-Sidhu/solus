import type { RunConfig } from '@solus/contracts/types'
import type { ProjectLocation } from '../app/settings.context.svelte'
import { withCheckout } from './run-config'

/** What the pass reads and writes on the workspace. */
export interface MachineReferenceOwner {
  settings: { lastProject: ProjectLocation | null; update(patch: { lastProject: null }): void }
  unstartedRuns(): RunConfig[]
  /** Where a new session starts once the remembered project is cleared. */
  readonly defaultRunConfig: RunConfig
}

/**
 * The one owner of what happens to references to a machine that is gone
 * (docs/plans/workspace-and-machines.md §6): a host was deleted, or it was never
 * listed at this origin. Readers do not each handle a ghost.
 *
 * - The remembered project is cleared.
 * - A run nothing has happened in yet — an unstarted tab or a draft — moves to
 *   where a new session starts, as a fresh one would. Its folder named a path on
 *   the gone machine, so it takes the new run's folder too. With no machine to
 *   move to, it stays: there is nothing better to point it at.
 * - A started session keeps its machine: its conversation lives there.
 * - A draft opened from a task keeps the task's home unless that is gone too.
 *
 * Call it only once the saved hosts are authoritative — after a directory read
 * succeeded, or when there is no directory — so a failed read never throws
 * anything away.
 */
export function reconcileMachineReferences(
  owner: MachineReferenceOwner,
  isKnown: (serverId: string) => boolean,
  hasMachine: () => boolean,
): void {
  const lastProject = owner.settings.lastProject
  if (lastProject && !isKnown(lastProject.serverId)) owner.settings.update({ lastProject: null })

  const orphaned = owner.unstartedRuns().filter((run) => !isKnown(run.serverId))
  if (orphaned.length === 0 || !hasMachine()) return
  const fallback = owner.defaultRunConfig
  for (const run of orphaned) {
    Object.assign(run, withCheckout(run, fallback.workingDirectory, null), {
      serverId: fallback.serverId,
      // A draft opened from a task keeps the task's home when that home is not gone.
      taskServerId: isKnown(run.taskServerId) ? run.taskServerId : fallback.taskServerId,
      pendingHostDispatch: null,
    })
  }
}
