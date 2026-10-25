import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ShareList, ShareResource } from '@solus/contracts/sharing'
import type { CloudPublication } from '@solus/workspace-ui/contexts/sharing/cloud-publication'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// docs/plans/organization-scope.md §4: the Share action is the opt-in to publish.
// Opening Share on a Local work starts its upload into the window's organization
// at once, with no second confirmation; the client uploads it with its own
// sign-in (docs/plans/cloud-sharing.md). A session stays on its host for now:
// Share opens the host's own list and uploads nothing.

const connections = singleHostServerConnections()
const offlineServerIds = new Set<string>()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...connections,
    readinessFor: (serverId: string) => ({ ...connections.readinessFor(serverId), readiness: offlineServerIds.has(serverId) ? 'unreachable' as const : 'ready' as const }),
  },
}))

const toastCalls: string[] = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: {
    error: (message: string) => { toastCalls.push(`error:${message}`) },
    info: (message: string) => { toastCalls.push(`info:${message}`) },
    success: (message: string) => { toastCalls.push(`success:${message}`) },
  },
}))

/** The workspace services this client already knows from an earlier directory read. */
const knownWorkspaces = new Set<string>()
const realWorkspaceRegistry = { ...(await import('@solus/client-core/workspace-registry')) }
mock.module('@solus/client-core/workspace-registry', () => ({
  ...realWorkspaceRegistry,
  savedWorkspaceFor: (serviceId: string) => (knownWorkspaces.has(serviceId) ? { organizationId: 'org-1' } : null),
}))

let directoryReads = 0
/** Hosts this client knows, by the id this client gives each one. */
const knownHosts = new Map<string, { installationId: string }>()
const window = { activeOrganizationId: 'org-1' as string | null, activeOrganizationName: 'Acme' as string | null }
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: {
    get activeOrganizationId() { return window.activeOrganizationId },
    get activeOrganizationName() { return window.activeOrganizationName },
    refreshDirectory: async () => { directoryReads++ },
    hostFor: (serverId: string) => knownHosts.get(serverId) ?? null,
  },
}))
mock.module('@solus/workspace-ui/contexts/connections/uplink.store.svelte', () => ({
  uplinkStore: { statusFor: () => undefined, refresh: async () => {} },
}))
mock.module('@solus/workspace-ui/contexts/notifications/notifications.store.svelte', () => ({
  notificationsStore: { wants: () => false },
}))
const account = { state: { kind: 'signed-in', consoleUrl: 'https://app.example.test' } as { kind: string; consoleUrl?: string } }
mock.module('@solus/workspace-ui/contexts/account/account.store.svelte', () => ({ accountStore: account }))

const stateShim = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
type RuneHost = typeof globalThis & { $state?: typeof stateShim }
const runeHost: RuneHost = globalThis
const previousState = runeHost.$state

beforeEach(() => {
  connections.reset()
  account.state.kind = 'signed-in'
  offlineServerIds.clear()
  toastCalls.length = 0
  directoryReads = 0
  knownWorkspaces.clear()
  knownHosts.clear()
  window.activeOrganizationId = 'org-1'
  window.activeOrganizationName = 'Acme'
  runeHost.$state = stateShim
})

afterEach(() => {
  connections.reset()
  if (previousState === undefined) delete runeHost.$state
  else runeHost.$state = previousState
})

const CLOUD = 'workspace:org-1'
const resource: ShareResource = { kind: 'session', id: 's1' }
const target = { serverId: 'local', resource, title: 'Release plan' }

const cloudList: ShareList = { resource, ownerKey: 'u1', entries: [], callerRole: 'owner', link: null }

/** The organization's workspace service, ready to list the resource's share. */
function registerCloud(): void {
  connections.registerHost(CLOUD, {
    shareGet: async () => cloudList,
    connectionsGetServerInfo: async () => ({ principal: 'org-member', userId: 'u1', organizationId: 'org-1' }),
  })
}

