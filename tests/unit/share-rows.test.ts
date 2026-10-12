import { describe, expect, test } from 'bun:test'
import { userKey } from '@solus/contracts/user'
import { organizationPeople } from '@solus/workspace-ui/components/users/lib/organization-people'
import type { ShareList } from '@solus/contracts/sharing'
import {
  scopeRequestFor,
  hostLinkContext,
  linkPresentation,
  ownerLabel,
  personCandidates,
  personRows,
  scopeOf,
  scopeOptions,
  shareSummary,
  linkToCopy,
  withPersonRole,
  withoutPerson,
} from '../../packages/workspace-ui/src/components/sharing/lib/share-rows'
import { appLinkUrl } from '../../packages/workspace-ui/src/contexts/sharing/app-link'
import { parseRoute } from '../../packages/workspace-ui/src/contexts/workspace/routing/codec'

// docs/plans/multiplayer-sharing.md §4.1: the dialog is one choice — who can open
// it — and the link. A scope stands for rows; rows stand for a scope; the two never
// disagree. §4.2: the guest secret rides the fragment.

const directory = organizationPeople({
  organizationId: 'org1',
  name: 'Acme',
  members: [
    { userId: 'alice', name: 'Alice', email: 'alice@acme.test', role: 'owner' },
    { userId: 'bob', name: 'Bob', email: 'bob@acme.test', role: 'member' },
  ],
  teams: [{ teamId: 'team-a', name: 'Team A', memberUserIds: ['bob'] }],
})

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

  test('on a host members cannot reach, the team and organization rows are shown but not to be chosen', () => {
    // WHY (host-sharing.md §4.3): a member arrives through the cloud app with a host
    // access token, which needs the host linked. Offering the organization on an
    // unlinked host moved the record into an organization nobody could open.
    const rows = scopeOptions(base, directory, null, 'you', { membersReachable: false })
    expect(rows.map((option) => [option.key, option.unavailable ?? null])).toEqual([
      ['private', null],
      ['team:team-a', 'Link this computer so members can reach it'],
      ['organization:org1', 'Link this computer so members can reach it'],
      ['link', null],
    ])
    expect(scopeOptions(base, directory, null, 'you').every((option) => !option.unavailable)).toBe(true)
  })

  test('a current scope the directory cannot name is still offered, so the choice is never empty', () => {
    const list: ShareList = { ...base, grants: [{ subject: { kind: 'team', id: 'team-z' }, role: 'editor', grantedByUserId: 'alice', createdAt: 1 }] }
    expect(scopeOptions(list, directory, null, 'you').map((option) => option.key)).toContain('team:team-z')
  })

  test('a scope becomes rows with its role, and the link keeps the organization as it was', () => {
    // WHY: the link is the widest scope. Dropping the organization row when the link
    // goes on would push teammates through the guest door as viewers.
    expect(scopeRequestFor({ kind: 'private' }, base, 'org1').grants).toEqual([])
    expect(scopeRequestFor({ kind: 'team', teamId: 'team-a', role: 'viewer' }, base, 'org1').grants).toEqual([{ subject: { kind: 'team', id: 'team-a' }, role: 'viewer' }])
    expect(scopeRequestFor({ kind: 'organization', organizationId: 'org1', role: 'editor' }, base, null).grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'editor' }])
    expect(scopeRequestFor({ kind: 'link', role: 'viewer' }, base, 'org1').grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }])
    const viewing: ShareList = { ...base, grants: [{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer', grantedByUserId: 'alice', createdAt: 1 }] }
    expect(scopeRequestFor({ kind: 'link', role: 'editor' }, viewing, 'org1').grants).toEqual([{ subject: { kind: 'organization', id: 'org1' }, role: 'viewer' }])
    expect(scopeRequestFor({ kind: 'link', role: 'viewer' }, base, null).grants).toEqual([])
  })

  test('a scope change carries the link only when the link changes', () => {
    // WHY: the rows and the link go in one transaction, so the list never lands
    // between two scopes. A scope that leaves the link as it is must not touch it,
    // or an unchanged link would be rewritten on every row change.
    expect(scopeRequestFor({ kind: 'link', role: 'editor' }, base, 'org1').link).toEqual({ role: 'editor' })
    expect(scopeRequestFor({ kind: 'organization', organizationId: 'org1', role: 'editor' }, base, 'org1').link).toBeUndefined()
    const linked: ShareList = { ...base, link: { role: 'viewer' } }
    expect(scopeRequestFor({ kind: 'link', role: 'viewer' }, linked, 'org1').link).toBeUndefined()
    expect(scopeRequestFor({ kind: 'link', role: 'commenter' }, linked, 'org1').link).toEqual({ role: 'commenter' })
    expect(scopeRequestFor({ kind: 'private' }, linked, 'org1').link).toEqual({ role: null })
  })

  test('"Only …" names the reader when they own it, else the owner', () => {
    expect(ownerLabel(base, directory)).toBe('you')
    expect(ownerLabel({ ...base, callerRole: 'editor' }, directory)).toBe('Alice')
    // A host's owner outside the directory is "the owner"; the host no longer has a nameless "host owner" (plans/012 §1).
    expect(ownerLabel({ ...base, ownerUserId: 'local:mac-1', callerRole: 'editor' }, null)).toBe('the owner')
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
    const alice = { id: { kind: 'account' as const, accountId: 'alice' }, displayName: 'Alice' }
    const rows = personRows({ ...base, grants: [bobRow] }, directory, alice)
    expect(rows.map((row) => [row.userId, row.user.displayName, row.role, row.isSelf])).toEqual([
      ['alice', 'Alice', 'owner', true],
      ['bob', 'Bob', 'viewer', false],
    ])
    const bob = { id: { kind: 'account' as const, accountId: 'bob' }, displayName: 'Bob' }
    expect(personRows({ ...base, ownerUserId: 'gone-owner', callerRole: 'viewer', grants: [{ ...bobRow, subject: { kind: 'user', id: 'gone' } }] }, directory, bob).map((row) => row.user.displayName)).toEqual(['Former member', 'Former member'])
  })

  test('the owner of a host with no account reads as themselves, by the name their host gave them', () => {
    // WHY (plans/012 §1): the owner's row is theirs; "Host owner" was a label, not a name.
    const owner = { id: { kind: 'local' as const, localId: 'mac-1' }, displayName: 'Ashton' }
    const rows = personRows({ ...base, ownerUserId: 'local:mac-1', callerRole: 'owner' }, null, owner)
    expect(rows.map((row) => [row.userId, row.user.displayName, row.isSelf])).toEqual([['local:mac-1', 'Ashton', true]])
  })

  test('candidates are the directory minus the owner and the people already named, narrowed by the search', () => {
    expect(personCandidates(base, directory, '').map((c) => userKey(c.id))).toEqual(['bob'])
    expect(personCandidates({ ...base, grants: [bobRow] }, directory, '').map((c) => userKey(c.id))).toEqual([])
    expect(personCandidates(base, directory, 'acme').map((c) => userKey(c.id))).toEqual(['bob'])
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
    expect(scopeRequestFor({ kind: 'private' }, list, 'org1').grants).toEqual([{ subject: bobRow.subject, role: 'viewer' }])
    expect(scopeRequestFor({ kind: 'team', teamId: 'team-a', role: 'editor' }, list, 'org1').grants).toEqual([
      { subject: bobRow.subject, role: 'viewer' },
      { subject: { kind: 'team', id: 'team-a' }, role: 'editor' },
    ])
    // The scope still reads from the group rows alone: a named person is not a scope.
    expect(scopeOf({ ...base, grants: [bobRow] })).toEqual({ kind: 'private' })
  })
})

