import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

// The dispatch-checkout layout module reaches the database; this Bun has no
// `node:sqlite`. The real module is loaded so the mock below can keep every
// export but the one this test scripts.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const dispatchCheckouts = await import('@solus/server/project-config/dispatch-checkouts')

// Captured as a value before the mock lands: every command that is not `gh`
// still runs for real, so a file sharing this process can still run git.
const exec = await import('@solus/server/git/exec')
const realRunAsync = exec.runAsync

/**
 * Which credentials a GitHub request may use, and in what order.
 *
 * The stores behind the chain read the keyring and spawn `gh`, so each is
 * replaced with scripted state here. The mocks are process-wide, so every one
 * carries its module's whole export surface.
 */

const state = {
  hostToken: null as string | null,
  delegations: new Map<string, string>(),
  checkoutDeviceId: null as string | null,
  ghTokens: new Map<string, string>(),
  ghCalls: [] as string[][],
}

mock.module('@solus/server/providers/github/token-store', () => ({
  loadToken: () => (state.hostToken ? { accessToken: state.hostToken, scope: 'repo' } : null),
  persistToken: () => {},
  clearToken: () => {
    state.hostToken = null
  },
  EncryptionUnavailableError: class extends Error {},
}))

mock.module('@solus/server/providers/github/delegation-store', () => ({
  loadDelegation: (deviceId: string) => {
    const accessToken = state.delegations.get(deviceId)
    return accessToken ? { accessToken } : null
  },
  saveDelegation: () => {},
  clearDelegation: () => {},
}))

mock.module('@solus/server/project-config/dispatch-checkouts', () => ({
  ...dispatchCheckouts,
  dispatchCheckoutDeviceId: () => state.checkoutDeviceId,
}))

mock.module('@solus/server/git/exec', () => ({
  ...exec,
  runAsync: async (bin: string, args: string[], cwd: string, opts?: Parameters<typeof realRunAsync>[3]) => {
    if (bin !== 'gh') return realRunAsync(bin, args, cwd, opts)
    state.ghCalls.push([bin, ...args])
    const host = args[args.indexOf('--hostname') + 1] ?? ''
    const token = state.ghTokens.get(host)
    if (!token) throw new Error('gh: not logged in to any hosts')
    return token
  },
}))

const { githubCredentialChain } = await import('@solus/server/providers/github/credentials')

// Each test names its own host: the answer from `gh` is cached per host, so a
// shared one would read the previous test's state.
describe('which credentials a GitHub request may use', () => {
  test('the host connection leads and gh follows', async () => {
    state.hostToken = 'host-token'
    state.ghTokens.set('one.example', 'gh-token')

    expect(await githubCredentialChain('one.example')).toEqual([
      { source: 'host', token: 'host-token' },
      { source: 'gh-cli', token: 'gh-token' },
    ])
    expect(state.ghCalls.at(-1)).toEqual(['gh', 'auth', 'token', '--hostname', 'one.example'])
  })

  test('a dispatch checkout puts its paired device first', async () => {
    // WHY: that checkout commits and pushes as the device, so its API calls
    // must be the device's too — creating a pull request as the host owner
    // would file the client's work under the wrong account.
    state.hostToken = 'host-token'
    state.checkoutDeviceId = 'device-1'
    state.delegations.set('device-1', 'device-token')

    const chain = await githubCredentialChain('two.example', '/checkouts/device-1/app')

    expect(chain.map((credential) => credential.source)).toEqual(['delegated', 'host'])
    expect(chain[0]?.token).toBe('device-token')
    state.checkoutDeviceId = null
  })

  test('a missing or signed-out gh is absent, not an error', async () => {
    state.hostToken = 'host-token'

    expect(await githubCredentialChain('three.example')).toEqual([{ source: 'host', token: 'host-token' }])
  })

  test('nothing at all is an empty chain', async () => {
    state.hostToken = null

    expect(await githubCredentialChain('four.example')).toEqual([])
  })

  test('gh is asked once per host for a while, not once per request', async () => {
    // WHY: a page of reads is many requests. Spawning `gh` for each was the
    // cost that made the old CLI path slow.
    state.ghTokens.set('five.example', 'gh-token')

    await githubCredentialChain('five.example')
    await githubCredentialChain('five.example')

    expect(state.ghCalls.filter((call) => call.includes('five.example'))).toHaveLength(1)
  })
})