async function newStore() {
  const { SharesStore } = await import('@solus/workspace-ui/contexts/sharing/shares.store.svelte')
  const store = new SharesStore()
  const published: [string, string, string][] = []
  /** The works this client lists, by id: a work in an organization says which. */
  const works: Record<string, { organizationId: string }> = {}
  store.publication.works = { works, markPublished: (workId: string, organizationId: string, cloudServerId: string) => { published.push([workId, organizationId, cloudServerId]) } } as never
  return { store, published, works }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('sharing while signed out', () => {
  test('a session opens its host\'s own list; a work is not pushed and Share says to sign in', async () => {
    // WHY: docs/plans/host-sharing.md §2 — a session's link names its host, so it
    // needs no account. A Local work is shared by pushing it to the cloud, which
    // only a signed-in account can do; nothing leaves the machine without one.
    const calls: string[] = []
    connections.registerPrimary('local', {
      shareGet: async () => { calls.push('host-share'); return cloudList },
      shareLinkOrigin: async () => { calls.push('origin'); return { origin: null } },
      workExportForCloud: async () => { calls.push('export'); throw new Error('must not be asked') },
    })
    const { store } = await newStore()
    account.state.kind = 'signed-out'
    const workTarget = { serverId: 'local', resource: { kind: 'work', id: 'w1' } as const, title: 'Release notes' }

    await store.open(target)
    expect(store.dialog).toEqual({ serverId: 'local', resource, title: 'Release plan' })
    store.close()
    expect(store.canShareFrom('local', 'work')).toBe(false)
    await store.open(workTarget)
    await settle()

    expect(store.dialog).toBeNull()
    expect(calls).not.toContain('export')
    expect(store.busy).toBe(false)
    expect(toastCalls).toEqual(['error:Sign in to share this work.'])
  })
})

describe('sharing a session', () => {
  test('Share on a session opens its host\'s own list and uploads nothing', async () => {
    // WHY: a session stays on its host for now (organization-scope §4). Share must
    // not start a publication that waits on the cloud; it opens the host's list.
    const calls: string[] = []
    connections.registerPrimary('local', {
      workExportForCloud: async () => { calls.push('export'); throw new Error('a session is not uploaded') },
      shareGet: async () => cloudList,
      connectionsGetServerInfo: async () => ({ principal: 'local-owner', userId: 'u1', organizationId: 'org-1' }),
    })
    const { store } = await newStore()

    await store.open(target)
    await settle()

    expect(calls).toEqual([])
    expect(store.dialog).toEqual({ serverId: 'local', resource, title: 'Release plan' })
    expect(store.listFor('local', resource)).toEqual(cloudList)
    expect(directoryReads).toBe(0)
  })

  test('a session shared with its organization copies a member link that names its host by installation id', async () => {
    // WHY: Copy link on a session shared with members must not fall back to a
    // guest link, which a host refuses. The link names the host by installation
    // id, because that is the id every client of the host resolves it by;
    // `local` means a different machine on each client.
    knownHosts.set('local', { installationId: 'install-desktop' })
    knownHosts.set('managed-host', { installationId: 'managed-host' })
    const { store } = await newStore()
    const { parseRoute } = await import('@solus/workspace-ui/contexts/workspace/routing/codec')
    const session: ShareResource = { kind: 'session', id: 'session-1' }

    for (const [serverId, installationId] of [['local', 'install-desktop'], ['managed-host', 'managed-host']]) {
      const url = new URL(store.memberLinkUrl(serverId, session) ?? '')
      expect(url.origin).toBe('https://app.example.test')
      expect(parseRoute(url.pathname)).toMatchObject({ name: 'sessionRecord', params: { sessionId: 'session-1', serverId: installationId } })
    }
    expect(store.memberLinkUrl('unknown-host', session)).toBeNull()
    expect(store.memberLinkUrl('local', { kind: 'work', id: 'work-1' })).toBeNull()
    account.state.kind = 'signed-out'
    expect(store.memberLinkUrl('managed-host', session)).toBeNull()
  })
})

describe('sharing a Local resource', () => {
  const work: ShareResource = { kind: 'work', id: 'w1' }
  const workTarget = { serverId: 'local', resource: work, title: 'Release plan' }

  test('a work already in an organization opens directly on that organization\'s list', async () => {
    // WHY: the work's own record says where it lives; asking its machine again
    // would upload it twice, and the machine refuses a work that already moved.
    let exports = 0
    connections.registerPrimary('local', {
      workExportForCloud: async () => { exports++; throw new Error('This work already belongs to an organization.') },
    })
    registerCloud()
    const { store, works } = await newStore()
    works.w1 = { organizationId: 'org-1' }

    await store.open(workTarget)

    expect(exports).toBe(0)
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: work, title: 'Release plan' })
  })

  test('a machine that is not connected cannot publish, and the dialog says so', async () => {
    connections.registerPrimary('local', {
      workExportForCloud: async () => { throw new Error('must not be asked') },
    })
    offlineServerIds.add('local')
    const { store } = await newStore()

    await store.open(workTarget)
    await settle()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })

    await store.publish()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })
  })

  test('with no organization selected, Share explains instead of pushing', async () => {
    // WHY: a work is pushed into an organization; with none selected there is nowhere to push.
    window.activeOrganizationId = null
    window.activeOrganizationName = null
    const { store } = await newStore()

    await store.open(workTarget)

    expect(store.dialog).toBeNull()
    expect(toastCalls).toEqual(['error:Sign in to share this work.'])
  })
})


