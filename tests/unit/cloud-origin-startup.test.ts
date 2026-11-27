import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { adoptAccountOrigin, configureUplinkAccountSource, takeStartupDirectoryRead, uplinkAccountSource } from '@solus/client-core/uplink-account'
import { configureCloudAccount, startupAccountRead, type CloudAccountSession } from '@solus/client-core/cloud-account'
import { HostCatalog } from '@solus/client-core/host-catalog'
import { credentialFor, fakeList, listingFor, memoryCredentials } from './helpers/host-catalog-world'
import { DEFAULT_HOST_RULES, type AccountResponse, type DirectoryResponse } from '@solus/contracts/uplink'
import { WebTokenSession } from '@solus/client-core/web-token-session'
import { skipsOnboarding } from '@solus/workspace-ui/components/onboarding/lib/skip-onboarding'
import { accountSettingsDestination } from '@solus/contracts/account-web'

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
const workspace = { organizationId: 'org-1', label: 'Acme', routes: [{ kind: 'tunnel', url: 'https://workspace.example' }], isActive: true, hostRules: DEFAULT_HOST_RULES }
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

// Run the actual web startup function with an in-memory host catalog (plans/033).
// A host this browser paired is on the person's list with its credential.
const source = readFileSync(new URL('../../apps/client/src/main.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function adoptCloudDirectory(')
const end = source.indexOf('async function bootFromCatalog(', start)
const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end))

async function bootDirectory(origin: string, isSignedIn: boolean, options: { accountShell?: boolean; shellDirectory?: DirectoryResponse; shellAccount?: AccountResponse; webSession?: CloudAccountSession } = {}) {
  const catalog = new HostCatalog({
    credentials: memoryCredentials([], { paired: credentialFor('paired') }),
    directory: () => uplinkAccountSource(),
    startupDirectory: takeStartupDirectoryRead,
    clientOrigin: () => origin,
  })
  await catalog.useListSource(fakeList([], 'device', [listingFor('paired', { label: 'Paired host' })]).source)
  const webSession = options.webSession ?? (isSignedIn ? session(true) : null)
  const shell = options.accountShell === false ? null : { signedIn: undefined, directory: options.shellDirectory, account: options.shellAccount, settingsJson: undefined }
  const boot = new Function('adoptAccountOrigin', 'accountShell', 'webSession', 'location', 'hostCatalog',
    `${compiled}\nreturn adoptCloudDirectory();`)
  await boot(adoptAccountOrigin, shell, webSession, { origin }, catalog)
  const ids = () => catalog.hosts().map((host) => host.id)
  return { catalog, ids }
}

test('signed in, the start reads the directory once, with an access token and no probe before it', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [host], workspaces: [workspace] })
    : Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { catalog, ids } = await bootDirectory(origin, true)
  const [directory] = requestsTo(origin, '/v1/hosts')
  expect(directory![1]).toMatchObject({ credentials: 'omit' })
  expect(new Headers(directory![1]?.headers).get('authorization')).toBe('Bearer account-token')
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(1)
  expect(catalog.directoryState()).toBe('ready')
  expect(ids()).toEqual(['paired', host.installationId])
  // WHY: a workspace service is a cloud service, never a host.
  expect(ids().some((id) => id.startsWith('workspace:'))).toBe(false)
  expect(catalog.workspaces()).toEqual([{ ...workspace, directoryUrl: origin }])
  // The catalog takes boot's read once; an explicit refresh still reads.
  expect(takeStartupDirectoryRead()).toBeNull()
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(1)
  fetchSpy.mockImplementation(async () => Response.json({ hosts: [{ ...host, label: 'Renamed host' }], workspaces: [] }))
  const refreshed = await uplinkAccountSource()?.listDirectory()
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(2)
  expect(refreshed?.hosts[0].label).toBe('Renamed host')
})

test('the account origin with no sign-in keeps the paired hosts and reads nothing more', async () => {
  const origin = nextOrigin()
  fetchSpy.mockImplementation(async () => Response.json({ error: 'unauthorized' }, { status: 401 }))
  const { catalog, ids } = await bootDirectory(origin, false)
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(0)
  expect(requestsTo(origin, '/v1/account')).toHaveLength(0)
  // Signed out, the directory answers at once with no hosts.
  expect(catalog.directoryState()).toBe('ready')
  expect(ids()).toEqual(['paired'])
  // No session: there is nobody to give tokens for.
  expect(uplinkAccountSource()).toBeNull()
})

test('with the shell\'s directory, the hosts are known while the first token answer is still pending', async () => {
  // WHY (fast-secure-startup.md, step 3): the workspace mounts when its code has run; no
  // auth request stands before the hosts it shows.
  const origin = nextOrigin()
  const tokens = Promise.withResolvers<Response>()
  const webSession = new WebTokenSession({
    origin, identity: { sub: 'u', email: 'a@b.co', emailVerified: true, name: null, picture: null }, signedInAt: 1,
    fetch: () => tokens.promise, now: () => 0, onSignedOut: () => {}, channel: null,
  })
  webSession.start([host.hostId])
  fetchSpy.mockImplementation(() => tokens.promise)
  const { ids } = await bootDirectory(origin, true, { webSession, shellDirectory: { hosts: [host], workspaces: [workspace] } as DirectoryResponse })
  expect(ids()).toContain(host.installationId)
  expect(requestsTo(origin, '/v1/hosts')).toHaveLength(0)
  tokens.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
})

