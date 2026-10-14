import { describe, expect, test } from 'bun:test'
import type { AccountState } from '@solus/contracts/account-types'
import type { TokenResource } from '@solus/contracts/auth/clients'
import type { HostOwnerIdentity } from '@solus/contracts/uplink'
import type { LocalClient } from '@solus/server/transport/local-client'
import { presentAccountToLocalHost } from '@solus/desktop-main/account/local-host-client'

// docs/adr/0001-standard-authentication.md §2.2 rule 10, stage 6: desktop main is the
// account client of its own host. It presents its token there when it signs in, at
// start, and when the host asks again; it lends the host its reach to the owner's
// other hosts while signed in; and a sign-out (or a grant the website ended) takes
// both back, so the host ends what that grant made at once. Rule 8: a host that is not
// registered is registered first, with a ticket main gets with its own account token;
// the link is never asked for.

const signedIn: AccountState = { kind: 'signed-in', identity: { sub: 'alice', email: 'a@example.com', emailVerified: true, name: null, picture: null }, consoleUrl: 'https://account.test', signedInAt: 1, isStale: false }

function world(options: { state?: AccountState; hostId?: string | null; canIssueTicket?: boolean } = {}) {
  let state: AccountState = options.state ?? { kind: 'signed-out' }
  let hostId = options.hostId === undefined ? 'host-1' : options.hostId
  const registrations: Array<{ ticket: string; directoryUrl: string }> = []
  const cloudCalls: string[] = []
  const listeners = new Set<(state: AccountState) => void>()
  const asked: TokenResource[] = []
  const session = {
    cloudOrigin: 'https://account.test',
    current: () => state,
    onChange: (listener: (state: AccountState) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    accessToken: async (resource: TokenResource) => {
      asked.push(resource)
      return state.kind === 'signed-in' && resource.kind === 'host' ? `token-for-${resource.hostId}` : null
    },
    cloudRequest: async (path: string) => {
      cloudCalls.push(path)
      if (state.kind !== 'signed-in' || path !== '/v1/enrollment-tickets' || options.canIssueTicket === false) return null
      return Response.json({ ticket: 'set_desktop', expiresAt: 0 })
    },
  }
  const presented: string[] = []
  const owners: Array<HostOwnerIdentity | null> = []
  let signOuts = 0
  let wanted: (() => void) | null = null
  const host: LocalClient = {
    hostId: () => hostId,
    needsRegistration: () => hostId === null,
    register: async (request) => {
      registrations.push(request)
      hostId = 'host-new'
    },
    presentToken: async (token) => { presented.push(token) },
    presentIdentity: (owner) => { owners.push(owner) },
    signedOut: () => { signOuts += 1 },
    onTokenWanted: (listener) => {
      wanted = listener
      return () => { wanted = null }
    },
  }
  const change = (next: AccountState) => {
    state = next
    for (const listener of listeners) listener(next)
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { session, host, presented, owners, asked, change, settle, registrations, cloudCalls, signOuts: () => signOuts, askAgain: () => wanted?.() }
}

describe('desktop main as the client of its own host', () => {
  test('signing in presents a token for this host', async () => {
    const w = world()
    presentAccountToLocalHost(w.session, w.host)
    expect(w.presented).toEqual([])
    w.change(signedIn)
    await w.settle()
    expect(w.asked).toEqual([{ kind: 'host', hostId: 'host-1' }])
    expect(w.presented).toEqual(['token-for-host-1'])
  })

  test('a desktop signed in at start presents at once; a stale mark on the same sign-in presents nothing again', async () => {
    const w = world({ state: signedIn })
    presentAccountToLocalHost(w.session, w.host)
    await w.settle()
    w.change({ ...signedIn, isStale: true })
    await w.settle()
    expect(w.presented).toEqual(['token-for-host-1'])
  })

  test('the host asks again when its standing changes, and the client presents again', async () => {
    const w = world({ state: signedIn })
    presentAccountToLocalHost(w.session, w.host)
    await w.settle()
    w.askAgain()
    await w.settle()
    expect(w.presented).toEqual(['token-for-host-1', 'token-for-host-1'])
  })

  test('a host that is not registered is registered with a ticket from the desktop’s own account, then gets a token: no link', async () => {
    // WHY: the developer's desktop had no registration at the cloud, so no token had an
    // audience and the owner's account reads failed. Registration must need no tunnel.
    const w = world({ state: signedIn, hostId: null })
    presentAccountToLocalHost(w.session, w.host)
    await w.settle()
    await w.settle()
    expect(w.cloudCalls).toEqual(['/v1/enrollment-tickets'])
    expect(w.registrations).toEqual([{ ticket: 'set_desktop', directoryUrl: 'https://account.test' }])
    expect(w.asked).toEqual([{ kind: 'host', hostId: 'host-new' }])
    expect(w.presented).toEqual(['token-for-host-new'])
  })

  test('a registered host is not registered again', async () => {
    const w = world({ state: signedIn })
    presentAccountToLocalHost(w.session, w.host)
    await w.settle()
    expect(w.cloudCalls).toEqual([])
    expect(w.registrations).toEqual([])
  })

  test('with no ticket (the account did not answer) nothing is registered and no token is asked for', async () => {
    const w = world({ state: signedIn, hostId: null, canIssueTicket: false })
    presentAccountToLocalHost(w.session, w.host)
    await w.settle()
    expect(w.registrations).toEqual([])
    expect(w.asked).toEqual([])
    expect(w.presented).toEqual([])
  })

  test('sign-out, or a grant the website ended, ends the grant’s delegations', async () => {
    for (const ended of [{ kind: 'signed-out' }, { kind: 'invalid', reason: 'revoked' }] satisfies AccountState[]) {
      const w = world({ state: signedIn })
      presentAccountToLocalHost(w.session, w.host)
      await w.settle()
      w.change(ended)
      expect(w.signOuts()).toBe(1)
      // The host asks again after the sign-out: nothing is presented.
      w.askAgain()
      await w.settle()
      expect(w.presented).toEqual(['token-for-host-1'])
    }
  })

  test('the sign-in names the host’s owner, even where the host has no token audience', async () => {
    // A host with no link, or one the account plane refuses a token for, still shows
    // the account and not the machine's login name: the identity needs no token.
    const w = world({ hostId: null, canIssueTicket: false })
    presentAccountToLocalHost(w.session, w.host)
    w.change({ ...signedIn, identity: { ...signedIn.identity, name: 'Ashton Sidhu' } })
    await w.settle()
    expect(w.presented).toEqual([])
    expect(w.owners).toEqual([{ userId: 'alice', email: 'a@example.com', name: 'Ashton Sidhu' }])
  })

  test('a changed name is presented again; the same identity is not', () => {
    const w = world({ state: signedIn })
    presentAccountToLocalHost(w.session, w.host)
    w.change({ ...signedIn, isStale: true })
    w.change({ ...signedIn, identity: { ...signedIn.identity, name: 'Alice' } })
    expect(w.owners).toEqual([
      { userId: 'alice', email: 'a@example.com' },
      { userId: 'alice', email: 'a@example.com', name: 'Alice' },
    ])
  })

  test('sign-out gives the host back its local user; signing in again names the account again', () => {
    const w = world({ state: signedIn })
    presentAccountToLocalHost(w.session, w.host)
    w.change({ kind: 'signed-out' })
    w.change(signedIn)
    expect(w.owners).toEqual([{ userId: 'alice', email: 'a@example.com' }, null, { userId: 'alice', email: 'a@example.com' }])
  })

  test('a desktop that starts signed out tells the host nothing', () => {
    const w = world()
    presentAccountToLocalHost(w.session, w.host)
    expect(w.signOuts()).toBe(0)
  })
})