describe('sharing a Local work', () => {
  const work: ShareResource = { kind: 'work', id: 'w1' }
  const workTarget = { serverId: 'local', resource: work, title: 'Release plan' }
  const transfer = { work: { id: 'w1' }, previousRevisionId: null, revisions: [], annotations: null, fingerprint: 'fp-1' }
  const workList: ShareList = { ...cloudList, resource: work }

  /** The machine gives the work and marks it moved; the cloud stores the upload. Every call is recorded. */
  function machineAndCloud(options: { upload?: () => Promise<unknown>; markMoved?: () => Promise<void> } = {}) {
    const calls: string[] = []
    connections.registerPrimary('local', {
      workExportForCloud: async (workId: string) => { calls.push(`export:${workId}`); return transfer },
      workMarkMoved: async (workId: string, fingerprint: string) => { calls.push(`mark-moved:${workId}:${fingerprint}`); await options.markMoved?.() },
    })
    connections.registerHost(CLOUD, {
      shareGet: async () => workList,
      connectionsGetServerInfo: async () => ({ principal: 'org-member', userId: 'u1', organizationId: 'org-1' }),
      workUpload: async (sent: unknown) => {
        calls.push(`upload:${sent === transfer ? 'the export' : 'something else'}`)
        return options.upload ? options.upload() : { workId: 'w1', organizationId: 'org-1' }
      },
    })
    return calls
  }

  test('Share reads the work from the machine, uploads that export to the organization, then marks the local copy moved', async () => {
    // WHY: a work is a cloud copy made with the person's sign-in; the machine only
    // gives it and marks it moved, so the host link plays no part (docs/plans/cloud-sharing.md §3).
    const calls = machineAndCloud()
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export', 'mark-moved:w1:fp-1'])
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: work, title: 'Release plan' })
  })

  test('Share does not read the account directory for an organization this client already knows', async () => {
    // WHY: each directory read is a round trip to the account plane before the
    // upload can start. The directory is read only to find a service not known yet.
    const calls = machineAndCloud()
    knownWorkspaces.add(CLOUD)
    const { store } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export', 'mark-moved:w1:fp-1'])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: work, title: 'Release plan' })
    expect(directoryReads).toBe(0)
  })

  test('a refused upload keeps the local copy and shows the reason with Retry', async () => {
    // WHY: the local copy points at the cloud only after the cloud has it.
    const calls = machineAndCloud({ upload: async () => { throw new Error('This work already belongs to another organization.') } })
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export'])
    expect(published).toEqual([])
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'This work already belongs to another organization.' })
  })

  test('a work that changed after it was read stays on the machine, and Share says so', async () => {
    const calls = machineAndCloud({ markMoved: async () => { throw new Error('The work changed during the cloud push. Its local copy was kept.') } })
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export', 'mark-moved:w1:fp-1'])
    expect(published).toEqual([])
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'The work changed during the cloud push. Its local copy was kept.' })
  })

  test('a session is shared from any machine, signed in or not; a work needs a signed-in organization to push to', async () => {
    // WHY: docs/plans/host-sharing.md §2 — a session's link names its host; a
    // Local work is pushed to the cloud by Share, so it needs somewhere to go.
    const { store } = await newStore()
    expect(store.canShareFrom('local', 'work')).toBe(true)
    expect(store.canShareFrom('local', 'session')).toBe(true)
    window.activeOrganizationId = null
    expect(store.canShareFrom('local', 'work')).toBe(false)
    expect(store.canShareFrom('local', 'session')).toBe(true)
    account.state.kind = 'signed-out'
    expect(store.canShareFrom('local', 'work')).toBe(false)
    expect(store.canShareFrom('local', 'session')).toBe(true)
  })

  test('Share opened again while the upload runs joins it instead of uploading twice', async () => {
    // WHY: closing the dialog does not cancel the upload; opening it again must not start a second copy.
    let releaseUpload: () => void = () => {}
    const uploaded = new Promise<void>((resolve) => { releaseUpload = resolve })
    const calls = machineAndCloud({ upload: async () => { await uploaded; return { workId: 'w1', organizationId: 'org-1' } } })
    const { store } = await newStore()

    await store.open(workTarget)
    store.close()
    await store.open(workTarget)
    releaseUpload()
    await settle()
    await settle()

    expect(calls.filter((call) => call.startsWith('upload'))).toHaveLength(1)
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: work, title: 'Release plan' })
  })
})

