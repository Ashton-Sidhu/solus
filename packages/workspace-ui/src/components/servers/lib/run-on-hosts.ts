import type { RunConfig } from '@solus/contracts/types'
import type { ProjectRef } from '../../../contexts/projects/project-catalog'
import { isChat } from '@solus/contracts/chat'

/**
 * What choosing a host in the Run on picker does for the run's project. The
 * picker answers one question — which machine runs this project — and each
 * row says ahead of the click what that machine will use.
 */
export type RunOnHostAction =
  /** The run is already on this host. */
  | { kind: 'current' }
  /** The host holds a checkout of the project: the run moves into it. */
  | { kind: 'checkout'; path: string }
  /** The host has no checkout: Send copies the repository there. */
  | { kind: 'clone' }
  /** The project has no remote to copy, so the person picks a folder there. */
  | { kind: 'choose-folder' }
  /** A chat has no project: any host can run it, in a new chat folder there. */
  | { kind: 'chat' }

export interface RunOnHostInput {
  hostId: string
  /** The host the next session starts on, a queued choice included. */
  selectedHostId: string
  run: RunConfig
  /** The known checkouts of the run's project on every host, most recently
   *  used first. */
  checkouts: readonly ProjectRef[]
  /** The repository a host can copy, or null when the project has no hosted remote. */
  cloneRepoKey: string | null
}

export function runOnHostAction(input: RunOnHostInput): RunOnHostAction {
  if (input.hostId === input.selectedHostId) return { kind: 'current' }
  if (isChat(input.run.workingDirectory)) return { kind: 'chat' }
  const path = checkoutPathOn(input.run, input.hostId, input.checkouts)
  if (path) return { kind: 'checkout', path }
  return input.cloneRepoKey ? { kind: 'clone' } : { kind: 'choose-folder' }
}

/** The folder on `hostId` that holds the run's project. A dispatched run's
 *  home remembers its own checkout; any other host is named by the catalog. */
export function checkoutPathOn(run: RunConfig, hostId: string, checkouts: readonly ProjectRef[]): string | null {
  if (run.projectGroupPath && run.taskServerId === hostId) return run.projectGroupPath
  return checkouts.find((checkout) => checkout.serverId === hostId)?.projectRoot ?? null
}

/** The second line of a row: what the host will use. The current host needs none. */
export function runOnHostNote(action: RunOnHostAction): string | null {
  switch (action.kind) {
    case 'checkout': return 'Uses its checkout'
    case 'clone': return 'Copies the repository'
    case 'choose-folder': return 'Choose a folder'
    case 'chat': return null
    case 'current': return null
  }
}

/**
 * Whether the run names a project that limits where it can run. A chat is no
 * project: any host can take it. Neither is a folder on a host that runs no
 * sessions (the workspace service): no host has it, so it must not hide every host
 * that would need a folder picked. A draft saved before its host was replaced can
 * name one.
 */
export function runHasProject(
  projectDir: string | null | undefined,
  runsSessions: boolean,
): boolean {
  return !!projectDir && projectDir !== '~' && runsSessions && !isChat(projectDir)
}

/** The hosts the picker lists, in the order a person decides: where the run
 *  is, then hosts that already hold the project, then hosts that can copy it.
 *  Once a project is chosen, a host that would need a folder picked is not
 *  listed: it cannot run this project. Equal hosts keep their order. */
export function listRunOnHosts<Host>(
  hosts: readonly Host[],
  actionFor: (host: Host) => RunOnHostAction,
  hasProject: boolean,
): Host[] {
  const rank = (kind: RunOnHostAction['kind']) => kind === 'current' ? 0 : kind === 'checkout' ? 1 : 2
  return hosts
    .map((host, index) => ({ host, index, kind: actionFor(host).kind }))
    .filter(({ kind }) => !hasProject || kind !== 'choose-folder')
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.index - b.index)
    .map(({ host }) => host)
}
