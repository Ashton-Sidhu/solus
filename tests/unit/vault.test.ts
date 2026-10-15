import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { adoptProvisionedRegistration, resetHostCategoryForTests } from '@solus/server/host/host-category'
import { useHostUser } from '@solus/server/host/host-user'
import { AccountReads } from '@solus/server/vault/account-reads'
import { credentialLocationOf, TYPESAFE_REF, Vault, type McpCredentialRef } from '@solus/server/vault/vault'
import { typesafeDeliverySchema } from '@solus/contracts/vault'
import { memorySecretStore } from './integrations/memory-secrets'

// docs/plans/access-model.md §2.6 and docs/plans/cloud-vault.md §2.5: a caller
// names a person and a credential ref, and the vault alone decides where the
// credential is. Signed in means the account: the host's user once the host is
// linked to them, and every member. These tests pin that rule and the one client
// every account read and upload goes through.

const LINEAR: McpCredentialRef = { kind: 'mcp', integrationId: 'int-linear', serverUrl: 'https://linear.example/mcp' }
const TOKEN = { accessToken: 'host-key', tokenType: 'api-key' }
const GITHUB = { kind: 'provider', provider: 'github' } as const
const githubSchema = z.object({ accessToken: z.string(), scope: z.string() })

afterEach(() => {
  useHostUser(null)
  resetHostCategoryForTests()
})

/** A vault on a host that acts for alice; every account call carries her delegated token as the bearer (ADR 0001 §2.2 rule 7). */
function vaultWith(options: { answer?: (request: Request) => Promise<Response> } = {}) {
  const requests: Request[] = []
  const now = { at: 1_000_000 }
  const secrets = memorySecretStore()
  const reads = new AccountReads({
    origin: () => 'https://cloud.test',
    delegations: () => ({ holders: () => [{ userId: 'alice', scope: 'personal' }], accessToken: async () => 'alice-delegated' }),
    fetchImpl: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return (options.answer ?? (async () => Response.json({})))(request)
    },
  })
  const vault = new Vault({ reads, secrets, now: () => now.at })
  return { vault, requests, now, secrets }
}

describe('where a credential is', () => {
  test('by person kind, link, and host kind', () => {
    // The host's own work, and the host's user before the link: this host.
    useHostUser({ localId: 'mac' })
    expect(credentialLocationOf(null)).toEqual({ kind: 'host' })
    expect(credentialLocationOf('local:mac')).toEqual({ kind: 'host' })
    // WHY: signed in means the account. Once the host is linked to its user, their logins are their account's, not the machine's.
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    expect(credentialLocationOf('alice')).toEqual({ kind: 'account', accountId: 'alice' })
    // A member: their account. A guest, or a local key that is not the host's user: nowhere (D1).
    expect(credentialLocationOf('bob')).toEqual({ kind: 'account', accountId: 'bob' })
    expect(credentialLocationOf('guest:maya')).toEqual({ kind: 'none' })
    expect(credentialLocationOf('local:other')).toEqual({ kind: 'none' })
    adoptProvisionedRegistration({ organizationId: 'org' })
    expect(credentialLocationOf('alice')).toEqual({ kind: 'account', accountId: 'alice' })
  })
})

describe('a login: GitHub, Google, Atlassian, TypeSafe', () => {
  test('the host user before the link reads and writes this host; once linked, the account, with the contract ref', async () => {
    const { vault, requests } = vaultWith({ answer: async () => Response.json({ accessToken: 'from-account', scope: 'repo' }) })
    useHostUser({ localId: 'mac' })
    vault.save('local:mac', GITHUB, { accessToken: 'on-host', scope: 'repo' })
    expect(await vault.read('local:mac', GITHUB, githubSchema)).toEqual({ accessToken: 'on-host', scope: 'repo' })
    expect(requests).toEqual([])

    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    expect(await vault.read('alice', GITHUB, githubSchema)).toEqual({ accessToken: 'from-account', scope: 'repo' })
    expect(requests[0].url).toBe('https://cloud.test/v1/vault/read')
    expect(requests[0].headers.get('authorization')).toBe('Bearer alice-delegated')
    expect(await requests[0].json()).toEqual({ ref: GITHUB })
    // WHY: a provider token belongs to the client that issued it, so a signed-in person changes it only on the website.
    expect(() => vault.save('alice', GITHUB, { accessToken: 'x', scope: '' })).toThrow('account website')
  })

  test('not connected reads null; a refused refresh asks the person to sign in again', async () => {
    let status = 404
    const { vault } = vaultWith({ answer: async () => Response.json({ error: 'x' }, { status }) })
    expect(await vault.read('alice', TYPESAFE_REF, typesafeDeliverySchema)).toBeNull()
    status = 409
    await expect(vault.read('alice', TYPESAFE_REF, typesafeDeliverySchema)).rejects.toThrow('sign in again')
  })
})