/** Task links over the store's own publication, as the app wires them. */
async function taskLinksFor(store: { publication: CloudPublication }) {
  const { TaskLinks } = await import('@solus/workspace-ui/contexts/tasks/task-links')
  return new TaskLinks(store.publication)
}

/** What a copied task link opens: the app's own route, read back the way the web client reads it. */
async function opensTaskOf(url: string): Promise<{ origin: string; taskId?: string; serverId?: string }> {
  const { parseRoute } = await import('@solus/workspace-ui/contexts/workspace/routing/codec')
  const parsed = new URL(url)
  const ref = parseRoute(parsed.pathname)
  return ref?.name === 'task' ? { origin: parsed.origin, taskId: ref.params.taskId, serverId: ref.params.serverId } : { origin: parsed.origin }
}

describe('a task\'s link', () => {
  const taskTransfer = { task: { id: 't1' }, comments: [], workIds: ['w1'], fingerprint: 'task-fp' }
  const workTransfer = { work: { id: 'w1' }, previousRevisionId: null, revisions: [], annotations: null, fingerprint: 'work-fp' }
  let copied: string[] = []
  beforeEach(() => {
    copied = []
    account.state = { kind: 'signed-in', consoleUrl: 'https://app.example.test' }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied.push(text) } } } })
  })

  test('Copy link puts a Local task in the organization with everything linked to it, then copies the address that opens it', async () => {
    // WHY: a task is not shared on its own; its organization sees it. Its link
    // must open the task there, so a Local task goes first, with its linked
    // works ahead of it (docs/plans/cloud-sharing.md §8), and leaves the machine.
    const calls: string[] = []
    connections.registerPrimary('local', {
      taskExportForCloud: async (taskId: string) => { calls.push(`export:${taskId}`); return { task: taskTransfer, works: [workTransfer] } },
      taskMarkMoved: async (taskId: string, fingerprint: string, works: Array<{ workId: string; fingerprint: string }>) => {
        calls.push(`mark-moved:${taskId}:${fingerprint}:${works.map((work) => `${work.workId}:${work.fingerprint}`).join(',')}`)
      },
    })
    connections.registerHost(CLOUD, {
      workUpload: async (sent: { work: { id: string } }) => { calls.push(`upload-work:${sent.work.id}`); return { workId: sent.work.id, organizationId: 'org-1' } },
      taskUpload: async (sent: { task: { id: string } }) => { calls.push(`upload-task:${sent.task.id}`); return { taskId: sent.task.id, organizationId: 'org-1' } },
    })
    const { store, published } = await newStore()
    const links = await taskLinksFor(store)

    await links.copy('local', 't1')

    expect(calls).toEqual(['export:t1', 'upload-work:w1', 'upload-task:t1', 'mark-moved:t1:task-fp:w1:work-fp'])
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(await Promise.all(copied.map(opensTaskOf))).toEqual([{ origin: 'https://app.example.test', taskId: 't1', serverId: CLOUD }])
    expect(store.dialog).toBeNull()
  })

  test('a task already in the organization copies its link with no upload, and a task is never offered Share', async () => {
    const { store } = await newStore()
    await (await taskLinksFor(store)).copy(CLOUD, 't1')
    expect(await Promise.all(copied.map(opensTaskOf))).toEqual([{ origin: 'https://app.example.test', taskId: 't1', serverId: CLOUD }])
    expect(store.canShareFrom('local', 'task')).toBe(false)
    expect(store.canShareFrom(CLOUD, 'task')).toBe(false)
  })

  test('without an account or an organization there is no link, and nothing leaves the machine', async () => {
    const links = await taskLinksFor((await newStore()).store)
    account.state = { kind: 'signed-out' }
    expect(links.canCopy('local')).toBe(false)
    await links.copy('local', 't1')
    account.state = { kind: 'signed-in', consoleUrl: 'https://app.example.test' }
    window.activeOrganizationId = null
    expect(links.canCopy('local')).toBe(false)
    expect(links.canCopy(CLOUD)).toBe(true)
    await links.copy('local', 't1')
    expect(copied).toEqual([])
    expect(toastCalls.every((call) => call.startsWith('error:'))).toBe(true)
  })
})

