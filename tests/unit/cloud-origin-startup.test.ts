import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { adoptAccountOrigin, configureUplinkAccountSource, takeStartupDirectoryRead, uplinkAccountSource } from '@solus/client-core/uplink-account'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { configureCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import type { SavedServer } from '@solus/client-core/server-registry'
import { DEFAULT_ORGANIZATION_POLICY, type DirectoryResponse } from '@solus/contracts/uplink'
import { WebTokenSession } from '@solus/client-core/web-token-session'

// The web client's start on the account origin (docs/plans/fast-secure-startup.md). The
// account origin's shell names itself and who is signed in, so no request is spent to
// know either (docs/plans/instant-share-open.md). Signed in, the page takes its
// directory from the shell, or reads it once with an account-plane access token; the
// cookie is not the credential at `/v1`.

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

let originSerial = 0
const nextOrigin = () => `https://account-${++originSerial}.example`

function session(isSignedIn: boolean): CloudAccountSession {
  return {
    accessToken: async () => (isSignedIn ? 'account-token' : null),
    signOut: async () => true,
    state: () => isSignedIn
      ? { kind: 'signed-in', identity: { sub: 'u', email: 'a@b.co', emailVerified: true, name: null, picture: null }, consoleUrl: 'x', signedInAt: 1, isStale: false }
      : { kind: 'signed-out' },
    onChange: () => () => {},
    takeStartupAccount: () => null,
    takeStartupDirectory: () => null,
    takeStartupSettings: async () => null,
  }
}

const requestsTo = (origin: string, path: string) => fetchSpy.mock.calls.filter(([url]) => String(url) === `${origin}${path}`)

test('the first setup checklist uses the account boot read, and later opens refresh GitHub', () => {
  const store = readFileSync(new URL('../../packages/workspace-ui/src/components/onboarding/cloud-onboarding.store.svelte.ts', import.meta.url), 'utf8')
  const begin = store.indexOf('  refreshGetStarted(): void {')
  const end = store.indexOf('  /** The first load', begin)
  const method = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = { ${store.slice(begin, end)} };`)
  const projects = { load: mock(() => Promise.resolve()) }
  const seats = { refresh: mock(() => Promise.resolve()) }
  const refreshGithub = mock(() => Promise.resolve())
  const checklist = new Function('workspaceProjectsStore', 'cloudAgentSeatsStore', `${method}\nreturn methods;`)(projects, seats)
  Object.assign(checklist, { workspaceServerId: 'workspace', refreshGithub })
  checklist.refreshGetStarted()
  expect(refreshGithub).not.toHaveBeenCalled()
  expect(projects.load).toHaveBeenCalledWith('workspace')
  expect(seats.refresh).toHaveBeenCalledTimes(1)
  checklist.refreshGetStarted()
  expect(refreshGithub).toHaveBeenCalledTimes(1)
})

// Run the actual web startup function with an in-memory saved catalog.
const source = readFileSync(new URL('../../apps/client/src/main.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function adoptCloudDirectory(')
const end = source.indexOf('async function bootFromCatalog(', start)
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

async function bootDirectory(origin: string, isSignedIn: boolean, options: { accountShell?: boolean; shellDirectory?: DirectoryResponse; webSession?: CloudAccountSession } = {}) {
  const state = { kind: 'unknown' }
  const saved: SavedServer[] = [{ id: 'paired', label: 'Paired host', url: 'https://paired.example', sessionToken: 'fixture', lastConnected: 1 }]
  const save = mock((servers: SavedServer[]) => { saved.splice(0, saved.length, ...servers) })
  const saveWorkspaces = mock((_workspaces: unknown[], _directoryUrl: string) => [])
  const answered = mock(() => {})
  const webSession = options.webSession ?? (isSignedIn ? session(true) : null)
  const shell = options.accountShell === false ? null : { signedIn: undefined, directory: options.shellDirectory }
  const boot = new Function('adoptAccountOrigin', 'accountShell', 'webSession', 'uplinkAccountSource', 'cloudOrigin',
    'location', 'loadServers', 'saveServers', 'mergeDirectoryIntoSaved', 'saveDirectoryWorkspaces', 'startupAccountRead', 'markDirectoryAnswered',
    `${compiled}\nreturn adoptCloudDirectory();`)
  await boot(adoptAccountOrigin, shell, webSession, uplinkAccountSource, state, { origin }, () => saved, save, mergeDirectoryIntoSaved, saveWorkspaces, startupAccountRead, answered)
  // Only a merged directory makes the saved hosts authoritative (workspace-and-machines.md §6).
  expect(answered).toHaveBeenCalledTimes(save.mock.calls.length)
  expect(saveWorkspaces).toHaveBeenCalledTimes(save.mock.calls.length)
  return { state, saved, save, saveWorkspaces }
}

test('signed in, the start reads the directory once, with an access token and no probe before it', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [host], workspaces: [workspace] })
    : Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { state, saved, save, saveWorkspaces } = await bootDirectory(origin, true)
  expect(state.kind).toBe('signed-in')
  const [directory] = requestsTo(origin, '/v1/hosts')
  expect(directory![1]).toMatchObject({ credentials: 'omit' })
  expect(new Headers(directory![1]?.headers).get('authorization')).toBe('Bearer account-token')
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(saved.some((server) => server.installationId === host.installationId)).toBe(true)
  expect(saved.some((server) => server.id === 'paired')).toBe(true)
  // WHY: a workspace service is a cloud service, never a host.
  expect(saved.some((server) => server.id.startsWith('workspace:'))).toBe(false)
  expect(saveWorkspaces).toHaveBeenCalledWith([workspace], origin)
  // The mounted store takes boot's result once; an explicit refresh still reads.
  expect((await takeStartupDirectoryRead())?.hosts[0].label).toBe(host.label)
  expect(takeStartupDirectoryRead()).toBeNull()
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [{ ...host, label: 'Renamed host' }], workspaces: [] }))
  const refreshed = await uplinkAccountSource()?.listDirectory()
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(2)
  expect(refreshed?.hosts[0].label).toBe('Renamed host')
})

test('the account origin with no sign-in keeps the saved hosts and reads nothing more', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async () => Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { state, saved, save } = await bootDirectory(origin, false)
  expect(state.kind).toBe('signed-out')
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(0)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(0)
  expect(save).not.toHaveBeenCalled()
  expect(saved.map((server) => server.id)).toEqual(['paired'])
  // No session: there is nobody to give tokens for.
  expect(uplinkAccountSource()).toBeNull()
})

test('with the shell\'s directory, the hosts are saved while the first token answer is still pending', async () => {
  // WHY (fast-secure-startup.md, step 3): the workspace mounts when its code has run; no
  // auth request stands before the hosts it shows.
  const origin = nextOrigin()
  const tokens = Promise.withResolvers<Response>()
  const webSession = new WebTokenSession({
    origin, identity: { sub: 'u', email: 'a@b.co', emailVerified: true, name: null, picture: null }, signedInAt: 1,
    fetch: () => tokens.promise, now: () => 0, onSignedOut: () => {},
  })
  webSession.start([host.hostId])
  fetchSpy.mockImplementation(() => tokens.promise)
  const { state, saved } = await bootDirectory(origin, true, { webSession, shellDirectory: { hosts: [host], workspaces: [workspace] } as DirectoryResponse })
  expect(state.kind).toBe('signed-in')
  expect(saved.some((server) => server.installationId === host.installationId)).toBe(true)
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(0)
  expect((await takeStartupDirectoryRead())?.hosts[0].label).toBe(host.label)
  tokens.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
})

test('a page whose shell does not name the account origin is a host page: it asks nothing and keeps the saved hosts', async () => {
  // WHY: a host serves the same bundle; spending a request to tell them apart is what the
  // shell's marker removes, and a host page must never adopt an account source.
  const origin = nextOrigin()
  const { state, saved, save } = await bootDirectory(origin, true, { accountShell: false })
  expect(state.kind).toBe('not-cloud')
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(saved.map((server) => server.id)).toEqual(['paired'])
  expect(uplinkAccountSource()).toBeNull()
})

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

test('hosts become available while the onboarding account read is still pending', async () => {
  const origin = nextOrigin()
  const account = Promise.withResolvers<Response>()
  fetchSpy.mockImplementation((url) => String(url).endsWith('/v1/account')
    ? account.promise
    : Promise.resolve(Response.json({ hosts: [host], workspaces: [workspace] })))
  // A timer must not hold the directory behind the account read, even for a
  // bounded wait. Token and fetch deadlines use AbortSignal, not this timer.
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(() => {
    throw new Error('The directory must not wait for the onboarding account')
  })
  try {
    const { saved } = await bootDirectory(origin, true)
    expect(saved.some((server) => server.installationId === host.installationId)).toBe(true)
    expect(requestsTo(origin, '/v1/account')).toHaveLength(1)
  } finally {
    timer.mockRestore()
    account.resolve(Response.json({ userId: 'u', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [] }))
    await startupAccountRead()
  }
})

// Exercise the real cached loader without importing the full Svelte workspace.
const loaderStart = source.indexOf('function loadWorkspaceApp(')
const loaderEnd = source.indexOf('function installServiceWorkerMessageBridge(', loaderStart)
const compiledLoader = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.slice(loaderStart, loaderEnd).replace("= import('./App.svelte')", '= importWorkspace()'),
)
interface FixtureWorkspace { name: string }
function workspaceLoader(importWorkspace: () => Promise<FixtureWorkspace>): () => Promise<FixtureWorkspace> {
  return new Function('importWorkspace', `let workspaceAppImport = null;\n${compiledLoader}\nreturn loadWorkspaceApp;`)(importWorkspace)
}

// The workspace code is the longest step of a fresh login (docs/benchmarks/
// fresh-login-safari-post-deploy-2026-10-30.json). It must load beside the sign-in,
// not after it: no token, catalog, or timer may stand before the import.
test('the workspace import starts at once and is shared by every caller', async () => {
  const app = { name: 'workspace' }
  const importWorkspace = mock(async () => app)
  const load = workspaceLoader(importWorkspace)
  const first = load()
  expect(importWorkspace).toHaveBeenCalledTimes(1)
  expect(load()).toBe(first)
  expect(await first).toBe(app)
  expect(importWorkspace).toHaveBeenCalledTimes(1)
})

test('a failed workspace import can be retried', async () => {
  const app = { name: 'workspace' }
  const failingImport = mock(async () => {
    if (failingImport.mock.calls.length === 1) throw new Error('Chunk unavailable')
    return app
  })
  const retry = workspaceLoader(failingImport)
  await expect(retry()).rejects.toThrow('Chunk unavailable')
  expect(await retry()).toBe(app)
})

// Run the real page start.
const startPageStart = source.indexOf('async function startPage(')
const compiledStartPage = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.slice(startPageStart, source.indexOf('\n}\n', startPageStart) + 3),
)

function startPageAt(pathname: string, hash = '') {
  const order: string[] = []
  const webSession = { start: mock((_hostIds: string[]) => { order.push('token request') }) }
  const bootFromCatalog = mock(() => { order.push('boot'); return Promise.resolve() })
  const openShareLink = mock(() => Promise.resolve())
  const run = new Function('webSession', 'dialableHostIds', 'pairTokenFromLocation', 'offerAppOrPair', 'location', 'parseCloudShareLink',
    'openShareLink', 'bootFromCatalog', 'addressedBootIntent', 'guestBoot', 'mount', 'root',
    `${compiledStartPage}\nreturn startPage();`)
  void run(webSession, () => ['host-1'], () => null, () => {}, { href: `https://app.example${pathname}${hash}`, pathname, hash },
    (path: string) => (path.startsWith('/t/') ? { secret: 's' } : null), openShareLink, bootFromCatalog, () => undefined,
    { fail() {} }, () => {}, null)
  return { webSession, bootFromCatalog, openShareLink, order }
}

test('the first token request goes before anything else, with the shell\'s hosts in it', () => {
  // WHY (fast-secure-startup.md, step 2): one request carries the servers token and every host, beside the code.
  const page = startPageAt('/')
  expect(page.webSession.start).toHaveBeenCalledWith(['host-1'])
  expect(page.order).toEqual(['token request', 'boot'])
})

test('the workspace boots at once: nothing waits for a token answer', () => {
  // WHY (step 3): the shell says who is signed in, so the boot begins in the same turn as the page start.
  const page = startPageAt('/chat')
  expect(page.bootFromCatalog).toHaveBeenCalledTimes(1)
})

test('a share link resolves first and does not boot the workspace', () => {
  const page = startPageAt('/t/abc')
  expect(page.openShareLink).toHaveBeenCalledTimes(1)
  expect(page.bootFromCatalog).not.toHaveBeenCalled()
})
