import { afterEach, describe, expect, test } from 'bun:test'
import { HOST_LOGIN_SEAT } from '@solus/contracts/seats'
import { actorFor, attributionOf, HOST_ACTOR, insightsAccountOf, ownerKeyOf, seatFor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import { useHostUser } from '@solus/server/host/host-user'
import { credentialLocationOf } from '@solus/server/vault/vault'
import { SolusServer, type HandlerCtx } from '@solus/server/transport/server'
import { memberPrincipal } from './helpers/actors'
import { installTestIdentities } from './helpers/acting-identities'

// plans/012-user-actor-and-activity.md §4: admission resolves the actor once. Its
// user is the one person every surface names; its seat and its credential user
// follow from the principal that admitted it, so no handler converts a principal.

const LOCAL_OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const REMOTE_OWNER: Principal = { kind: 'remote-owner', userId: 'acct-ashton', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud', displayName: 'Ashton Sidhu' }
const BOB = memberPrincipal('bob', 'Bob', { email: 'bob@example.com', avatarUrl: 'https://x/bob.png' })
const guestOf = (sharedByUserId: string, accountUserId?: string): Principal => ({
  kind: 'guest', guestId: accountUserId ?? 'g1', displayName: 'Maya', deviceId: 'g1', expiresAt: 0, deviceLabel: 'Guest link',
  share: { resource: { kind: 'session', id: 's1' }, role: 'editor', sharedByUserId, linkSecretHash: 'h' },
  ...(accountUserId ? { accountUserId } : {}),
})
const RUNNER: Principal = { kind: 'runner', hostId: 'host-1', organizationId: 'org-1', ownerUserId: 'bob', deviceId: 'host-1', expiresAt: 0, deviceLabel: 'Runner' }

afterEach(() => useHostUser(null))

// Members act from homes of their own, as on a booted server (plans/019).
installTestIdentities()

describe('actorFor', () => {
  test('the owner of an unlinked host is its local user, on the host login, with the host\'s own connections', () => {
    useHostUser({ localId: 'mac-1' })
    const actor = actorFor(LOCAL_OWNER)
    expect(actor.user?.id).toEqual({ kind: 'local', localId: 'mac-1' })
    // WHY: the host names its owner; "Host owner" is not a name anyone gave them.
    expect(actor.user?.displayName).not.toBe('')
    expect(seatFor(actor)).toEqual(HOST_LOGIN_SEAT)
    expect(credentialLocationOf(ownerKeyOf(actor))).toEqual({ kind: 'host' })
    // An unlinked host knows no account: the owner's turn is attributed to nobody in Insights.
    expect(insightsAccountOf(actor)).toBeNull()
  })

  test('the owner of a linked host is their account, locally and over the tunnel, still on the host login', () => {
    useHostUser({ localId: 'mac-1', account: { accountId: 'acct-ashton', displayName: 'Ashton', email: 'a@example.com' } })
    const local = actorFor(LOCAL_OWNER)
    const remote = actorFor(REMOTE_OWNER)
    expect(local.user).toEqual({ id: { kind: 'account', accountId: 'acct-ashton' }, displayName: 'Ashton', email: 'a@example.com' })
    // The grant names the person; it wins over the name the host stored.
    expect(remote.user).toEqual({ id: { kind: 'account', accountId: 'acct-ashton' }, displayName: 'Ashton Sidhu', email: 'a@example.com' })
    expect(seatFor(local)).toEqual(HOST_LOGIN_SEAT)
    expect(seatFor(remote)).toEqual(HOST_LOGIN_SEAT)
    // WHY: signed in means the account (docs/plans/cloud-vault.md §2.5): the linked owner's connections are their account's.
    expect(credentialLocationOf(ownerKeyOf(local))).toEqual({ kind: 'account', accountId: 'acct-ashton' })
    expect(credentialLocationOf(ownerKeyOf(remote))).toEqual({ kind: 'account', accountId: 'acct-ashton' })
    // Insights attribute the owner's turn to the account that linked the host (organization-scope §6.1).
    expect(insightsAccountOf(local)?.id).toEqual({ kind: 'account', accountId: 'acct-ashton' })
  })

  test('a member is their account, on their own seat, with their own connections', () => {
    const actor = actorFor(BOB)
    expect(actor.user).toEqual({ id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob', email: 'bob@example.com', avatarUrl: 'https://x/bob.png' })
    expect(seatFor(actor)).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'bob' }, name: 'Bob' })
    expect(credentialLocationOf(ownerKeyOf(actor))).toEqual({ kind: 'account', accountId: 'bob' })
    expect(insightsAccountOf(actor)?.email).toBe('bob@example.com')
  })

  test('a guest is their guest id, on the sharer\'s seat, with the sharer\'s connections unless they signed in', () => {
    const anonymous = actorFor(guestOf('bob'))
    expect(anonymous.user).toEqual({ id: { kind: 'guest', guestId: 'g1' }, displayName: 'Maya' })
    expect(seatFor(anonymous)).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } })
    // D1: a guest runs on the sharer's seat but has no logins of their own or the sharer's.
    expect(credentialLocationOf(ownerKeyOf(anonymous))).toEqual({ kind: 'none' })
    expect(insightsAccountOf(anonymous)).toBeNull()
    const signedIn = actorFor(guestOf('bob', 'acct-maya'))
    expect(credentialLocationOf(ownerKeyOf(signedIn))).toEqual({ kind: 'none' })
    // A guest of the host's own user runs on the host login.
    useHostUser({ localId: 'mac-1' })
    expect(seatFor(actorFor(guestOf('local:mac-1')))).toEqual(HOST_LOGIN_SEAT)
  })

  test('a runner and the host itself are nobody, on the host login, with the host\'s connections', () => {
    useHostUser({ localId: 'mac-1', account: { accountId: 'acct-ashton' } })
    for (const actor of [actorFor(RUNNER), actorFor({ kind: 'system' }), HOST_ACTOR]) {
      expect(actor.user).toBeNull()
      expect(seatFor(actor)).toEqual(HOST_LOGIN_SEAT)
      expect(ownerKeyOf(actor)).toBeNull()
    }
    // The host's own admitted work is attributed to the account that linked it; a runner's is not.
    expect(insightsAccountOf(HOST_ACTOR)?.id).toEqual({ kind: 'account', accountId: 'acct-ashton' })
    expect(insightsAccountOf(actorFor(RUNNER))).toBeNull()
  })
})

