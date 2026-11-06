import type { RunConfig, RunLocation, Session } from '@solus/contracts/types'
import type { HostPresence } from '@solus/client-core/host-facts'
import { hasDirectoryAnswered } from '@solus/client-core/server-registry'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { solusApiId } from '@solus/contracts/uplink'
import type { ProjectLocation } from '../app/settings.context.svelte'
import { LOCAL_ORGANIZATION_ID } from '../../lib/organization-filter'
import { checkoutPlace, fileTasksOn, openFolder, projectHome, runHost } from './run-location'
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

/** What a started session on a turned-off local host says in place of its composer. */
export const LOCAL_HOST_OFF_READ_ONLY_REASON = 'The local host is off. Turn it on in Settings → Hosts to open this conversation.'

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
  /** Runs nothing has happened in yet, each with the command that moves it
   *  through its owner, so a moved draft reads its new checkout. */
  unstartedRuns(): { run: RunConfig; moveTo(next: RunLocation): void }[]
  /** Tabs something has happened in, each with the command that closes it. */
  startedTabs(): { run: RunConfig; close(): void }[]
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
 * - A started tab closes. Forgetting a machine takes its conversations with it;
 *   an organization session is still in the list its Solus API keeps. A tab on a
 *   host that is only turned off stays, and restores when the host comes back
 *   (docs/plans/desktop-remote-only.md).
 *
 * Call it only once the saved hosts are authoritative — after a directory read
 * succeeded, or when there is no directory — so a failed read never throws
 * anything away.
 */
export function reconcileMachineReferences(
  owner: MachineReferenceOwner,
  presenceOf: (serverId: string) => HostPresence,
  hasMachine: () => boolean,
  isTurnedOff: (serverId: string) => boolean = () => false,
): void {
  const isGone = (serverId: string) => presenceOf(serverId) === 'gone'
  const lastProject = owner.settings.lastProject
  if (lastProject && isGone(lastProject.serverId)) owner.settings.setLayout('lastProject', null)

  for (const serverId of owner.projects.hostIds()) {
    if (isGone(serverId)) owner.projects.forgetHost(serverId)
  }

  for (const tab of owner.startedTabs()) {
    if (isGone(runHost(tab.run)) && !isTurnedOff(runHost(tab.run))) tab.close()
  }

  const orphaned = owner.unstartedRuns().filter(({ run }) => isGone(runHost(run)))
  if (orphaned.length === 0 || !hasMachine()) return
  const fallback = owner.defaultRunConfig
  for (const { run, moveTo } of orphaned) {
    // A draft opened from a task keeps filing on the task's home unless that
    // host is gone too; otherwise the fallback folder is its own project.
    const home = projectHome(run)
    const moved = openFolder(run.location, checkoutPlace(fallback))
    moveTo(isGone(home.serverId) ? moved : fileTasksOn(moved, home.serverId))
  }
}