describe('link and unlink', () => {
  test('at the link the TypeSafe key moves into the account and every host login goes', async () => {
    const { vault, requests, secrets } = vaultWith({ answer: async () => Response.json({ version: 1 }, { status: 201 }) })
    useHostUser({ localId: 'mac' })
    vault.save('local:mac', TYPESAFE_REF, { key: 'ts-key' })
    vault.save('local:mac', GITHUB, { accessToken: 'gh', scope: 'repo' })
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    await vault.settleLinked('alice')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('PUT')
    expect(requests[0].url).toBe('https://cloud.test/v1/vault/credential')
    expect(await requests[0].json()).toEqual({ ref: { kind: 'typesafe' }, material: { kind: 'key', key: 'ts-key' }, expectedVersion: null, label: null })
    expect(secrets.values.size).toBe(0)
  })

  test('a key the account already holds wins, and the host copy still goes; an unreachable cloud keeps it for the next try', async () => {
    let answer = (): Response => Response.json({ error: 'credential_held', currentVersion: 3 }, { status: 409 })
    const { vault, secrets } = vaultWith({ answer: async () => answer() })
    useHostUser({ localId: 'mac' })
    vault.save('local:mac', TYPESAFE_REF, { key: 'ts-key' })
    useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
    answer = () => { throw new Error('ECONNREFUSED') }
    await vault.settleLinked('alice')
    expect(secrets.values.size).toBe(1)
    answer = () => Response.json({ error: 'credential_held', currentVersion: 3 }, { status: 409 })
    await vault.settleLinked('alice')
    expect(secrets.values.size).toBe(0)
  })

  test('at the unlink the host keeps nothing for the person', () => {
    const { vault, secrets } = vaultWith()
    useHostUser({ localId: 'mac' })
    vault.save('local:mac', GITHUB, { accessToken: 'gh', scope: 'repo' })
    vault.save('local:mac', TYPESAFE_REF, { key: 'ts' })
    vault.save('alice', LINEAR, TOKEN)
    vault.forgetPerson('alice', [LINEAR.integrationId])
    expect(secrets.values.size).toBe(0)
  })

  test('a person\'s MCP tokens follow them to a new key, and a token the new key holds wins', async () => {
    // WHY: linking moves the owner from their local key to their account; their
    // MCP sign-ins go with them until the reconcile moves them into the account.
    const { vault } = vaultWith({ answer: async () => Response.json({ error: 'not_connected' }, { status: 404 }) })
    const other: McpCredentialRef = { kind: 'mcp', integrationId: 'int-sentry', serverUrl: 'https://sentry.example/mcp' }
    vault.save('local:owner', LINEAR, { accessToken: 'moves', tokenType: 'Bearer' })
    vault.save('local:owner', other, { accessToken: 'old', tokenType: 'Bearer' })
    vault.save('acct-owner', other, { accessToken: 'kept', tokenType: 'Bearer' })
    vault.move('local:owner', 'acct-owner', [LINEAR.integrationId, other.integrationId])
    expect(await vault.read('acct-owner', LINEAR)).toMatchObject({ token: { accessToken: 'moves' } })
    expect(await vault.read('acct-owner', other)).toMatchObject({ token: { accessToken: 'kept' } })
    expect(await vault.read('local:owner', LINEAR)).toBeNull()
  })
})