describe('ownerKeyOf as the person behind MCP servers and sign-ins', () => {
  // WHY: an MCP server and its sign-in belong to a person on every host. The owner is
  // a person like a member: their key, never "no one", or a host with no owner (a
  // managed host) has no way to name whose server a run should list.
  test('every person is their user key: the owner by the host\'s user, a member by their account, a guest by their guest id', () => {
    useHostUser({ localId: 'mac-1' })
    expect(ownerKeyOf(actorFor(LOCAL_OWNER))).toBe('local:mac-1')
    useHostUser({ localId: 'mac-1', account: { accountId: 'acct-ashton' } })
    expect(ownerKeyOf(actorFor(LOCAL_OWNER))).toBe('acct-ashton')
    expect(ownerKeyOf(actorFor(REMOTE_OWNER))).toBe('acct-ashton')
    expect(ownerKeyOf(actorFor(BOB))).toBe('bob')
    // A guest never borrows the sharer's sign-ins: they have their own key and no connections.
    expect(ownerKeyOf(actorFor(guestOf('bob')))).toBe('guest:g1')
  })

  test('the host itself and a runner are nobody', () => {
    useHostUser({ localId: 'mac-1' })
    for (const actor of [actorFor(RUNNER), actorFor({ kind: 'system' }), HOST_ACTOR]) expect(ownerKeyOf(actor)).toBeNull()
  })
})
