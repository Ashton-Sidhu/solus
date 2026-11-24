import type { Codebase, CodebaseFolderScan, CodebaseMember, CodebaseMemberState } from '@solus/contracts/codebases'
import { hostPathBaseName, relativeHostPath } from '@solus/contracts/host-path'
import type { ListTint } from '../../ui/list-page/list-page'
import type { CodebaseHost, CodebaseHostMembers } from '../../../contexts/codebases/codebases.store.svelte'
import { rootInstallationIds } from '@solus/client-core/codebases'

/** The text of Settings → Codebases (docs/plans/codebases.md §9). Pure, so it is tested without a component. */

/** The value of the page's route param for the form of a new codebase. A codebase id is a UUID, so it is never this word. */
export const NEW_CODEBASE = 'new'

/** What a host is called when no host of this client has the installation id of a root. */
export const UNKNOWN_HOST_LABEL = 'A host that is not on this device'

const STATE_LABEL = {
  git: 'Git repository',
  plain: 'Folder',
  missing: 'Missing',
} satisfies Record<CodebaseMemberState, string>

export function memberStateLabel(state: CodebaseMemberState): string {
  return STATE_LABEL[state]
}

export function memberStateTint(state: CodebaseMemberState): ListTint {
  return state === 'missing' ? 'failure' : 'neutral'
}

/** The name of a root in its row: its own name, else its last path name. */
export function rootName(root: { name: string; path: string }): string {
  return root.name || hostPathBaseName(root.path) || root.path
}

/**
 * What a root is, in one muted line after its name: its kind, and how many
 * repositories its host found inside it. A plain folder with none says so,
 * because then the codebase gets no repository from it.
 */
export function rootDescription(state: CodebaseMemberState, foundCount: number): string {
  if (state === 'missing') return 'Not on the host'
  if (foundCount > 0) return `${STATE_LABEL[state]} · ${countLabel(foundCount, 'repository', 'repositories')} inside`
  return state === 'plain' ? 'Folder · No repository inside' : STATE_LABEL[state]
}

export function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** The hosts that a codebase covers, by name, in the order of its roots. */
export function coveredHostLabels(codebase: Codebase, hostOf: (installationId: string) => CodebaseHost | null): string[] {
  return rootInstallationIds(codebase).map((installationId) => hostOf(installationId)?.label ?? UNKNOWN_HOST_LABEL)
}

/** The second line of a codebase in the list: its folders and its hosts. */
export function codebaseSummary(codebase: Codebase, hostOf: (installationId: string) => CodebaseHost | null): string {
  if (codebase.roots.length === 0) return 'No folders'
  return [countLabel(codebase.roots.length, 'folder', 'folders'), ...coveredHostLabels(codebase, hostOf)].join(' · ')
}

/** The name of a member in a list: its own name, else its last path name. */
export function memberName(member: Pick<CodebaseMember, 'name' | 'path'>): string {
  return member.name || hostPathBaseName(member.path) || member.path
}

/** Where a found repository is, from its root: `packages/api`. */
export function memberPlace(member: Pick<CodebaseMember, 'path' | 'rootPath'>): string {
  return relativeHostPath(member.rootPath, member.path) || member.path
}

export interface HostMembersNote {
  text: string
  tone: 'muted' | 'warning' | 'error'
  /** A read is in progress: the note is a status, not a result. */
  isBusy: boolean
}

/**
 * What one host's part of a codebase says below its name: the host is not on
 * this device, it is away, its read failed, or its answer is not current.
 * Null when the members are current.
 */
export function hostMembersNote(group: CodebaseHostMembers): HostMembersNote | null {
  const host = group.label ?? UNKNOWN_HOST_LABEL
  if (group.presence === 'unknown') {
    return { text: 'This host is not on this device. Its folders stay in the codebase, but they cannot be read here.', tone: 'warning', isBusy: false }
  }
  if (group.presence === 'away') {
    return {
      text: group.isStale
        ? `${host} is not connected. These are the folders it found the last time it answered.`
        : `${host} is not connected. Its folders are read when it connects.`,
      tone: 'warning',
      isBusy: false,
    }
  }
  if (group.state === 'error') {
    return {
      text: group.isStale
        ? `${host} could not read its folders: ${group.error ?? 'no answer'} This is its last answer.`
        : `${host} could not read its folders: ${group.error ?? 'no answer'}`,
      tone: 'error',
      isBusy: false,
    }
  }
  if (group.state === 'loading' || group.state === 'idle') return { text: `Reading the folders on ${host}…`, tone: 'muted', isBusy: true }
  return null
}

/** One line for what a scan found in a folder, shown before the folder is added. */
export function scanSummary(scan: CodebaseFolderScan): string {
  if (scan.state === 'missing') return 'This folder does not exist on the host.'
  const found = scan.members.filter((member) => member.discovered)
  const kind = scan.state === 'git' ? 'A Git repository' : 'A folder with no repository of its own'
  if (found.length === 0) return `${kind}. No repository was found inside it.`
  return `${kind}. ${countLabel(found.length, 'repository was', 'repositories were')} found inside it.`
}