describe('an MCP credential', () => {
  test('on the host, each person reads only their own token', async () => {
    const { vault } = vaultWith()
    useHostUser({ localId: 'mac' })
    vault.save('local:mac', LINEAR, TOKEN)
    expect(await vault.read('local:mac', LINEAR)).toEqual({ location: 'host', token: TOKEN })
    expect(vault.remove('local:mac', LINEAR)).toEqual(TOKEN)
    expect(await vault.read('local:mac', LINEAR)).toBeNull()
  })

  test('a guest and the host\'s own work have no MCP credentials (D1)', async () => {
    // WHY: a guest's turn runs on the sharer's seat; it must not act with any credential.
    const { vault, secrets, requests } = vaultWith()
    expect(() => vault.save('guest:maya', LINEAR, TOKEN)).toThrow('not a guest')
    expect(() => vault.save(null, LINEAR, TOKEN)).toThrow('not a guest')
    expect(await vault.read('guest:maya', LINEAR)).toBeNull()
    expect(await vault.read(null, LINEAR)).toBeNull()
    expect(vault.remove('guest:maya', LINEAR)).toBeNull()
    expect(secrets.values.size).toBe(0)
    expect(requests).toEqual([])
  })

  test('a person with an account reads it from the account by the server address alone', async () => {
    const { vault, requests } = vaultWith({ answer: async () => Response.json({ authorization: 'Bearer cloud', expiresAt: null, label: null }) })
    expect(await vault.read('alice', LINEAR)).toEqual({ location: 'account', read: { kind: 'ok', delivery: { authorization: 'Bearer cloud', expiresAt: null, label: null } } })
    expect(requests).toHaveLength(1)
    expect(await requests[0].json()).toEqual({ ref: { kind: 'mcp', serverUrl: LINEAR.serverUrl } })
  })

  test('a delivered token is cached until a minute before it expires, then read again', async () => {
    const subject = vaultWith({ answer: async () => Response.json({ authorization: 'Bearer t1', expiresAt: subject.now.at + 120_000, label: 'Alice' }) })
    const { vault, requests, now } = subject
    expect(await vault.read('alice', LINEAR)).toMatchObject({ location: 'account', read: { kind: 'ok', delivery: { authorization: 'Bearer t1' } } })
    expect(await vault.read('alice', LINEAR)).toMatchObject({ read: { kind: 'ok' } })
    expect(requests).toHaveLength(1)
    now.at += 61_000
    await vault.read('alice', LINEAR)
    expect(requests).toHaveLength(2)
  })

  test('not connected, a refused refresh, and an unreachable cloud are told apart, and the cache answers while the cloud is down', async () => {
    let mode: 'ok' | 'gone' | 'refused' | 'down' = 'ok'
    const subject = vaultWith({
      answer: async () => {
        if (mode === 'down') throw new Error('ECONNREFUSED')
        if (mode === 'gone') return Response.json({ error: 'not_connected' }, { status: 404 })
        if (mode === 'refused') return Response.json({ error: 'reconnect_required' }, { status: 409 })
        return Response.json({ authorization: 'Bearer t1', expiresAt: subject.now.at + 120_000, label: null })
      },
    })
    const { vault, now } = subject
    await vault.read('alice', LINEAR)
    mode = 'down'
    now.at += 61_000
    expect(await vault.read('alice', LINEAR)).toMatchObject({ read: { kind: 'cached', delivery: { authorization: 'Bearer t1' } } })
    now.at += 60_000
    expect(await vault.read('alice', LINEAR)).toEqual({ location: 'account', read: { kind: 'unreachable' } })
    mode = 'gone'
    expect(await vault.read('alice', LINEAR)).toEqual({ location: 'account', read: { kind: 'not-connected' } })
    mode = 'refused'
    expect(await vault.read('alice', LINEAR)).toEqual({ location: 'account', read: { kind: 'reconnect-required' } })
  })

  // WHY: after sign-out the host must not go on with a credential the ended delegation brought (ADR 0001 rule 5).
  test('a cleared cache answers nothing, not even while the cloud is down', async () => {
    let down = false
    const subject = vaultWith({
      answer: async () => {
        if (down) throw new Error('ECONNREFUSED')
        return Response.json({ authorization: 'Bearer t1', expiresAt: subject.now.at + 3_600_000, label: null })
      },
    })
    await subject.vault.read('alice', LINEAR)
    subject.vault.forgetAll()
    down = true
    expect(await subject.vault.read('alice', LINEAR)).toEqual({ location: 'account', read: { kind: 'unreachable' } })
    expect(subject.requests).toHaveLength(2)
  })

  test('a person this host does not act for is read for nobody: nothing is sent', async () => {
    const { vault, requests } = vaultWith()
    expect(await vault.read('bob', LINEAR)).toEqual({ location: 'account', read: { kind: 'no-executor' } })
    expect(requests).toEqual([])
  })

  test('the reconcile\'s upload answers uploaded, held, or refused by the cloud\'s status', async () => {
    const answers: Response[] = [
      Response.json({ version: 1 }, { status: 201 }),
      Response.json({ error: 'credential_held', currentVersion: 2 }, { status: 409 }),
      Response.json({ error: 'credential_refused' }, { status: 422 }),
    ]
    const { vault, requests } = vaultWith({ answer: async () => answers.shift()! })
    const material = { kind: 'key', key: 'k', scheme: 'bearer' } as const
    expect(await vault.upload('alice', LINEAR, material, 'Alice')).toEqual({ kind: 'uploaded', version: 1 })
    expect(await vault.upload('alice', LINEAR, material, null)).toEqual({ kind: 'held', currentVersion: 2 })
    expect(await vault.upload('alice', LINEAR, material, null)).toEqual({ kind: 'refused' })
    expect(requests[0].method).toBe('PUT')
    expect(await requests[0].json()).toEqual({ ref: { kind: 'mcp', serverUrl: LINEAR.serverUrl }, material, expectedVersion: null, label: 'Alice' })
  })
})