describe('the guest link', () => {
  test('the host is the authority on where its link opens', () => {
    // WHY: docs/plans/host-sharing.md §2 — the host says where a resource's link
    // opens: the account origin for a mirrored session, else its own route. Until it
    // answers, the dialog must not claim there is no link, and a host nobody can reach
    // gets no link at all rather than one nobody can open.
    expect(hostLinkContext('https://h-abc.solus.sh')).toEqual({ kind: 'origin', origin: 'https://h-abc.solus.sh' })
    expect(hostLinkContext('http://192.168.1.42:7777')).toEqual({ kind: 'origin', origin: 'http://192.168.1.42:7777' })
    expect(hostLinkContext(null)).toEqual({ kind: 'unreachable' })
    expect(hostLinkContext(undefined)).toEqual({ kind: 'checking' })
  })

  test('the link is always at hand for whoever may share, and only a fact for a viewer', () => {
    // WHY: a share control is only useful when the link can be copied any time, not
    // once at creation; a viewer must never be handed the secret through the list.
    const onHost = { kind: 'origin' as const, origin: 'http://192.168.1.42:7777' }
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, onHost, true, { kind: 'work', id: 'w1' })).toEqual({ kind: 'url', url: 'http://192.168.1.42:7777/w/w1#s3' })
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, { kind: 'unreachable' }, true)).toEqual({ kind: 'unreachable' })
    expect(linkPresentation({ role: 'viewer', secret: 's3' }, { kind: 'checking' }, true)).toEqual({ kind: 'checking' })
    expect(linkPresentation({ role: 'viewer' }, onHost, true)).toEqual({ kind: 'unavailable' })
    expect(linkPresentation({ role: 'viewer' }, onHost, false)).toEqual({ kind: 'hidden' })
    expect(linkPresentation(null, onHost, true)).toBeNull()
  })
})

