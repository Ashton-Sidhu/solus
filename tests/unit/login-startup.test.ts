import { describe, expect, test } from 'bun:test'
import { OAuthSession } from '@solus/client-core/oauth-session'
import { oauthCloudAccount } from '@solus/client-core/cloud-account'
import { webSettingsRequests } from '@solus/client-core/settings-requests'
import { oauthUplinkAccountSource } from '@solus/client-core/uplink-session'
import type { DirectoryResponse } from '@solus/contracts/uplink'
import { PERSONAL_SETTINGS_SCHEMA_VERSION } from '@solus/contracts/settings'
import { fakeAccountPlane, ISSUER } from './helpers/fake-account-plane'

const LOGIN_DIRECTORY: DirectoryResponse = {
  hosts: [{ hostId: 'host-1', installationId: 'install-1', label: 'Laptop', routes: [], kind: 'personal', category: 'personal', organizationIds: [] }],
  workspaces: [],
}
const CURRENT_DIRECTORY: DirectoryResponse = { hosts: [{ ...LOGIN_DIRECTORY.hosts[0], label: 'Renamed laptop' }], workspaces: [] }

async function world(options: { wrongAccount?: boolean; malformedSettings?: boolean; startupDirectory?: DirectoryResponse } = {}) {
  const plane = fakeAccountPlane({
    startupDirectory: options.startupDirectory,
    startupAccount: { userId: options.wrongAccount ? 'other' : 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: null },
    startupSettings: { schemaVersion: PERSONAL_SETTINGS_SCHEMA_VERSION, generation: 0, revision: 1, settings: { fontFamily: 'geist' }, updatedAt: 1 },
  })
  const calls: Array<{ path: string; method: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (!url.pathname.startsWith('/v1/')) {
      const response = await plane.fetch(String(input), init)
      if (!options.malformedSettings || new URLSearchParams(String(init?.body)).get('grant_type') !== 'authorization_code') return response
      const body = await response.json()
      body.startup.settings.settings.fontFamily = 7
      return Response.json(body)
    }
    calls.push({ path: url.pathname, method: init?.method ?? 'GET' })
    if (url.pathname === '/v1/account') return Response.json({ userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: { login: 'updated' } })
    if (url.pathname === '/v1/hosts' && (init?.method ?? 'GET') === 'GET') return Response.json(CURRENT_DIRECTORY)
    if (url.pathname === '/v1/account/settings') return Response.json({ schemaVersion: PERSONAL_SETTINGS_SCHEMA_VERSION, generation: 0, revision: 2, settings: { fontFamily: 'inter' }, updatedAt: 2 })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  const session = new OAuthSession({ cloudOrigin: ISSUER, clientId: plane.clientId, store: { load: () => null, save: () => {}, clear: () => {} }, fetch: fetchImpl, now: plane.now })
  const { authorizeUrl, pending } = await session.beginSignIn('http://127.0.0.1:50000/callback')
  const outcome = await session.completeSignIn(plane.approve(authorizeUrl), pending)
  return {
    session, calls, plane, outcome,
    account: oauthCloudAccount(ISSUER, session, fetchImpl),
    settings: webSettingsRequests(ISSUER, session, fetchImpl),
    uplink: oauthUplinkAccountSource(ISSUER, session, fetchImpl),
  }
}

describe('login startup data', () => {
  test('initial account and settings reads make no requests, and later reads fetch current state', async () => {
    const w = await world()
    expect(w.outcome).toBe('approved')
    const [account, settings] = await Promise.all([w.account.readAccount(), w.settings.accountSettingsGet()])
    expect(account?.github).toBeNull()
    expect(settings).toMatchObject({ kind: 'ok', settings: { revision: 1, settings: { fontFamily: 'geist' } } })
    expect(w.calls).toEqual([])
    expect((await w.account.readAccount())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2, settings: { fontFamily: 'inter' } } })
    expect(w.calls.map(call => call.path)).toEqual(['/v1/account', '/v1/account/settings'])
  })

  test('a delayed first reader fetches current data instead of an old login snapshot', async () => {
    const w = await world()
    w.plane.advance(31_000)
    expect((await w.account.readAccount())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(w.calls).toHaveLength(2)
  })

  test('sign-out clears unused snapshots', async () => {
    const w = await world()
    await w.session.signOut()
    expect(w.session.takeStartupAccount()).toBeNull()
    expect(await w.session.takeStartupSettings()).toBeNull()
  })

  test('does not accept a startup account for another identity', async () => {
    const w = await world({ wrongAccount: true })
    expect(w.outcome).toBe('error')
    expect(w.session.takeStartupAccount()).toBeNull()
    expect(await w.session.takeStartupSettings()).toBeNull()
  })

  test('reports malformed settings without fetching a replacement on that read', async () => {
    const w = await world({ malformedSettings: true })
    expect(w.outcome).toBe('approved')
    expect(await w.settings.accountSettingsGet()).toEqual({ kind: 'error', code: 'invalid_response', message: null })
    expect(w.calls).toEqual([])
  })

  test('a write before the first settings read discards the login snapshot', async () => {
    const w = await world()
    await w.settings.accountSettingsPatch({ generation: 0, expectedRevision: 1, set: { fontFamily: 'inter' }, reset: [] })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(w.calls.map(call => call.method)).toEqual(['PATCH', 'GET'])
  })
})

