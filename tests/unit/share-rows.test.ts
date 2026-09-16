import { describe, expect, test } from 'bun:test'
import type { OrganizationDirectory } from '@solus/contracts/uplink'
import type { ShareList } from '@solus/contracts/sharing'
import {
  guestLinkContext,
  guestLinkUrl,
  linkPresentation,
  ownerName,
  shareCandidates,
  shareRows,
  shareSummary,
  withRole,
  withoutSubject,
} from '../../packages/workspace-ui/src/components/sharing/lib/share-rows'

// docs/plans/multiplayer-sharing.md §4.1: the dialog lists who has access with
// their role, offers everyone in the directory who is not already listed, and every
// change is the whole list sent back. §4.2: the guest secret rides the fragment.

const directory: OrganizationDirectory = {
  organizationId: 'org1',
  name: 'Acme',
  members: [
    { userId: 'alice', name: 'Alice', email: 'alice@acme.test', role: 'owner' },
    { userId: 'bob', name: 'Bob', email: 'bob@acme.test', role: 'member' },
    { userId: 'cara', name: 'Cara', role: 'member' },
  ],
  teams: [{ teamId: 'team-a', name: 'Team A', memberUserIds: ['cara'] }],
}

const list: ShareList = {
  resource: { kind: 'work', id: 'w1' },
  ownerUserId: 'alice',
  callerRole: 'owner',
  link: { role: 'viewer' },
  grants: [
    { subject: { kind: 'user', id: 'bob' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 },
    { subject: { kind: 'team', id: 'team-a' }, role: 'editor', grantedByUserId: 'alice', createdAt: 2 },
    { subject: { kind: 'user', id: 'gone' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 3 },
  ],
}

describe('share rows', () => {
  test('names rows from the directory and marks a person the directory no longer knows', () => {
    const rows = shareRows(list, directory)
    expect(rows.map((row) => [row.name, row.detail, row.role])).toEqual([
      ['Bob', 'bob@acme.test', 'viewer'],
      ['Team A', 'Team · 1 person', 'editor'],
      ['Former member', 'gone', 'viewer'],
    ])
    expect(ownerName('alice', directory, 'bob')).toBe('Alice')
    expect(ownerName('alice', directory, 'alice')).toBe('You')
    expect(ownerName('host-owner', null, null)).toBe('Host owner')
  })

  test('candidates leave out the owner and everyone already listed, and match on name or email', () => {
    const all = shareCandidates(list, directory, '')
    expect(all.map((candidate) => candidate.key)).toEqual(['user:cara', 'organization:org1'])
    expect(shareCandidates(list, directory, 'car').map((candidate) => candidate.name)).toEqual(['Cara'])
    expect(shareCandidates(list, directory, 'everyone').map((candidate) => candidate.group)).toEqual(['Organization'])
    expect(shareCandidates(list, null, '')).toEqual([])
  })

  test('a role change or removal sends the whole list back with one row different', () => {
    // WHY: the host replaces the named rows atomically (§3.4); a partial patch would race two editors.
    const promoted = withRole(list, { kind: 'user', id: 'bob' }, 'editor')
    expect(promoted.grants.find((grant) => grant.subject.kind === 'user' && grant.subject.id === 'bob')?.role).toBe('editor')
    expect(promoted.grants).toHaveLength(3)
    const added = withRole(list, { kind: 'user', id: 'cara' }, 'viewer')
    expect(added.grants).toHaveLength(4)
    const removed = withoutSubject(list, { kind: 'team', id: 'team-a' })
    expect(removed.grants.map((grant) => grant.subject.kind)).toEqual(['user', 'user'])
    expect(removed.resource).toEqual(list.resource)
  })

  test('the guest link carries the secret in the fragment under the account origin', () => {
    expect(guestLinkUrl('https://app.solus.sh/', 'abcdefghijklmnop', 's3cret')).toBe('https://app.solus.sh/app/#/h/abcdefghijklmnop/s/s3cret')
    expect(shareSummary(list)).toEqual({ count: 4, hasLink: true })
    expect(shareSummary(undefined)).toEqual({ count: 0, hasLink: false })
  })

  test('the host is the authority on whether a guest link can be built', () => {
    // WHY: the desktop's own host is never in the saved-server registry, so a
    // registry-only rule told a linked host it was not in Solus cloud and showed a
    // bare secret instead of a link.
    const linked = {
      linked: true as const,
      link: {
        hostId: 'abcdefghijklmnop',
        directoryUrl: 'https://app.solus.sh',
        hostname: 'h-abcdefghijklmnop.solus.sh',
        issuer: 'https://app.solus.sh',
        jwksUrl: 'https://app.solus.sh/api/auth/jwks',
        proxiedPort: 34118,
        connectionGeneration: 1,
      },
      state: { observed: 'online' as const },
    }
    expect(guestLinkContext(linked, undefined)).toEqual({ kind: 'linked', hostId: 'abcdefghijklmnop', directoryUrl: 'https://app.solus.sh' })
    // An older host that cannot answer: the saved directory row still names it.
    expect(guestLinkContext(undefined, { hostId: 'h2', directoryUrl: 'https://app.solus.sh' })).toEqual({ kind: 'linked', hostId: 'h2', directoryUrl: 'https://app.solus.sh' })
    expect(guestLinkContext({ linked: false }, undefined)).toEqual({ kind: 'unlinked' })
    // Until the host answers, the dialog must not claim the host is unlinked.
    expect(guestLinkContext(undefined, undefined)).toEqual({ kind: 'checking' })
  })

  test('the link is always at hand for whoever may share, and only a fact for a viewer', () => {
    // WHY: a share control is only useful when the link can be copied any time, not
    // once at creation; a viewer must never be handed the secret through the list.
    const linked = { kind: 'linked' as const, hostId: 'abcdefghijklmnop', directoryUrl: 'https://app.solus.sh' }
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, linked, true)).toEqual({ kind: 'url', url: 'https://app.solus.sh/app/#/h/abcdefghijklmnop/s/s3' })
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, { kind: 'unlinked' }, true)).toEqual({ kind: 'secret', secret: 's3' })
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, { kind: 'checking' }, true)).toEqual({ kind: 'checking' })
    expect(linkPresentation({ role: 'viewer' }, linked, true)).toEqual({ kind: 'unavailable' })
    expect(linkPresentation({ role: 'viewer' }, linked, false)).toEqual({ kind: 'hidden' })
    expect(linkPresentation(null, linked, true)).toBeNull()
  })
})
