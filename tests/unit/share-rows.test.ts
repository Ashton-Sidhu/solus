import { describe, expect, test } from 'bun:test'
import type { OrganizationDirectory } from '@solus/contracts/uplink'
import type { ShareList } from '@solus/contracts/sharing'
import {
  grantsFor,
  guestLinkContext,
  guestLinkUrl,
  linkPresentation,
  linkRoleFor,
  ownerLabel,
  personCandidates,
  personRows,
  scopeOf,
  scopeOptions,
  shareSummary,
  withPersonRole,
  withoutPerson,
} from '../../packages/workspace-ui/src/components/sharing/lib/share-rows'

// docs/plans/multiplayer-sharing.md §4.1: the dialog is one choice — who can open
// it — and the link. A scope stands for rows; rows stand for a scope; the two never
// disagree. §4.2: the guest secret rides the fragment.

const directory: OrganizationDirectory = {
  organizationId: 'org1',
  name: 'Acme',
  members: [
    { userId: 'alice', name: 'Alice', email: 'alice@acme.test', role: 'owner' },
    { userId: 'bob', name: 'Bob', email: 'bob@acme.test', role: 'member' },
  ],
  teams: [{ teamId: 'team-a', name: 'Team A', memberUserIds: ['bob'] }],
}

const base: ShareList = {
  resource: { kind: 'work', id: 'w1' },
  ownerUserId: 'alice',
  callerRole: 'owner',
  link: null,
  grants: [],
}

describe('scope', () => {
  test('a list reads as its widest scope with its role: the link, then the organization, then a team, else private', () => {
    // WHY: the dialog shows exactly one choice as on; a list with several rows must
    // resolve to the widest, or the reader would believe it narrower than it is.
    expect(scopeOf(base)).toEqual({ kind: 'private' })
    expect(scopeOf({ ...base, grants: [{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 }] })).toEqual({ kind: 'team', teamId: 'team-a', role: 'viewer' })
    expect(scopeOf({ ...base, grants: [
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor', grantedByUserId: 'alice', createdAt: 1 },
      { subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'alice', createdAt: 2 },
    ] })).toEqual({ kind: 'organization', organizationId: 'org1', role: 'editor' })
    expect(scopeOf({ ...base, link: { role: 'editor' } })).toEqual({ kind: 'link', role: 'editor' })
  })

  test('the choices are only the owner, each team, the organization, and the link, each with a role', () => {
    const rows = scopeOptions(base, directory, null, 'you').map((option) => [option.key, option.name, option.role, option.detail])
    expect(rows).toEqual([
      ['private', 'Only you', null, 'Nobody else can open it'],
      ['team:team-a', 'Team A', 'editor', 'Team · 1 person can edit'],
      ['organization:org1', 'Everyone in Acme', 'editor', 'Organization · everyone in it can edit'],
      ['link', 'Anyone with the link', 'viewer', 'Anyone on the internet with the link can view'],
    ])
    // The row that is on carries the list's role; the others their starting role.
    const viewing: ShareList = { ...base, grants: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 }] }
    expect(scopeOptions(viewing, directory, null, 'you').find((option) => option.key === 'organization:org1')).toMatchObject({ role: 'viewer', detail: 'Organization · everyone in it can view' })
    expect(scopeOptions(viewing, directory, null, 'you').find((option) => option.key === 'team:team-a')?.role).toBe('editor')
    // No account and no organization: the link is the only way out.
    expect(scopeOptions(base, null, null, 'you').map((option) => option.key)).toEqual(['private', 'link'])
    // The host named the organization though the directory has not loaded: the row is still offered.
    expect(scopeOptions(base, null, 'org1', 'you').map((option) => option.key)).toEqual(['private', 'organization:org1', 'link'])
  })

  test('a current scope the directory cannot name is still offered, so the choice is never empty', () => {
    const list: ShareList = { ...base, grants: [{ subject: { kind: 'team', id: 'team-z' }, role: 'editor', grantedByUserId: 'alice', createdAt: 1 }] }
    expect(scopeOptions(list, directory, null, 'you').map((option) => option.key)).toContain('team:team-z')
  })

  test('a scope becomes rows with its role, and the link keeps the organization as it was', () => {
    // WHY: the link is the widest scope. Dropping the organization row when the link
    // goes on would push teammates through the guest door as viewers.
    expect(grantsFor({ kind: 'private' }, base, 'org1').grants).toEqual([])
    expect(grantsFor({ kind: 'team', teamId: 'team-a', role: 'viewer' }, base, 'org1').grants).toEqual([{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }])
    expect(grantsFor({ kind: 'organization', organizationId: 'org1', role: 'editor' }, base, null).grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }])
    expect(grantsFor({ kind: 'link', role: 'viewer' }, base, 'org1').grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }])
    const viewing: ShareList = { ...base, grants: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 }] }
    expect(grantsFor({ kind: 'link', role: 'editor' }, viewing, 'org1').grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }])
    expect(grantsFor({ kind: 'link', role: 'viewer' }, base, null).grants).toEqual([])
    expect(linkRoleFor({ kind: 'link', role: 'editor' })).toBe('editor')
    expect(linkRoleFor({ kind: 'organization', organizationId: 'org1', role: 'editor' })).toBeNull()
  })

  test('"Only …" names the reader when they own it, else the owner', () => {
    expect(ownerLabel(base, directory)).toBe('you')
    expect(ownerLabel({ ...base, callerRole: 'editor' }, directory)).toBe('Alice')
    expect(ownerLabel({ ...base, ownerUserId: 'host-owner', callerRole: 'editor' }, null)).toBe('the host owner')
    expect(ownerLabel({ ...base, ownerUserId: 'gone', callerRole: 'viewer' }, directory)).toBe('the owner')
  })

  test('the badge says the scope in words, and counts the people named', () => {
    expect(shareSummary(undefined)).toEqual({ scope: null, people: 0, hasLink: false, label: 'Share' })
    expect(shareSummary(base).label).toBe('Share')
    expect(shareSummary({ ...base, callerRole: 'editor' }).label).toBe('Shared with you')
    expect(shareSummary({ ...base, grants: [{ subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'alice', createdAt: 1 }] }).label).toBe('Shared · the organization')
    expect(shareSummary({ ...base, link: { role: 'viewer' } })).toMatchObject({ hasLink: true, label: 'Shared · anyone with the link' })
    expect(shareSummary({ ...base, grants: [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 }] })).toMatchObject({ people: 1, label: 'Shared · 1 person' })
  })
})