describe('login startup directory', () => {
  test('the first directory read makes no request, and the next one asks GET /v1/hosts', async () => {
    const w = await world({ startupDirectory: LOGIN_DIRECTORY })
    expect(w.outcome).toBe('approved')
    expect(await w.uplink.listDirectory()).toEqual({ directoryUrl: ISSUER, ...LOGIN_DIRECTORY })
    expect(w.calls).toEqual([])
    expect((await w.uplink.listDirectory())?.hosts[0].label).toBe('Renamed laptop')
    expect(w.calls).toEqual([{ path: '/v1/hosts', method: 'GET' }])
  })

  test('a delayed first read asks the network instead of using the login directory', async () => {
    const w = await world({ startupDirectory: LOGIN_DIRECTORY })
    w.plane.advance(31_000)
    expect((await w.uplink.listDirectory())?.hosts[0].label).toBe('Renamed laptop')
    expect(w.calls).toHaveLength(1)
  })

  test('sign-out discards the login directory', async () => {
    const w = await world({ startupDirectory: LOGIN_DIRECTORY })
    await w.session.signOut()
    expect(w.session.takeStartupDirectory()).toBeNull()
  })

  test('a write before the first read discards the login directory', async () => {
    const w = await world({ startupDirectory: LOGIN_DIRECTORY })
    await w.uplink.removeHost('host-1')
    expect((await w.uplink.listDirectory())?.hosts[0].label).toBe('Renamed laptop')
    expect(w.calls.map(call => call.method)).toEqual(['DELETE', 'GET'])
  })

  test('a server that sends no directory still signs in, and the first read asks the network', async () => {
    const w = await world()
    expect(w.outcome).toBe('approved')
    expect((await w.uplink.listDirectory())?.hosts[0].label).toBe('Renamed laptop')
    expect(w.calls).toEqual([{ path: '/v1/hosts', method: 'GET' }])
  })

  test('a directory this client cannot read does not stop sign-in', async () => {
    // SAFETY: a malformed answer from a newer or broken server, on purpose.
    const w = await world({ startupDirectory: { hosts: [{ hostId: 7 }], workspaces: [] } as unknown as DirectoryResponse })
    expect(w.outcome).toBe('approved')
    expect(w.session.takeStartupAccount()).not.toBeNull()
    expect((await w.uplink.listDirectory())?.hosts[0].label).toBe('Renamed laptop')
  })
})