describe('the share dialog on Solus Cloud', () => {
  afterEach(() => configureUplinkAccountSource(null))

  test('opens on the share list without waiting for the organization\'s people', async () => {
    // WHY: the list and the link are what a person opens Share for; the people
    // to invite load beside them, so a slow member list never holds the dialog.
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: () => new Promise(() => {}),
    })
    registerCloud()
    knownWorkspaces.add(CLOUD)
    const { store } = await newStore()

    await store.open({ ...target, serverId: CLOUD })

    expect(store.dialog).toEqual({ serverId: CLOUD, resource, title: 'Release plan' })
    expect(store.listFor(CLOUD, resource)).toEqual(cloudList)
    expect(store.busy).toBe(false)
    expect(directoryReads).toBe(0)
  })

  test('opening again keeps the people already known while their new answer loads', async () => {
    // WHY: the dialog names people from the directory. If a reopen forgot it, the
    // owner would show as a former member until the account plane answered again.
    let answer: (directory: { organizationId: string; name: string; members: []; teams: [] }) => void = () => {}
    let loads = 0
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: (organizationId) => {
        loads++
        return loads === 1 ? Promise.resolve({ organizationId, name: 'Acme', members: [], teams: [] }) : new Promise((resolve) => { answer = resolve })
      },
    })
    registerCloud()
    knownWorkspaces.add(CLOUD)
    const { store } = await newStore()
    const known = await store.loadDirectory()

    await store.open({ ...target, serverId: CLOUD })

    expect(loads).toBe(2)
    expect(store.directory).toBe(known)
    answer({ organizationId: 'org-1', name: 'Acme Inc', members: [], teams: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(store.directory?.name).toBe('Acme Inc')
  })

  test('a new link is kept from the answer, not read again', async () => {
    // WHY: Copy link waits on every call in its chain; the host's answer is the new link.
    let reads = 0
    const link = { role: 'viewer' as const, secret: 'secret-1' }
    connections.registerHost(CLOUD, {
      shareGet: async () => { reads++; return cloudList },
      shareSetLink: async () => link,
    })
    const { store } = await newStore()
    await store.load(CLOUD, resource)

    expect(await store.setLink(CLOUD, resource, 'viewer')).toEqual(link)
    expect(store.listFor(CLOUD, resource)).toEqual({ ...cloudList, link })
    expect(reads).toBe(1)
  })
})