describe('the member link', () => {
  const grant = (subject: ShareList['grants'][number]['subject']) => ({ subject, role: 'viewer' as const, grantedByUserId: 'alice', createdAt: 1 })

  test('Copy link copies the link of the scope the list has, and never widens it', () => {
    // WHY: copying must not change who can open the resource; only the access
    // choice does, as in a shared document. A list without a link copies the
    // member link, whatever its scope, so only people with access get in.
    const member = 'https://app.solus.sh/work/w1'
    const guest = { kind: 'url' as const, url: 'https://app.solus.sh/w/w1#secret' }
    expect(linkToCopy({ ...base, grants: [grant({ kind: 'organization', id: 'org1' })] }, null, member)).toEqual({ kind: 'member', text: member })
    expect(linkToCopy({ ...base, grants: [grant({ kind: 'user', id: 'bob' })] }, null, member)).toEqual({ kind: 'member', text: member })
    expect(linkToCopy(base, null, member)).toEqual({ kind: 'member', text: member })
    // The link scope copies the guest link, never the member link.
    const withLink: ShareList = { ...base, link: { role: 'viewer', secret: 'secret' } }
    expect(linkToCopy(withLink, guest, member)).toEqual({ kind: 'guest', text: guest.url })
    // A host that offers no route has no guest link to copy, and the member link is not a stand-in for it.
    expect(linkToCopy(withLink, { kind: 'unreachable' }, member)).toBeNull()
    // Nothing to copy is nothing: no fallback to a wider link.
    expect(linkToCopy(withLink, { kind: 'unavailable' }, member)).toBeNull()
    expect(linkToCopy(base, null, null)).toBeNull()
  })

  test('the member link opens the resource as a page of the app, with no secret', () => {
    // WHY: it admits only the people the resource is shared with, so it must not
    // carry the bearer secret, and it must land on the resource after sign-in.
    // The route is the path: the server sees it and keeps it as `next` when it
    // sends a signed-out visitor to sign-in. A fragment never reaches the server.
    const work = new URL(appLinkUrl('https://app.solus.sh/', { kind: 'work', id: 'w1' }, 'solus-api:org1'))
    expect(work.origin).toBe('https://app.solus.sh')
    expect(work.hash).toBe('')
    expect(parseRoute(work.pathname)).toEqual({ name: 'work', params: { workId: 'w1', serverId: 'solus-api:org1' } })
    const session = new URL(appLinkUrl('https://app.solus.sh', { kind: 'session', id: 's1' }, 'solus-api:org1'))
    expect(session.hash).toBe('')
    expect(parseRoute(session.pathname)).toEqual({ name: 'sessionRecord', params: { sessionId: 's1', serverId: 'solus-api:org1' } })
  })
})