test('with the shell\'s directory and account, the boot asks neither route', async () => {
  // WHY (web-session-tokens.md, decision 4): the first screen's data comes in the HTML,
  // so a fresh login makes one request (its tokens) beside the workspace code.
  const origin = nextOrigin()
  const account: AccountResponse = { userId: 'u', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [], github: null }
  fetchSpy.mockImplementation(async () => Response.json({ error: 'unexpected' }, { status: 500 }))
  const { ids } = await bootDirectory(origin, true, { shellDirectory: { hosts: [host], workspaces: [workspace] } as DirectoryResponse, shellAccount: account })
  expect(ids()).toContain(host.installationId)
  expect(await startupAccountRead()).toEqual(account)
  expect(fetchSpy).not.toHaveBeenCalled()
})

test('a page whose shell does not name the account origin is a host page: it asks nothing and keeps the paired hosts', async () => {
  // WHY: a host serves the same bundle; spending a request to tell them apart is what the
  // shell's marker removes, and a host page must never adopt an account source.
  const origin = nextOrigin()
  const { ids } = await bootDirectory(origin, true, { accountShell: false })
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(ids()).toEqual(['paired'])
  expect(uplinkAccountSource()).toBeNull()
})

test('an invalid directory is a failed read that keeps the paired hosts, and a valid empty one is a signed-in account', async () => {
  const invalid = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [null] })
    : Response.json({}, { status: 401 }))
  const first = await bootDirectory(invalid, true)
  // No cached copy (plans/033 §3 Q2): Solus Cloud shows the failed read, with Retry.
  expect(first.catalog.directoryState()).toBe('failed')
  expect(first.ids()).toEqual(['paired'])

  const empty = nextOrigin()
  fetchSpy.mockImplementation(async (_url, init) => new Headers(init?.headers).get('authorization')
    ? Response.json({ hosts: [], workspaces: [] })
    : Response.json({}, { status: 401 }))
  const second = await bootDirectory(empty, true)
  expect(uplinkAccountSource()).not.toBeNull()
  expect(second.catalog.directoryState()).toBe('ready')
  expect(second.ids()).toEqual(['paired'])
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
    const { ids } = await bootDirectory(origin, true)
    expect(ids()).toContain(host.installationId)
    expect(requestsTo(origin, '/v1/account')).toHaveLength(1)
  } finally {
    timer.mockRestore()
    account.resolve(Response.json({ userId: 'u', onboardingCompletedAt: null, activeOrganizationId: null, organizations: [] }))
    await startupAccountRead()
  }
})

const compiledCatalog = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  source.slice(end, source.indexOf('\n}\n', end) + 3),
)

test.each([
  { name: 'opens the workspace for first-run onboarding', status: null, search: '', opensResource: false, signedIn: true },
  { name: 'opens the workspace after onboarding is complete', status: 1, search: '', opensResource: false, signedIn: true },
  { name: 'opens the workspace when the URL skips onboarding', status: null, search: '?skip-onboarding', opensResource: false, signedIn: true },
  { name: 'opens the workspace on a resource link', status: null, search: '', opensResource: true, signedIn: true },
  { name: 'opens the workspace without an account', status: null, search: '', opensResource: false, signedIn: false },
  { name: 'offers pairing at the serving host address', status: null, search: '', opensResource: false, signedIn: false, needsPairing: true },
])('a web page with an empty catalog $name', async ({ status, search, opensResource, signedIn, needsPairing }) => {
  const origin = 'https://page.example'
  const mounts: Array<{ pairAddress?: string }> = []
  const dependencies = {
    webState: {},
    hostCatalog: { load: async () => {}, useListSource: async () => {} },
    adoptCloudDirectory: async () => {},
    loadWorkspaceApp: async () => {},
    accountShell: signedIn ? {} : null,
    probeServingOrigin: async () => needsPairing ? { entry: null, known: null } : null,
    webAccountDocuments: () => null,
    hostListSourceFor: () => null,
    localStorage: {},
    getActiveServerId: () => null,
    serverConnections: { catalogServerIds: () => [], startCatalogSupervisors: () => {} },
    webSession: signedIn ? {} : null,
    startupAccountRead: () => Promise.resolve({ onboardingCompletedAt: status }),
    skipsOnboarding,
    location: { origin, search },
    window: {},
    installServiceWorkerMessageBridge: () => {},
    mountWorkspace: async (_generation: number, pairAddress?: string) => { mounts.push({ pairAddress }) },
  }
  const run = new Function('intent', ...Object.keys(dependencies), `
    let connectionGeneration = 0;
    ${compiledCatalog}
    return bootFromCatalog(intent);
  `)
  await run({ opensResource }, ...Object.values(dependencies))
  expect(mounts).toEqual([{ pairAddress: needsPairing ? origin : undefined }])
})

test('a failed pairing link opens the normal workspace and shows the error', async () => {
  const start = source.indexOf('async function pairFromLocation(')
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, source.indexOf('\n}\n', start) + 3))
  const events: string[] = []
  const run = new Function('history', 'probeServer', 'bootFromCatalog', 'toasts', `${compiled}
    return pairFromLocation('expired', 'https://host.example');
  `)
  await run({ replaceState() {} }, async () => ({ ok: false }), async () => { events.push('workspace') }, {
    error: (message: string) => events.push(message),
  })
  expect(events).toEqual(['workspace', 'This Tailscale host did not answer.'])
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
  const run = new Function('accountSettingsDestination', 'webSession', 'dialableHostIds', 'pairTokenFromLocation', 'offerAppOrPair', 'location', 'parseCloudShareLink',
    'openShareLink', 'bootFromCatalog', 'addressedBootIntent', 'guestBoot', 'mount', 'root',
    `${compiledStartPage}\nreturn startPage();`)
  void run(accountSettingsDestination, webSession, () => ['host-1'], () => null, () => {}, { href: `https://app.example${pathname}${hash}`, pathname, hash },
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