describe('the organization directory', () => {
  afterEach(() => configureUplinkAccountSource(null))

  test('answers the members as users, converted once, and reads the account plane once per organization', async () => {
    // WHY (plans/012 §6): the mention picker, the share dialog and every other people
    // choice read one member list of `User`s; none of them converts the directory again.
    let loads = 0
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: async (organizationId) => {
        loads++
        return {
          organizationId,
          name: 'Acme',
          members: [{ userId: 'u_ann', name: 'Ann Lee', email: 'ann@acme.dev', image: 'https://img/ann.png', role: 'owner' }],
          teams: [],
        }
      },
    })
    registerCloud()
    const { store } = await newStore()

    const people = await store.loadDirectory()

    expect(people?.members).toEqual([
      { id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Lee', email: 'ann@acme.dev', avatarUrl: 'https://img/ann.png' },
    ])
    expect(await store.loadDirectory()).toBe(people)
    expect(store.directory).toBe(people)
    expect(loads).toBe(1)
  })

  test('a share opened on a second host shows the people already known while they refresh', async () => {
    // WHY: the people belong to the organization, not to a host. Keeping them per
    // host made the first Share on every host wait for the account plane again,
    // and the Add people field arrived after the dialog.
    let loads = 0
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: (organizationId) => {
        loads++
        return loads === 1 ? Promise.resolve({ organizationId, name: 'Acme', members: [], teams: [] }) : new Promise(() => {})
      },
    })
    connections.registerHost('other-host', { shareGet: async () => cloudList })
    const { store } = await newStore()
    const people = await store.loadDirectory()

    await store.open({ ...target, serverId: 'other-host' })

    expect(loads).toBe(2)
    expect(store.dialog?.serverId).toBe('other-host')
    expect(store.directoryLoaded).toBe(true)
    expect(store.directory).toBe(people)
  })

  test('a failed first read counts as loaded with no people, so the dialog stops waiting', async () => {
    // WHY: the Add people field shows "Loading people…" until the directory is
    // loaded. A read that fails must end that state, or the field waits for ever.
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: async () => { throw new Error('account plane down') },
    })
    const { store } = await newStore()
    expect(store.directoryLoaded).toBe(false)

    await expect(store.loadDirectory()).rejects.toThrow('account plane down')

    expect(store.directoryLoaded).toBe(true)
    expect(store.directory).toBeNull()
  })

  test('another organization has its own people', async () => {
    // WHY: one list per organization; switching the window's organization must not show the last one's people.
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      accessToken: unavailable,
      issueEnrollmentTicket: unavailable,
      startManagedHost: unavailable,
      loadOrganizationDirectory: async (organizationId) => ({ organizationId, name: organizationId, members: [], teams: [] }),
    })
    const { store } = await newStore()
    await store.loadDirectory()

    window.activeOrganizationId = 'org-2'

    expect(store.directoryLoaded).toBe(false)
    expect(store.directory).toBeNull()
    expect((await store.loadDirectory())?.name).toBe('org-2')
  })
})

test('sharing identity follows the connection answer after reconnect instead of a separate identity cache', async () => {
  let userId = 'first-person'
  connections.registerHost('identity-host', {
    connectionsGetServerInfo: async () => ({ principal: 'org-member', userId, organizationId: 'org-1' }),
  })
  const { SharesStore } = await import('@solus/workspace-ui/contexts/sharing/shares.store.svelte')
  const store = new SharesStore()
  expect((await store.identityFor('identity-host')).userId).toBe('first-person')
  // The connection owner supplies the current session's answer; the sharing
  // projection must not hide it behind another independently cached answer.
  userId = 'second-person'
  expect((await store.identityFor('identity-host')).userId).toBe('second-person')
  expect(store.identities.get('identity-host')?.userId).toBe('second-person')
})
