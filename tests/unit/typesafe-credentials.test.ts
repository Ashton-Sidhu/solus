import { afterAll, afterEach, expect, test } from 'bun:test'
import { HOST_IDENTITY } from '@solus/server/execution/seats/acting-identity'
import { useHostUser } from '@solus/server/host/host-user'
import { setTypeSafeApiKey, typeSafeKeyStatus } from '@solus/server/typesafe/credentials'
import { getTypeSafe, TypeSafeKeyMissingError } from '@solus/server/typesafe/index'
import { withActingScope } from '@solus/server/vault/acting-scope'
import { AccountReads } from '@solus/server/vault/account-reads'
import { useVault, Vault } from '@solus/server/vault/vault'
import { memorySecretStore } from './integrations/memory-secrets'

// docs/plans/cloud-vault.md §2.5: a TypeSafe key is a person's credential, read
// through the vault in the acting person's scope. The host's user keeps theirs on
// their own machine until the host is linked to their account; signed in, theirs
// and every member's is in their account; a guest has none; no key is the host's
// as a whole.

const previousKey = process.env.TYPESAFE_API_KEY
delete process.env.TYPESAFE_API_KEY
const secrets = memorySecretStore()
/** The account vault: alice's key, and nothing for anyone else. */
const accountKeys = new Map([['alice', 'alice-account-key']])
const reads = new AccountReads({
  origin: () => 'https://cloud.test',
  delegations: () => ({ holders: () => [{ userId: 'alice', scope: 'personal' }, { userId: 'bob', scope: 'personal' }], accessToken: async (userId) => `delegated-${userId}` }),
  fetchImpl: async (_input, init) => {
    const userId = new Headers(init?.headers).get('authorization')?.replace('Bearer delegated-', '') ?? ''
    const key = accountKeys.get(userId)
    return key ? Response.json({ key }) : Response.json({ error: 'not_connected' }, { status: 404 })
  },
})
useVault(new Vault({ secrets, reads }))

afterEach(() => {
  useHostUser(null)
  delete process.env.TYPESAFE_API_KEY
})

afterAll(() => {
  useVault(null)
  if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = previousKey
})

const as = <T>(personKey: string | null, fn: () => T): T => withActingScope({ identity: HOST_IDENTITY, personKey }, fn)

test('the host user keeps their key on their own machine before the link, and the launching shell\'s key counts only then', async () => {
  useHostUser({ localId: 'mac' })
  await expect(as('local:mac', () => getTypeSafe())).rejects.toThrow('Add a TypeSafe API key in Settings')
  as('local:mac', () => setTypeSafeApiKey('owner-synthetic-key'))
  expect(secrets.values.get('typesafe')).toBe(JSON.stringify({ key: 'owner-synthetic-key' }))
  expect(await as('local:mac', () => typeSafeKeyStatus())).toEqual({ location: 'host', source: 'saved' })
  await expect(as('local:mac', () => getTypeSafe())).resolves.toBeDefined()
  as('local:mac', () => setTypeSafeApiKey(null))
  expect(secrets.values.has('typesafe')).toBe(false)
  process.env.TYPESAFE_API_KEY = 'shell-synthetic-key'
  expect(await as('local:mac', () => typeSafeKeyStatus())).toEqual({ location: 'host', source: 'environment' })
})

test('signed in, the host user reads their account\'s key, never the shell\'s, and cannot save one on the host', async () => {
  // WHY: signed in means the account; every host of theirs reads the same key.
  useHostUser({ localId: 'mac', account: { accountId: 'alice' } })
  process.env.TYPESAFE_API_KEY = 'shell-synthetic-key'
  expect(await as('alice', () => typeSafeKeyStatus())).toEqual({ location: 'account', source: 'saved' })
  expect(() => as('alice', () => setTypeSafeApiKey('host-copy'))).toThrow()
  expect(secrets.values.has('typesafe')).toBe(false)
})

test('a member never reads the host user\'s key or the host\'s shell key; theirs is in their account', async () => {
  // WHY: before, one host-wide key served every person's Ask Jev and Auto routing.
  useHostUser({ localId: 'mac' })
  as('local:mac', () => setTypeSafeApiKey('owner-synthetic-key'))
  process.env.TYPESAFE_API_KEY = 'shell-synthetic-key'
  expect(await as('bob', () => typeSafeKeyStatus())).toEqual({ location: 'account', source: null })
  const missing = as('bob', () => getTypeSafe())
  await expect(missing).rejects.toBeInstanceOf(TypeSafeKeyMissingError)
  await expect(missing).rejects.toThrow('Add your TypeSafe key in your Solus account.')
  // The host does not store a member's key.
  expect(() => as('bob', () => setTypeSafeApiKey('bob-synthetic-key'))).toThrow()
  expect(secrets.values.get('typesafe')).toBe(JSON.stringify({ key: 'owner-synthetic-key' }))
  as('local:mac', () => setTypeSafeApiKey(null))
})

test('a guest has no key, not even the shell\'s', async () => {
  process.env.TYPESAFE_API_KEY = 'shell-synthetic-key'
  expect(await as('guest:maya', () => typeSafeKeyStatus())).toEqual({ location: 'none', source: null })
  await expect(as('guest:maya', () => getTypeSafe())).rejects.toBeInstanceOf(TypeSafeKeyMissingError)
  expect(() => as('guest:maya', () => setTypeSafeApiKey('maya-synthetic-key'))).toThrow()
})

test('a blank key is refused', () => {
  useHostUser({ localId: 'mac' })
  expect(() => as('local:mac', () => setTypeSafeApiKey('  '))).toThrow()
})
