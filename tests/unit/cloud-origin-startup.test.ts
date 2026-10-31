import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { adoptAccountOrigin, configureUplinkAccountSource, takeStartupDirectoryRead, uplinkAccountSource } from '@solus/client-core/uplink-account'
import { mergeDirectoryIntoSaved } from '@solus/client-core/uplink-session'
import { configureCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import type { SavedServer } from '@solus/client-core/server-registry'
import { DEFAULT_ORGANIZATION_POLICY } from '@solus/contracts/uplink'

// The web client's start on the account origin (docs/adr/0001-standard-authentication.md
// §2.2 rule 1). The account origin's shell names itself, so no request is spent telling
// it from a host (docs/plans/instant-share-open.md); signed in, the page reads its
// directory once with an account-plane access token, and the website's cookie is never
// the credential.

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
    signOut: async () => {},
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

async function bootDirectory(origin: string, isSignedIn: boolean, options: { accountShell?: boolean } = {}) {
  const state = { kind: 'unknown' }
  const saved: SavedServer[] = [{ id: 'paired', label: 'Paired host', url: 'https://paired.example', sessionToken: 'fixture', lastConnected: 1 }]
  const save = mock((servers: SavedServer[]) => { saved.splice(0, saved.length, ...servers) })
  const saveWorkspaces = mock((_workspaces: unknown[], _directoryUrl: string) => [])
  const answered = mock(() => {})
  const adopt = (at: string) => adoptAccountOrigin(at, session(isSignedIn))
  const shell = options.accountShell === false ? null : { discovery: undefined }
  const boot = new Function('adoptAccountOrigin', 'accountShell', 'uplinkAccountSource', 'cloudOrigin',
    'location', 'loadServers', 'saveServers', 'mergeDirectoryIntoSaved', 'saveDirectoryWorkspaces', 'startupAccountRead', 'markDirectoryAnswered',
    `${compiled}\nreturn adoptCloudDirectory();`)
  await boot(adopt, shell, uplinkAccountSource, state, { origin }, () => saved, save, mergeDirectoryIntoSaved, saveWorkspaces, startupAccountRead, answered)
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
  expect(uplinkAccountSource()).not.toBeNull()
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

// Run the real page start with the sign-in held open.
const startPageStart = source.indexOf('async function startPage(')
const compiledStartPage = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.slice(startPageStart, source.indexOf('\n}\n', startPageStart) + 3),
)
const SHELL_DIRECTORY = { hosts: [], workspaces: [] }

function startPageAt(pathname: string, hash = '', options: { shellDirectory?: object; savedServerIds?: string[] } = {}) {
  const loadWorkspaceApp = mock(() => Promise.resolve({ default: {} }))
  const signIn = Promise.withResolvers<boolean>()
  const resumeAccountSignIn = mock(() => signIn.promise)
  const dialShellDirectory = mock((_directory: object, _signedIn: Promise<boolean>) => {})
  const run = new Function('pairTokenFromLocation', 'location', 'parseCloudShareLink', 'loadWorkspaceApp', 'resumeAccountSignIn',
    'openShareLink', 'bootFromCatalog', 'addressedBootIntent', 'guestBoot', 'mount', 'root',
    'accountShell', 'serverConnections', 'dialShellDirectory',
    `${compiledStartPage}\nreturn startPage();`)
  const opening = run(() => null, { href: `https://app.example${pathname}${hash}`, pathname, hash },
    (path: string) => (path.startsWith('/t/') ? { secret: 's' } : null), loadWorkspaceApp, resumeAccountSignIn,
    () => Promise.resolve(), () => Promise.resolve(), () => undefined, { fail() {} }, () => {}, null,
    { discovery: undefined, directory: options.shellDirectory }, { catalogServerIds: () => options.savedServerIds ?? [] }, dialShellDirectory)
  return { loadWorkspaceApp, resumeAccountSignIn, dialShellDirectory, signIn, opening }
}

test('the workspace code loads while the sign-in is still completing', () => {
  const page = startPageAt('/')
  expect(page.resumeAccountSignIn).toHaveBeenCalledTimes(1)
  expect(page.loadWorkspaceApp).toHaveBeenCalledTimes(1)
  page.signIn.resolve(false)
})

test('a share link does not load the workspace before it knows the visitor is a member', () => {
  for (const pathname of ['/t/abc', '/w/abc', '/s/abc']) {
    const page = startPageAt(pathname)
    expect(page.loadWorkspaceApp).not.toHaveBeenCalled()
    page.signIn.resolve(false)
  }
})

// docs/plans/instant-share-open.md §4.14: on a fresh login the host sockets set up
// while the sign-in completes, instead of after it.
test('a fresh browser dials the shell\'s directory before the sign-in completes, with the sign-in to wait on', () => {
  const page = startPageAt('/', '', { shellDirectory: SHELL_DIRECTORY })
  expect(page.dialShellDirectory).toHaveBeenCalledTimes(1)
  expect(page.dialShellDirectory.mock.calls[0]![0]).toBe(SHELL_DIRECTORY)
  expect(page.dialShellDirectory.mock.calls[0]![1]).toBe(page.signIn.promise)
  page.signIn.resolve(false)
})

test('saved hosts, a share link, or a shell with no directory keep the dial after the sign-in', () => {
  for (const page of [
    startPageAt('/', '', { shellDirectory: SHELL_DIRECTORY, savedServerIds: ['saved-host'] }),
    startPageAt('/s/abc', '', { shellDirectory: SHELL_DIRECTORY }),
    startPageAt('/'),
  ]) {
    expect(page.dialShellDirectory).not.toHaveBeenCalled()
    page.signIn.resolve(false)
  }
})
