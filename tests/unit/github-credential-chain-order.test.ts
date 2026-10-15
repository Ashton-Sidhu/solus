import { describe, expect, test } from 'bun:test'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { fakeGithubCredentials } from './helpers/github-credentials'

/**
 * Which credentials a GitHub request may use, and in what order, for the
 * host's own work. The sources behind the chain read the keyring and spawn
 * `gh`, so each is scripted here.
 */

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('which credentials a GitHub request may use', () => {
  test('the host connection leads and gh follows', async () => {
    const { credentials, ghCalls } = fakeGithubCredentials({ hostToken: 'host-token', gh: new Map([['one.example', 'gh-token']]) })

    expect(await credentials.chain('one.example')).toEqual([
      { source: 'host', token: 'host-token' },
      { source: 'gh-cli', token: 'gh-token' },
    ])
    expect(ghCalls).toEqual(['one.example'])
  })

  test('a dispatch checkout puts its paired device first', async () => {
    // WHY: that checkout commits and pushes as the device, so its API calls
    // must be the device's too — creating a pull request as the host owner
    // would file the client's work under the wrong account.
    const { credentials } = fakeGithubCredentials({
      hostToken: 'host-token',
      checkoutOwner: 'device-1',
      delegations: new Map([['device-1', { accessToken: 'device-token', login: 'device' }]]),
    })

    const chain = await credentials.chain('two.example', '/checkouts/device-1/app')

    expect(chain.map((credential) => credential.source)).toEqual(['delegated', 'host'])
    expect(chain[0]?.token).toBe('device-token')
  })

  test('a missing or signed-out gh is absent, not an error', async () => {
    const { credentials } = fakeGithubCredentials({ hostToken: 'host-token' })

    expect(await credentials.chain('three.example')).toEqual([{ source: 'host', token: 'host-token' }])
  })

  test('nothing at all is an empty chain', async () => {
    const { credentials } = fakeGithubCredentials()

    expect(await credentials.chain('four.example')).toEqual([])
  })

  test('gh is asked once per host for a while, not once per request', async () => {
    // WHY: a page of reads is many requests. Spawning `gh` for each was the
    // cost that made the old CLI path slow.
    const { credentials, ghCalls } = fakeGithubCredentials({ gh: new Map([['five.example', 'gh-token']]) })

    await credentials.chain('five.example')
    await credentials.chain('five.example')

    expect(ghCalls).toEqual(['five.example'])
  })
})
