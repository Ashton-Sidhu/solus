import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { cloudAccount, configureCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import { webSettingsRequests } from '@solus/client-core/settings-requests'
import { adoptAccountOrigin, configureUplinkAccountSource, takeStartupDirectoryRead, uplinkAccountSource, type ShellStartup } from '@solus/client-core/uplink-account'
import type { AccountResponse, DirectoryResponse } from '@solus/contracts/uplink'
import { PERSONAL_SETTINGS_SCHEMA_VERSION } from '@solus/contracts/settings'

// docs/plans/web-session-tokens.md, decision 4: the account origin's HTML carries the
// first screen's data (the directory, the account, the settings), and the page reads
// each once at boot with no request. The token answer carries tokens only. Every read
// after the first, and a read after a write, asks the account routes.

const ORIGIN = 'https://app.example'
const SHELL_DIRECTORY: DirectoryResponse = {
  hosts: [{ hostId: 'host-1', installationId: 'install-1', label: 'Laptop', routes: [], kind: 'personal', category: 'personal', organizationIds: [] }],
  workspaces: [],
}
const SHELL_ACCOUNT: AccountResponse = { userId: 'user-1', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: null }
const shellSettings = (fontFamily: string | number) => ({ schemaVersion: PERSONAL_SETTINGS_SCHEMA_VERSION, generation: 0, revision: 1, settings: { fontFamily }, updatedAt: 1 })

const fetchSpy = spyOn(globalThis, 'fetch')
afterAll(() => fetchSpy.mockRestore())
afterEach(() => {
  fetchSpy.mockReset()
  configureUplinkAccountSource(null)
  configureCloudAccount(null)
})

const calls = () => fetchSpy.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET' }))

const session: CloudAccountSession = {
  accessToken: async () => 'account-token',
  signOut: async () => true,
  state: () => ({ kind: 'signed-in', identity: { sub: 'user-1', email: 'a@example.test', emailVerified: true, name: null, picture: null }, consoleUrl: ORIGIN, signedInAt: 1, isStale: false }),
  onChange: () => () => {},
}

/** Web boot on the account origin with this shell, then the account routes answering current state. */
async function boot(shell: ShellStartup) {
  fetchSpy.mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/account') return Response.json({ ...SHELL_ACCOUNT, github: { login: 'updated' } })
    if (path === '/v1/hosts' && (init?.method ?? 'GET') === 'GET') return Response.json({ hosts: [{ ...SHELL_DIRECTORY.hosts[0]!, label: 'Renamed laptop' }], workspaces: [] })
    if (path === '/v1/account/settings') return Response.json({ ...shellSettings('inter'), revision: 2 })
    return new Response(null, { status: 200 })
  }) as typeof fetch)
  const adoption = await adoptAccountOrigin(ORIGIN, session, shell)
  const account = cloudAccount()!
  return { adoption, account, settings: webSettingsRequests(ORIGIN, session, fetch, () => account.takeShellSettings()) }
}

describe('the first screen data from the shell', () => {
  test('the boot reads of the directory, the account, and the settings make no request; later reads fetch current state', async () => {
    const w = await boot({ directory: SHELL_DIRECTORY, account: SHELL_ACCOUNT, settingsJson: JSON.stringify(shellSettings('geist')) })
    expect(w.adoption.directory?.hosts[0]!.label).toBe('Laptop')
    expect((await takeStartupDirectoryRead())?.hosts[0]!.label).toBe('Laptop')
    expect((await startupAccountRead())?.github).toBeNull()
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 1, settings: { fontFamily: 'geist' } } })
    expect(calls()).toEqual([])

    expect((await uplinkAccountSource()!.listDirectory())?.hosts[0]!.label).toBe('Renamed laptop')
    expect((await w.account.readAccount())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2, settings: { fontFamily: 'inter' } } })
    expect(calls().map((call) => call.path)).toEqual(['/v1/hosts', '/v1/account', '/v1/account/settings'])
  })

  test('a part the shell did not carry is read from its account route', async () => {
    // WHY: a failed read on the server leaves its block out; the page must still start.
    const w = await boot({})
    expect(w.adoption.directory?.hosts[0]!.label).toBe('Renamed laptop')
    expect((await startupAccountRead())?.github).toEqual({ login: 'updated' })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(calls().map((call) => call.path).sort()).toEqual(['/v1/account', '/v1/account/settings', '/v1/hosts'])
  })

  test('a write before the first settings read makes the shell settings old', async () => {
    const w = await boot({ settingsJson: JSON.stringify(shellSettings('geist')) })
    fetchSpy.mockClear()
    await w.settings.accountSettingsPatch({ generation: 0, expectedRevision: 1, set: { fontFamily: 'inter' }, reset: [] })
    expect(await w.settings.accountSettingsGet()).toMatchObject({ kind: 'ok', settings: { revision: 2 } })
    expect(calls().map((call) => call.method)).toEqual(['PATCH', 'GET'])
  })

  test('shell settings that do not decode are an error, not a silent replacement', async () => {
    const w = await boot({ settingsJson: JSON.stringify(shellSettings(7)) })
    fetchSpy.mockClear()
    expect(await w.settings.accountSettingsGet()).toEqual({ kind: 'error', code: 'invalid_response', message: null })
    expect(calls()).toEqual([])
  })
})
