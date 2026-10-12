import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { adoptCloudOriginIfPresent, configureUplinkAccountSource, uplinkAccountSource } from '@solus/client-core/uplink-account'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { configureCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import type { SavedServer } from '@solus/client-core/server-registry'
import { DEFAULT_ORGANIZATION_POLICY } from '@solus/contracts/uplink'

// The web client's start on the account origin (docs/adr/0001-standard-authentication.md
// §2.2 rule 1). A probe that sends no credential tells the account origin from a host;
// signed in, the page reads its directory once with an account-plane access token, and
// the website's cookie is never the credential.

const host = {
  hostId: 'abcdefghijklmnop', installationId: 'installation', label: 'My host', os: 'macos',
  kind: 'personal', category: 'personal', organizationIds: [],
  routes: [{ kind: 'tunnel', url: 'https://host.example' }],
}
const workspace = { organizationId: 'org-1', label: 'Acme', routes: [{ kind: 'tunnel', url: 'https://workspace.example' }], isActive: true, policy: DEFAULT_ORGANIZATION_POLICY }
const fetchSpy = spyOn(globalThis, 'fetch')
afterAll(() => fetchSpy.mockRestore())
afterEach(() => {
  fetchSpy.mockReset()
  configureUplinkAccountSource(null)
  configureCloudAccount(null)
})

// Each test is its own origin: the page asks once per origin whether it is the account origin.
let originSerial = 0
const nextOrigin = () => `https://account-${++originSerial}.example`

function session(isSignedIn: boolean): CloudAccountSession {
  return {
    accessToken: async () => (isSignedIn ? 'account-token' : null),
    signOut: async () => {},
    state: () => isSignedIn
      ? { kind: 'signed-in', identity: { sub: 'u', email: 'a@b.co', emailVerified: true, name: null, picture: null }, consoleUrl: 'x', signedInAt: 1, isStale: false }
      : { kind: 'signed-out' },
    onChange: () => () => {},
  }
}

const requestsTo = (origin: string, path: string) => fetchSpy.mock.calls.filter(([url]) => String(url) === `${origin}${path}`)

// Run the actual web startup function with an in-memory saved catalog.
const source = readFileSync(new URL('../../apps/client/src/main.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function adoptCloudDirectory(')
const end = source.indexOf('async function bootFromCatalog(', start)
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

async function bootDirectory(origin: string, isSignedIn: boolean) {
  const state = { kind: 'unknown' }
  const saved: SavedServer[] = [{ id: 'paired', label: 'Paired host', url: 'https://paired.example', sessionToken: 'fixture', lastConnected: 1 }]
  const save = mock((servers: SavedServer[]) => { saved.splice(0, saved.length, ...servers) })
  const saveWorkspaces = mock((_workspaces: unknown[], _directoryUrl: string) => [])
  const answered = mock(() => {})
  const adopt = (at: string) => adoptCloudOriginIfPresent(at, session(isSignedIn))
  const boot = new Function('adoptCloudOriginIfPresent', 'uplinkAccountSource', 'cloudOrigin',
    'location', 'loadServers', 'saveServers', 'mergeDirectoryIntoSaved', 'saveDirectoryWorkspaces', 'startupAccountRead', 'markDirectoryAnswered',
    `${compiled}\nreturn adoptCloudDirectory();`)
  await boot(adopt, uplinkAccountSource, state, { origin }, () => saved, save, mergeDirectoryIntoSaved, saveWorkspaces, startupAccountRead, answered)
  // Only a merged directory makes the saved hosts authoritative (workspace-and-machines.md §6).
  expect(answered).toHaveBeenCalledTimes(save.mock.calls.length)
  expect(saveWorkspaces).toHaveBeenCalledTimes(save.mock.calls.length)
  return { state, saved, save, saveWorkspaces }
}

test('signed in, the start probes without a credential, then reads the directory once with an access token', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [host], workspaces: [workspace] })
    : Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { state, saved, save, saveWorkspaces } = await bootDirectory(origin, true)
  expect(state.kind).toBe('signed-in')
  const [probe, directory] = requestsTo(origin, '/v1/hosts')
  expect(probe![1]).toMatchObject({ credentials: 'omit' })
  expect(new Headers(probe![1]?.headers).get('authorization')).toBeNull()
  expect(directory![1]).toMatchObject({ credentials: 'omit' })
  expect(new Headers(directory![1]?.headers).get('authorization')).toBe('Bearer account-token')
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(2)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(saved.some((server) => server.installationId === host.installationId)).toBe(true)
  expect(saved.some((server) => server.id === 'paired')).toBe(true)
  // WHY: a workspace service is a cloud service, never a host.
  expect(saved.some((server) => server.id.startsWith('workspace:'))).toBe(false)
  expect(saveWorkspaces).toHaveBeenCalledWith([workspace], origin)
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [{ ...host, label: 'Renamed host' }], workspaces: [] }))
  const refreshed = await uplinkAccountSource()?.listDirectory()
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(3)
  expect(refreshed?.hosts[0].label).toBe('Renamed host')
})

test('the account origin with no sign-in keeps the saved hosts and reads nothing more', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async () => Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { state, saved, save } = await bootDirectory(origin, false)
  expect(state.kind).toBe('signed-out')
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(0)
  expect(save).not.toHaveBeenCalled()
  expect(saved.map((server) => server.id)).toEqual(['paired'])
  expect(uplinkAccountSource()).not.toBeNull()
})

for (const scenario of [
  { name: 'host SPA fallback', response: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) },
  { name: 'server failure', response: () => Response.json({}, { status: 503 }) },
  { name: 'network failure', response: (): Response => { throw new Error('offline') } },
]) {
  test(`${scenario.name} is not the account origin and keeps the saved hosts`, async () => {
    const origin = nextOrigin()
    fetchSpy.mockImplementation(async () => scenario.response())
    const { state, saved, save } = await bootDirectory(origin, true)
    expect(state.kind).toBe('not-cloud')
    expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
    expect(save).not.toHaveBeenCalled()
    expect(saved.map((server) => server.id)).toEqual(['paired'])
    expect(uplinkAccountSource()).toBeNull()
  })
}

test('an invalid directory keeps the saved hosts, and a valid empty one is a signed-in account', async () => {
  const invalid = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [null] })
    : Response.json({}, { status: 401 }))
  const first = await bootDirectory(invalid, true)
  expect(first.state.kind).toBe('signed-in')
  expect(first.save).not.toHaveBeenCalled()

  const empty = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [], workspaces: [] })
    : Response.json({}, { status: 401 }))
  const second = await bootDirectory(empty, true)
  expect(second.state.kind).toBe('signed-in')
  expect(second.save).toHaveBeenCalledTimes(1)
})
