import { describe, expect, test } from 'bun:test'
import { HOST_CREDENTIALS_KEY, localStorageCredentials } from '@solus/client-core/host-credentials'

// plans/033 §4.1: the device keeps one credential per host. Decoding is forgiving
// per entry, because a credential is the one thing a wipe of the list cannot restore.

function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) }
}

const good = (hostId: string) => ({ hostId, token: `token-${hostId}`, routes: [{ kind: 'lan', url: `http://${hostId}.lan:3000`, source: 'pairing', seenAt: 1 }] })

describe('credentials in device storage', () => {
  test('an unreadable entry is deleted and treated as a miss', async () => {
    // WHY: a poison entry would be read, and fail, on every boot.
    const storage = memoryStorage()
    storage.values.set(HOST_CREDENTIALS_KEY, '{not json')
    expect((await localStorageCredentials(() => storage).read()).size).toBe(0)
    expect(storage.values.has(HOST_CREDENTIALS_KEY)).toBe(false)
  })

  test('an entry this build cannot read drops alone; the others and the stored text stay', async () => {
    const storage = memoryStorage()
    storage.values.set(HOST_CREDENTIALS_KEY, JSON.stringify([good('a'), { token: 'no host id' }, { ...good('b'), identityKey: 42, futureField: true }]))
    const credentials = await localStorageCredentials(() => storage).read()
    expect([...credentials.keys()]).toEqual(['a', 'b'])
    expect(credentials.get('b')).toEqual({ token: 'token-b', routes: good('b').routes })
    expect(storage.values.has(HOST_CREDENTIALS_KEY)).toBe(true)
  })

  test('a write and a remove change one host; the last remove clears the entry', async () => {
    const storage = memoryStorage()
    const credentials = localStorageCredentials(() => storage)
    await credentials.write('a', { token: 't', routes: [], tokenPairedOverHttps: true })
    await credentials.write('b', { token: 'u', routes: [] })
    await credentials.remove('a')
    expect([...(await credentials.read()).keys()]).toEqual(['b'])
    await credentials.remove('b')
    expect(storage.values.has(HOST_CREDENTIALS_KEY)).toBe(false)
  })

  test('the hosts and workspaces a device kept before plan 033 are deleted, not read', async () => {
    // WHY: §2 rule 5 — no migration, and no host data left on the device.
    const storage = memoryStorage()
    storage.values.set('solus.servers', JSON.stringify([{ id: 'old', sessionToken: 'old-token' }]))
    storage.values.set('solus.workspaces', '[]')
    expect((await localStorageCredentials(() => storage).read()).size).toBe(0)
    expect([...storage.values.keys()]).toEqual([])
  })

  test('with no device storage, there is nothing and nothing throws', async () => {
    const credentials = localStorageCredentials(() => null)
    expect((await credentials.read()).size).toBe(0)
    await credentials.write('a', { token: 't', routes: [] })
  })
})
