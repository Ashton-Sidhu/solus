import { afterEach, describe, expect, test } from 'bun:test'
import { HOST_LOGIN_SEAT } from '@solus/contracts/seats'
import { actorFor, attributionOf, credentialUserFor, HOST_ACTOR, insightsAccountOf, seatFor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import { useHostUser } from '@solus/server/host/host-user'
import { SolusServer, type HandlerCtx } from '@solus/server/transport/server'
import { memberPrincipal } from './helpers/actors'

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

describe('actorFor', () => {
  test('the owner of an unlinked host is its local user, on the host login, with the host\'s own connections', () => {
    useHostUser({ localId: 'mac-1' })
    const actor = actorFor(LOCAL_OWNER)
    expect(actor.user?.id).toEqual({ kind: 'local', localId: 'mac-1' })
    // WHY: the host names its owner; "Host owner" is not a name anyone gave them.
    expect(actor.user?.displayName).not.toBe('')
    expect(seatFor(actor)).toEqual(HOST_LOGIN_SEAT)
    expect(credentialUserFor(actor)).toBeNull()
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
    // A personal host keeps the owner's connections on the host, signed in or not.
    expect(credentialUserFor(local)).toBeNull()
    expect(credentialUserFor(remote)).toBeNull()
    // Insights attribute the owner's turn to the account that linked the host (organization-scope §6.1).
    expect(insightsAccountOf(local)?.id).toEqual({ kind: 'account', accountId: 'acct-ashton' })
  })

  test('a member is their account, on their own seat, with their own connections', () => {
    const actor = actorFor(BOB)
    expect(actor.user).toEqual({ id: { kind: 'account', accountId: 'bob' }, displayName: 'Bob', email: 'bob@example.com', avatarUrl: 'https://x/bob.png' })
    expect(seatFor(actor)).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'bob' }, name: 'Bob' })
    expect(credentialUserFor(actor)).toEqual({ kind: 'account', accountId: 'bob' })
    expect(insightsAccountOf(actor)?.email).toBe('bob@example.com')
  })

  test('a guest is their guest id, on the sharer\'s seat, with the sharer\'s connections unless they signed in', () => {
    const anonymous = actorFor(guestOf('bob'))
    expect(anonymous.user).toEqual({ id: { kind: 'guest', guestId: 'g1' }, displayName: 'Maya' })
    expect(seatFor(anonymous)).toEqual({ kind: 'user', userId: { kind: 'account', accountId: 'bob' } })
    expect(credentialUserFor(anonymous)).toEqual({ kind: 'account', accountId: 'bob' })
    expect(insightsAccountOf(anonymous)).toBeNull()
    const signedIn = actorFor(guestOf('bob', 'acct-maya'))
    expect(credentialUserFor(signedIn)).toEqual({ kind: 'account', accountId: 'acct-maya' })
    // A guest of the host's own user runs on the host login.
    useHostUser({ localId: 'mac-1' })
    expect(seatFor(actorFor(guestOf('local:mac-1')))).toEqual(HOST_LOGIN_SEAT)
  })

  test('a runner and the host itself are nobody, on the host login, with the host\'s connections', () => {
    useHostUser({ localId: 'mac-1', account: { accountId: 'acct-ashton' } })
    for (const actor of [actorFor(RUNNER), actorFor({ kind: 'system' }), HOST_ACTOR]) {
      expect(actor.user).toBeNull()
      expect(seatFor(actor)).toEqual(HOST_LOGIN_SEAT)
      expect(credentialUserFor(actor)).toBeNull()
    }
    // The host's own admitted work is attributed to the account that linked it; a runner's is not.
    expect(insightsAccountOf(HOST_ACTOR)?.id).toEqual({ kind: 'account', accountId: 'acct-ashton' })
    expect(insightsAccountOf(actorFor(RUNNER))).toBeNull()
  })
})

describe('attributionOf', () => {
  test('a person\'s own action names them; an agent or an automation names itself and the person it worked for', () => {
    const bob = actorFor(BOB)
    expect(attributionOf(bob)).toEqual({ kind: 'user', user: bob.user! })
    expect(attributionOf(bob, { sessionId: 's1', provider: 'codex' })).toEqual({ kind: 'agent', sessionId: 's1', provider: 'codex', for: bob.user! })
    expect(attributionOf(bob, { automationId: 'a1' })).toEqual({ kind: 'automation', automationId: 'a1', for: bob.user! })
    expect(attributionOf(HOST_ACTOR)).toEqual({ kind: 'system' })
    expect(attributionOf(HOST_ACTOR, { sessionId: 's1', provider: 'claude-code' })).toEqual({ kind: 'agent', sessionId: 's1', provider: 'claude-code' })
  })
})

describe('SolusServer.handle', () => {
  test('resolves the actor once, before the handler runs, for every call', async () => {
    const server = new SolusServer()
    const seen: HandlerCtx[] = []
    server.register('listAttention', (_args, ctx) => {
      seen.push(ctx)
      return []
    })
    await server.handle('listAttention', [], { clientId: 'ws:bob', principal: BOB })
    await server.handle('listAttention', [], { clientId: 'internal', principal: { kind: 'system' } })
    expect(seen.map((ctx) => ctx.actor.user?.displayName ?? null)).toEqual(['Bob', null])
    expect(seen[0]?.actor.principal).toBe(BOB)
  })
})
