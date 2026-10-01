import type { GuestLinkResource, ShareRole } from '@solus/contracts/sharing'

/**
 * What a share link lets its guest do (docs/plans/multiplayer-sharing.md §4.2),
 * as the guest's role chip names it and its tooltip says it. The rules are the
 * host's (`access-policy.ts`); these are their words.
 */
export function guestRoleLabel(role: ShareRole): string {
  return role === 'editor' ? 'Editor' : role === 'commenter' ? 'Reviewer' : 'Viewer'
}

export function guestAccessLine(kind: GuestLinkResource['kind'], role: ShareRole): string {
  const thing = kind === 'work' ? 'this document' : 'this session'
  if (role === 'editor') return `You can read and edit ${thing}.`
  if (role === 'commenter' && kind === 'work') return `You can read, comment on, and review ${thing}.`
  return `You can read ${thing}.`
}
