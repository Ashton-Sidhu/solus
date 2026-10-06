import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountSession } from '@solus/desktop-main/account/account-session'
import { AccountStore } from '@solus/desktop-main/account/account-store'
import { FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS } from '@solus/contracts/uplink'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function world() {
  const directory = mkdtempSync(join(tmpdir(), 'solus-account-grants-'))
  directories.push(directory)
  const store = new AccountStore(join(directory, 'account.bin'), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  })
  store.save({ sessionToken: 'session', profile: { id: 'user', email: 'a@b.co', name: 'Ada', avatarUrl: null }, cloudOrigin: 'https://app.solus.sh', signedInAt: 0, lastVerifiedAt: 0 })
  let now = 0
  let requests = 0
  let grantGate: Promise<void> | undefined
  let verifyStatus = 200
  const session = new AccountSession({
    cloudOrigin: 'https://app.solus.sh', store, now: () => now,
    fetch: (async (input) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/access-token')) {
        const token = `grant-${++requests}`
        await grantGate
        return Response.json({ accessToken: token, hostId: path.split('/')[3], expiresAt: now + FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS * 1000 })
      }
      if (path === '/api/account/me') return Response.json({ id: 'user', email: 'a@b.co', name: 'Ada', avatarUrl: null }, { status: verifyStatus })
      return Response.json({})
    }) as typeof fetch,
    sleep: async () => {}, openExternal: async () => {}, deviceLabel: () => 'Desktop', onStateChange: () => {},
  })
  return { session, count: () => requests, advance: (ms: number) => { now += ms }, gate: (value: Promise<void>) => { grantGate = value }, revoke: () => { verifyStatus = 401 } }
}

describe('desktop account grants', () => {
  test('the owner callback and desktop windows share one acquisition across reconnects and profile verification', async () => {
    const w = world()
    const [owner, window] = await Promise.all([w.session.acquireHostAccessToken('host'), w.session.acquireHostAccessToken('host')])
    expect(owner?.accessToken).toBe('grant-1')
    expect(window).toEqual(owner)
    await w.session.verify('retry')
    w.advance(7 * 60 * 60 * 1000)
    expect(await w.session.acquireHostAccessToken('host')).toEqual(owner)
    expect(w.count()).toBe(1)
    w.advance(60 * 60 * 1000)
    expect((await w.session.acquireHostAccessToken('host'))?.accessToken).toBe('grant-2')
  })

  test('scope changes and a host refusal obtain distinct grants', async () => {
    const w = world()
    await w.session.acquireHostAccessToken('host', 'org-a')
    await w.session.acquireHostAccessToken('host', 'org-b')
    await w.session.acquireHostAccessToken('other-host', 'org-a')
    expect((await w.session.acquireHostAccessToken('host', 'org-a', { fresh: true }))?.accessToken).toBe('grant-4')
    expect(w.count()).toBe(4)
  })

  test('sign-out discards an acquisition already in flight', async () => {
    const w = world()
    let finish!: () => void
    w.gate(new Promise<void>((resolve) => { finish = resolve }))
    const pending = w.session.acquireHostAccessToken('host')
    await w.session.signOut()
    finish()
    expect(await pending).toBeNull()
    expect(await w.session.acquireHostAccessToken('host')).toBeNull()
  })

  test('revocation clears a cached grant', async () => {
    const w = world()
    await w.session.acquireHostAccessToken('host')
    w.revoke()
    await w.session.verify('retry')
    expect(await w.session.acquireHostAccessToken('host')).toBeNull()
    expect(w.session.current()).toEqual({ kind: 'invalid', reason: 'revoked' })
  })
})
