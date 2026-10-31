import { describe, expect, test } from 'bun:test'
import { WebTokenSession } from '@solus/client-core/web-token-session'
import { webCloudAccount } from '@solus/client-core/cloud-account'
import { webSettingsRequests } from '@solus/client-core/settings-requests'
import { webUplinkAccountSource } from '@solus/client-core/uplink-session'
import { WEB_TOKENS_PATH, type DirectoryResponse } from '@solus/contracts/uplink'
import { PERSONAL_SETTINGS_SCHEMA_VERSION } from '@solus/contracts/settings'

// docs/plans/fast-secure-startup.md: the first token answer of a website session carries
// what the sign-in read (the account, the settings, the directory), so the page's first
// reads cost no request. A late reader, or a write, reads current state instead.

const ORIGIN = 'https://app.example'
const LOGIN_DIRECTORY: DirectoryResponse = {
  hosts: [{ hostId: 'host-1', installationId: 'install-1', label: 'Laptop', routes: [], kind: 'personal', category: 'personal', organizationIds: [] }],
  workspaces: [],
}
const CURRENT_DIRECTORY: DirectoryResponse = { hosts: [{ ...LOGIN_DIRECTORY.hosts[0]!, label: 'Renamed laptop' }], workspaces: [] }

function world(options: { wrongAccount?: boolean; malformedSettings?: boolean; startupDirectory?: DirectoryResponse; noStartup?: boolean } = {}) {
  let now = 1_000_000
  const calls: Array<{ path: string; method: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname === WEB_TOKENS_PATH) {
      return Response.json({
        serversToken: { token: 'servers-token', expiresAt: now + 3_600_000 },
        hosts: [],
        ...(options.noStartup ? {} : {
          startup: {
            account: { userId: options.wrongAccount ? 'other' : 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: null },
            settings: { schemaVersion: PERSONAL_SETTINGS_SCHEMA_VERSION, generation: 0, revision: 1, settings: { fontFamily: options.malformedSettings ? 7 : 'geist' }, updatedAt: 1 },
            ...(options.startupDirectory ? { directory: options.startupDirectory } : {}),
          },
        }),
      })
    }
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' })
    if (url.pathname === '/v1/account') return Response.json({ userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: { login: 'updated' } })
    if (url.pathname === '/v1/hosts' && (init?.method ?? 'GET') === 'GET') return Response.json(CURRENT_DIRECTORY)
    if (url.pathname === '/v1/account/settings') return Response.json({ schemaVersion: PERSONAL_SETTINGS_SCHEMA_VERSION, generation: 0, revision: 2, settings: { fontFamily: 'inter' }, updatedAt: 2 })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  const session = new WebTokenSession({
    origin: ORIGIN,
    identity: { sub: 'user-1', email: 'a@example.test', emailVerified: true, name: null, picture: null },
    signedInAt: 1,
    fetch: fetchImpl,
    now: () => now,
    onSignedOut: () => {},
  })
  session.start([])
  return {
    session, calls,
    advance: (ms: number) => { now += ms },
    account: webCloudAccount(ORIGIN, session, fetchImpl),
    settings: webSettingsRequests(ORIGIN, session, fetchImpl),
    uplink: webUplinkAccountSource(ORIGIN, session, fetchImpl),
  }
}

/** Lets the boot's token request answer before a test acts. */
const answered = (w: ReturnType<typeof world>) => w.session.accessToken({ kind: 'account' })

describe('login startup data', () => {
  test('initial account and settings reads make no requests, and later reads fetch current state', async () => {
    const w = world()
    const [account, settings] = await Promise.all([w.account.readAccount(), w.settings.accountSettingsGet()])
    expect(account?.github).toBeNull()
    expect(settings).toMatchObject({ kind: 'ok', settings: { revision: 1, settings: { fontFamily: 'geist' } } })
    expect(w.calls).toEqual([])
    expect((await w.account.readAccount())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2, settings: { fontFamily: 'inter' } } })
    expect(w.calls.map(call => call.path)).toEqual(['/v1/account', '/v1/account/settings'])
  })

  test('a delayed first reader fetches current data instead of an old login snapshot', async () => {
    const w = world()
    await answered(w)
    w.advance(31_000)
    expect((await w.account.readAccount())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(w.calls).toHaveLength(2)
  })

  test('sign-out clears unused snapshots', async () => {
    const w = world()
    await answered(w)
    await w.session.signOut()
    expect(w.session.takeStartupAccount()).toBeNull()
    expect(await w.session.takeStartupSettings()).toBeNull()
  })

  test('does not apply a startup account for another person than the shell names', async () => {
    const w = world({ wrongAccount: true })
    await answered(w)
    expect(w.session.takeStartupAccount()).toBeNull()
    expect(await w.session.takeStartupSettings()).toBeNull()
  })

  test('reports malformed settings without fetching a replacement on that read', async () => {
    const w = world({ malformedSettings: true })
    expect(await w.settings.accountSettingsGet()).toEqual({ kind: 'error', code: 'invalid_response', message: null })
    expect(w.calls).toEqual([])
  })

  test('a write before the first settings read discards the login snapshot', async () => {
    const w = world()
    await answered(w)
    await w.settings.accountSettingsPatch({ generation: 0, expectedRevision: 1, set: { fontFamily: 'inter' }, reset: [] })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(w.calls.map(call => call.method)).toEqual(['PATCH', 'GET'])
  })
})

describe('login startup directory', () => {
  test('the first directory read makes no request, and the next one asks GET /v1/hosts', async () => {
    const w = world({ startupDirectory: LOGIN_DIRECTORY })
    expect(await w.uplink.listDirectory()).toEqual({ directoryUrl: ORIGIN, ...LOGIN_DIRECTORY })
    expect(w.calls).toEqual([])
    expect((await w.uplink.listDirectory())?.hosts[0]!.label).toBe('Renamed laptop')
    expect(w.calls).toEqual([{ path: '/v1/hosts', method: 'GET' }])
  })

  test('a delayed first read asks the network instead of using the login directory', async () => {
    const w = world({ startupDirectory: LOGIN_DIRECTORY })
    await answered(w)
    w.advance(31_000)
    expect((await w.uplink.listDirectory())?.hosts[0]!.label).toBe('Renamed laptop')
    expect(w.calls).toHaveLength(1)
  })

  test('a write before the first read discards the login directory', async () => {
    const w = world({ startupDirectory: LOGIN_DIRECTORY })
    await answered(w)
    await w.uplink.removeHost('host-1')
    expect((await w.uplink.listDirectory())?.hosts[0]!.label).toBe('Renamed laptop')
    expect(w.calls.map(call => call.method)).toEqual(['DELETE', 'GET'])
  })

  test('a later answer of the session carries no startup data, and the first read asks the network', async () => {
    const w = world({ noStartup: true })
    expect((await w.uplink.listDirectory())?.hosts[0]!.label).toBe('Renamed laptop')
    expect(w.calls).toEqual([{ path: '/v1/hosts', method: 'GET' }])
  })
})
