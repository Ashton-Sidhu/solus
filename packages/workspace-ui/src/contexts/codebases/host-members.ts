import type { CodebaseMember } from '@solus/contracts/codebases'
import { sameHostPath } from '@solus/contracts/host-path'
import type { CodebaseHostMembers } from './codebases.store.svelte'

/** The members of a codebase on one host of this client, as that host last read them. */
export interface HostMemberRead {
  members: CodebaseMember[]
  /** The host answered at least one time. Before that, a missing member is not a fact. */
  isRead: boolean
}

/** The members that `groups` (the answer of `CodebasesStore.membersOf`) holds for the host `serverId`: each root, then the repositories found in it. */
export function membersOnHost(groups: readonly CodebaseHostMembers[], serverId: string): HostMemberRead {
  const group = groups.find((each) => each.serverId === serverId)
  if (!group) return { members: [], isRead: false }
  const members = group.roots.flatMap((root) => (root.member ? [root.member, ...root.found] : root.found))
  return { members, isRead: group.state === 'ready' || group.isStale }
}

/** The member that `path` is, or null: a folder inside a member is not that member. */
export function memberAt(members: readonly CodebaseMember[], path: string | null | undefined): CodebaseMember | null {
  if (!path) return null
  return members.find((member) => sameHostPath(member.path, path)) ?? null
}
