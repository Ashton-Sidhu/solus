import { describe, expect, test } from 'bun:test'
import type { AccountState } from '@solus/contracts/account-types'
import type { TokenResource } from '@solus/contracts/auth/clients'
import type { HostAccess } from '@solus/server/execution/orchestration/remote-hosts'
import type { LocalClient } from '@solus/server/transport/local-client'
import { presentAccountToLocalHost } from '@solus/desktop-main/account/local-host-client'

// docs/adr/0001-standard-authentication.md §2.2 rule 10, stage 6: desktop main is the
// account client of its own host. It presents its token there when it signs in, at
// start, and when the host asks again; it lends the host its reach to the owner's
// other hosts while signed in; and a sign-out (or a grant the website ended) takes
// both back, so the host ends what that grant made at once.

const signedIn: AccountState = { kind: 'signed-in', identity: { sub: 'alice', email: 'a@example.com', emailVerified: true, name: null, picture: null }, consoleUrl: 'https://account.test', signedInAt: 1, isStale: false }

function world(options: { state?: AccountState; hostId?: string | null } = {}) {
  let state: AccountState = options.state ?? { kind: 'signed-out' }
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
    cloudRequest: async () => null,
  }
  const presented: string[] = []
  const lent: Array<HostAccess | null> = []
  let signOuts = 0
  let wanted: (() => void) | null = null
  const host: LocalClient = {
    hostId: () => options.hostId === undefined ? 'host-1' : options.hostId,
    presentToken: async (token) => { presented.push(token) },
    signedOut: () => { signOuts += 1 },
    lendHostAccess: (access) => { lent.push(access) },
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
  return { session, host, presented, lent, asked, change, settle, signOuts: () => signOuts, askAgain: () => wanted?.() }
}

describe('desktop main as the client of its own host', () => {
  test('signing in presents a token for this host and lends the owner’s other hosts', async () => {
    const w = world()
    presentAccountToLocalHost(w.session, w.host)
    expect(w.presented).toEqual([])
    w.change(signedIn)
    await w.settle()
    expect(w.asked).toEqual([{ kind: 'host', hostId: 'host-1' }])
    expect(w.presented).toEqual(['token-for-host-1'])
    const access = w.lent.at(-1)
    if (!access) throw new Error('no host access lent')
    // The host's dial to another host gets the client's token for that host, never the account plane's.
    expect(await access.accessToken('h-book')).toBe('token-for-h-book')
    expect(await access.hosts()).toBeNull()
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

  test('an unlinked host gets no token: there is no audience for it', async () => {
    const w = world({ state: signedIn, hostId: null })
    presentAccountToLocalHost(w.session, w.host)
    w.askAgain()
    await w.settle()
    expect(w.asked).toEqual([])
    expect(w.presented).toEqual([])
  })

  test('sign-out, or a grant the website ended, takes the reach back and ends the grant’s delegations', async () => {
    for (const ended of [{ kind: 'signed-out' }, { kind: 'invalid', reason: 'revoked' }] satisfies AccountState[]) {
      const w = world({ state: signedIn })
      presentAccountToLocalHost(w.session, w.host)
      await w.settle()
      w.change(ended)
      expect(w.lent.at(-1)).toBeNull()
      expect(w.signOuts()).toBe(1)
      // The host asks again after the sign-out: nothing is presented.
      w.askAgain()
      await w.settle()
      expect(w.presented).toEqual(['token-for-host-1'])
    }
  })

  test('a desktop that starts signed out tells the host nothing', () => {
    const w = world()
    presentAccountToLocalHost(w.session, w.host)
    expect([w.lent, w.signOuts()]).toEqual([[], 0])
  })
})
