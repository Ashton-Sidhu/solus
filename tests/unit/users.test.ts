import { describe, expect, test } from 'bun:test'
import type { User } from '@solus/contracts/user'
import { chipName, firstName, presenceTint } from '@solus/workspace-ui/components/users/lib/users'
import { memberByKey, memberUser, organizationPeople } from '@solus/workspace-ui/components/users/lib/organization-people'

// plans/012 §6: one way to draw a user. `UserChip` and `UserAvatar` read these
// rules, so the same person has one face, one colour and one name form everywhere.

const ann: User = { id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Marie Lee' }

describe('the chip name', () => {
  test('inside a card or a divider the first name; elsewhere the full name', () => {
    // WHY: a divider ("for Ann") has room for one word; a row or a label names the whole person.
    expect(chipName(ann, true)).toBe('Ann')
    expect(chipName(ann, false)).toBe('Ann Marie Lee')
  })

  test('a one-word or padded name keeps what it has', () => {
    expect(firstName('  Zoe  ')).toBe('Zoe')
    expect(chipName({ ...ann, displayName: 'Bob' }, true)).toBe('Bob')
  })
})

describe('the colour', () => {
  test('every index has its own hue and wraps inside the palette', () => {
    const hues = new Set(Array.from({ length: 8 }, (_, index) => presenceTint(index).color))
    expect(hues.size).toBe(8)
    expect(presenceTint(8).color).toBe(presenceTint(0).color)
    expect(presenceTint(-1).color).toBe(presenceTint(7).color)
  })
})

describe('the one member list', () => {
  const people = organizationPeople({
    organizationId: 'org_1',
    name: 'Acme',
    members: [
      { userId: 'u_ann', name: 'Ann Lee', email: 'ann@acme.dev', image: 'https://img/ann.png', role: 'owner' },
      { userId: 'u_bob', name: 'Bob Ray', image: null, role: 'member' },
    ],
    teams: [{ teamId: 't_ops', name: 'Ops', memberUserIds: ['u_bob'] }],
  })

  test('a directory member is an account user with their name, email and avatar', () => {
    // WHY: every people choice (mentions, sharing) keys a member by `userKey`, the
    // string share rows and mentions already store: the bare account id.
    expect(people.members).toEqual([
      { id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Lee', email: 'ann@acme.dev', avatarUrl: 'https://img/ann.png' },
      { id: { kind: 'account', accountId: 'u_bob' }, displayName: 'Bob Ray' },
    ])
    expect(people).toMatchObject({ organizationId: 'org_1', name: 'Acme', teams: [{ teamId: 't_ops' }] })
  })

  test('a member is found by the key a share row or a mention holds', () => {
    expect(memberByKey(people, 'u_bob')).toEqual(memberUser({ userId: 'u_bob', name: 'Bob Ray', role: 'member' }))
    expect(memberByKey(people, 'u_gone')).toBeUndefined()
    expect(memberByKey(null, 'u_bob')).toBeUndefined()
  })
})