describe('people named on the list', () => {
  const bobRow = { subject: { kind: 'user', id: 'bob' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 } as const
  const orgRow = { subject: { kind: 'organization', id: 'org1' }, role: 'editor', grantedByUserId: 'alice', createdAt: 2 } as const

  test('the owner leads the rows, then each person with a row, named from the directory', () => {
    const rows = personRows({ ...base, grants: [bobRow] }, directory, 'alice')
    expect(rows.map((row) => [row.userId, row.name, row.role, row.isSelf])).toEqual([
      ['alice', 'Alice', 'owner', true],
      ['bob', 'Bob', 'viewer', false],
    ])
    expect(personRows({ ...base, ownerUserId: 'host-owner', callerRole: 'viewer', grants: [{ ...bobRow, subject: { kind: 'user', id: 'gone' } }] }, directory, 'bob').map((row) => row.name)).toEqual(['Host owner', 'Former member'])
  })

  test('candidates are the directory minus the owner and the people already named, narrowed by the search', () => {
    expect(personCandidates(base, directory, '').map((c) => c.userId)).toEqual(['bob'])
    expect(personCandidates({ ...base, grants: [bobRow] }, directory, '').map((c) => c.userId)).toEqual([])
    expect(personCandidates(base, directory, 'acme').map((c) => c.userId)).toEqual(['bob'])
    expect(personCandidates(base, directory, 'zzz')).toEqual([])
    expect(personCandidates(base, null, '')).toEqual([])
  })

  test('a person keeps their own row whatever the general access says, and the general access keeps the people', () => {
    // WHY: the two sections are independent choices; changing one must never
    // silently undo the other, or an invited person would vanish on a scope change.
    const list: ShareList = { ...base, grants: [bobRow, orgRow] }
    expect(withPersonRole(list, 'bob', 'editor').grants).toEqual([{ subject: orgRow.subject, role: 'editor' }, { subject: bobRow.subject, role: 'editor' }])
    expect(withPersonRole(list, 'cara', 'viewer').grants).toHaveLength(3)
    expect(withoutPerson(list, 'bob').grants).toEqual([{ subject: orgRow.subject, role: 'editor' }])
    expect(grantsFor({ kind: 'private' }, list, 'org1').grants).toEqual([{ subject: bobRow.subject, role: 'viewer' }])
    expect(grantsFor({ kind: 'team', teamId: 'team-a', role: 'editor' }, list, 'org1').grants).toEqual([
      { subject: bobRow.subject, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ])
    // The scope still reads from the group rows alone: a named person is not a scope.
    expect(scopeOf({ ...base, grants: [bobRow] })).toEqual({ kind: 'private' })
  })
})

describe('the guest link', () => {
  test('carries the secret in the fragment under the account origin', () => {
    expect(guestLinkUrl('https://app.solus.sh/', 'abcdefghijklmnop', 's3cret')).toBe('https://app.solus.sh/app/#/h/abcdefghijklmnop/s/s3cret')
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
