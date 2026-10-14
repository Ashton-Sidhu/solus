import type { RunConfig, Session } from '@solus/contracts/types'
import type { HostPresence } from '@solus/client-core/host-facts'
import { hasDirectoryAnswered } from '@solus/client-core/server-registry'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { solusApiId } from '@solus/contracts/uplink'
import type { ProjectLocation } from '../app/settings.context.svelte'
import { LOCAL_ORGANIZATION_ID } from '../../lib/organization-filter'
import { withCheckout } from './run-config'

/**
 * Whether a `gone` host is gone for good rather than not listed yet: a directory
 * read succeeded this load, or this client has no directory to wait for. Until
 * then nothing is moved, cleared, or made read-only; the host's calls just fail.
 */
export function savedHostsAreAuthoritative(): boolean {
  return hasDirectoryAnswered() || !uplinkAccountSource()
}

/** What a started session on a gone machine says in place of its composer. */
export const GONE_MACHINE_READ_ONLY_REASON = 'This machine was removed. Its conversation is read-only.'

/** The same, when nothing holds a copy: a personal session's record went with its machine, or the workspace service has none. */
export const GONE_MACHINE_NO_RECORD_REASON = 'This machine was removed, and Solus Cloud holds no copy of its conversation.'

/**
 * Where a session's record and mirrored transcript live apart from its machine
 * (docs/plans/workspace-and-machines.md §3): an organization session's are on
 * that organization's workspace service. A personal session's record lives on
 * its machine only, so it has none.
 */
export function recordHomeOf(session: Pick<Session, 'organizationId'>): string | null {
  const organizationId = session.organizationId
  return organizationId && organizationId !== LOCAL_ORGANIZATION_ID ? solusApiId(organizationId) : null
}

/** What the pass reads and writes on the workspace. */
export interface MachineReferenceOwner {
  settings: { lastProject: ProjectLocation | null; setLayout(key: 'lastProject', value: null): void }
  unstartedRuns(): RunConfig[]
  /** Sessions something has happened in: their machine is where their conversation lives. */
  startedSessions(): Pick<Session, 'run' | 'readOnlyReason'>[]
  /** Where a new session starts once the remembered project is cleared. */
  readonly defaultRunConfig: RunConfig
  /** The project lists kept from each host's last read. */
  projects: { hostIds(): string[]; forgetHost(serverId: string): void }
}

/**
 * The one owner of what happens to references to a machine that is gone
 * (docs/plans/workspace-and-machines.md §6): a host was deleted, or it was never
 * listed at this origin. Readers need no guard: a gone host's calls fail like
 * an offline host's. This pass makes the workspace stop pointing at it.
 *
 * - The remembered project is cleared.
 * - The project list kept from the machine is dropped: its projects are not
 *   away, and their checkouts can no longer be read.
 * - A run nothing has happened in yet — an unstarted tab or a draft — moves to
 *   where a new session starts, as a fresh one would. Its folder named a path on
 *   the gone machine, so it takes the new run's folder too. With no machine to
 *   move to, it stays: there is nothing better to point it at, and its Run-on
 *   chip asks for a machine.
 * - A draft opened from a task keeps the task's home unless that is gone too.
 * - A started session keeps its machine, since its conversation lives there, and
 *   becomes read-only; its transcript is read from the mirror when there is one
 *   (`hydrateTab`).
 *
 * Call it only once the saved hosts are authoritative — after a directory read
 * succeeded, or when there is no directory — so a failed read never throws
 * anything away.
 */
export function reconcileMachineReferences(
  owner: MachineReferenceOwner,
  presenceOf: (serverId: string) => HostPresence,
  hasMachine: () => boolean,
): void {
  const isGone = (serverId: string) => presenceOf(serverId) === 'gone'
  const lastProject = owner.settings.lastProject
  if (lastProject && isGone(lastProject.serverId)) owner.settings.setLayout('lastProject', null)

  for (const serverId of owner.projects.hostIds()) {
    if (isGone(serverId)) owner.projects.forgetHost(serverId)
  }

  for (const session of owner.startedSessions()) {
    if (!session.readOnlyReason && isGone(session.run.serverId)) session.readOnlyReason = GONE_MACHINE_READ_ONLY_REASON
  }

  const orphaned = owner.unstartedRuns().filter((run) => isGone(run.serverId))
  if (orphaned.length === 0 || !hasMachine()) return
  const fallback = owner.defaultRunConfig
  for (const run of orphaned) {
    Object.assign(run, withCheckout(run, fallback.workingDirectory, null), {
      serverId: fallback.serverId,
      taskServerId: isGone(run.taskServerId) ? fallback.taskServerId : run.taskServerId,
      pendingHostDispatch: null,
    })
  }
}
