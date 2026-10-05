import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Publication, PublicationStartRequest } from '@solus/contracts/organization-scope'
import type { ShareList, ShareResource } from '@solus/contracts/sharing'
import { configureUplinkAccountSource } from '@solus/client-core/uplink-account'
import { singleHostServerConnections } from './helpers/server-connections-mock'

// docs/plans/organization-scope.md §7: the Share action is the opt-in to publish.
// Opening Share on a Local resource starts its upload into the window's
// organization at once, with no second confirmation. A session is published by
// its machine, and the dialog continues once the machine reports `committed`. A
// work is uploaded by the client with its own sign-in (docs/plans/cloud-sharing.md).

const connections = singleHostServerConnections()
const offlineServerIds = new Set<string>()

mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    ...connections,
    statusFor: (serverId: string) => (offlineServerIds.has(serverId) ? 'disconnected' : 'connected'),
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
const window = { activeOrganizationId: 'org-1' as string | null, activeOrganizationName: 'Acme' as string | null }
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: {
    get activeOrganizationId() { return window.activeOrganizationId },
    get activeOrganizationName() { return window.activeOrganizationName },
    refreshDirectory: async () => { directoryReads++ },
    hostFor: () => null,
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

const cloudList: ShareList = { resource, ownerUserId: 'u1', grants: [], callerRole: 'owner', link: null }

function publication(state: Publication['state'], error?: string): Publication {
  const record: Publication = { id: 'p1', resource, organizationId: 'org-1', actorUserId: 'u1', state, createdAt: 1, updatedAt: 1 }
  if (error) record.error = error
  return record
}

/** The organization's workspace service, ready to list the resource's share. */
function registerCloud(): void {
  connections.registerHost(CLOUD, {
    shareGet: async () => cloudList,
    connectionsGetServerInfo: async () => ({ principal: 'org-member', userId: 'u1', organizationId: 'org-1' }),
  })
}

async function newStore() {
  const { SharesStore } = await import('@solus/workspace-ui/contexts/sharing/shares.store.svelte')
  const store = new SharesStore({ pollMs: 5 })
  const published: [string, string, string][] = []
  store.works = { markPublished: (workId: string, organizationId: string, cloudServerId: string) => { published.push([workId, organizationId, cloudServerId]) } } as never
  return { store, published }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('sharing while signed out', () => {
  test('does not read or publish a resource, open a dialog, or create a report', async () => {
    const calls: string[] = []
    connections.registerPrimary('local', {
      publicationList: async () => { calls.push('read'); return [] },
      publicationStart: async () => { calls.push('publish'); return publication('pending') },
      createWork: async () => { calls.push('create'); return { id: 'report-1' } },
    })
    connections.registerHost(CLOUD, {
      shareGet: async () => { calls.push('share'); return cloudList },
    })
    const { store } = await newStore()
    account.state.kind = 'signed-out'

    await store.open(target)
    await store.open({ ...target, serverId: CLOUD })
    await store.shareReport('local', { title: 'Turn report', content: '# Turn report', agentProvider: 'claude-code' })

    expect(calls).toEqual([])
    expect(store.dialog).toBeNull()
    expect(store.busy).toBe(false)
    expect(toastCalls).toEqual([])
  })
})

describe('sharing a Local resource', () => {
  test('opening Share publishes on the source machine, waits for committed, then loads the organization\'s share list', async () => {
    const starts: PublicationStartRequest[] = []
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async (request: PublicationStartRequest) => { starts.push(request); return publication('pending') },
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    await settle()

    // WHY: Share is the opt-in (§7). The upload starts without a second
    // confirmation, into the window's organization, and the dialog says so.
    expect(starts).toEqual([{ resource, organizationId: 'org-1' }])
    expect(store.dialog).toMatchObject({
      serverId: 'local',
      publication: { sourceServerId: 'local', organizationId: 'org-1', organizationName: 'Acme', status: { kind: 'pending' } },
    })
    // The list is not read from the cloud before the receipt: no working-looking link early.
    expect(store.listFor(CLOUD, resource)).toBeUndefined()

    connections.emit('local', 'publication.changed', publication('committed'))
    await settle()

    // WHY: the receipt is what makes the workspace service the record's home. Only
    // then does the store follow the session there and read the cloud share list.
    expect(store.dialog).toEqual({ serverId: CLOUD, resource, title: 'Release plan' })
    expect(store.listFor(CLOUD, resource)).toEqual(cloudList)
    expect(directoryReads).toBe(1)
  })

  test('without the event, the machine is re-read until it reports the receipt', async () => {
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => (reads++ < 2 ? [publication('pending')] : [publication('committed')]),
      publicationStart: async () => publication('pending'),
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    await store.publishResource({ serverId: 'local', resource, organizationId: 'org-1' })
    await settle()

    expect(reads).toBeGreaterThanOrEqual(3)
    expect(store.dialog?.serverId).toBe(CLOUD)
  })

  test('a publication the machine holds until the publisher reconnects shows the reason, offers Retry, and stops asking', async () => {
    // WHY: the machine could not send as the publisher and said so on a `sent`
    // row. The dialog waited only for committed or failed, so it showed
    // "Uploading…" forever and asked the machine twice a second.
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => { reads++; return [publication('sent')] },
      publicationStart: async () => publication('pending'),
    })
    const { store } = await newStore()

    await store.open(target)
    await settle()
    connections.emit('local', 'publication.changed', publication('sent', 'Your sign-in for this machine expired. Reconnect and send again.'))
    await settle()

    expect(store.dialog?.publication?.status).toEqual({ kind: 'waiting', error: 'Your sign-in for this machine expired. Reconnect and send again.' })
    const readsWhenAnswered = reads
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reads).toBe(readsWhenAnswered)
  })

  test('without the event, re-reads back off instead of asking at a fixed rate', async () => {
    let reads = 0
    connections.registerPrimary('local', {
      publicationList: async () => { reads++; return [publication('sent')] },
      publicationStart: async () => publication('pending'),
    })
    const { store } = await newStore()

    await store.open(target)
    // A fixed 5 ms rate would read about 30 times here; doubling from 5 ms reads 4 or 5 times.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(reads).toBeLessThanOrEqual(6)
    store.close()
  })

  test('a failed publication keeps the dialog in the publish state with the error, and Retry publishes again', async () => {
    let attempt = 0
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async () => (++attempt === 1 ? publication('pending') : publication('committed')),
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    await settle()
    connections.emit('local', 'publication.changed', publication('failed', 'The organization refused the upload.'))
    await settle()

    // WHY: the source is preserved and the state is retryable; the reservation
    // keeps the same destination, so a retry cannot pick another organization.
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'The organization refused the upload.' })

    await store.publish()
    expect(attempt).toBe(2)
    expect(store.dialog?.serverId).toBe(CLOUD)
  })

  test('closing the dialog while the upload runs leaves it closed', async () => {
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async () => publication('pending'),
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)
    store.close()
    connections.emit('local', 'publication.changed', publication('committed'))
    await settle()

    // WHY: Done is the way out at every step; a late receipt must not raise the dialog again.
    expect(store.dialog).toBeNull()
  })

test('a resource the machine already published opens directly on its organization\'s list', async () => {
    let starts = 0
    connections.registerPrimary('local', {
      publicationList: async () => [publication('committed')],
      publicationStart: async () => { starts++; throw new Error('already published') },
    })
    registerCloud()
    const { store } = await newStore()

    await store.open(target)

    expect(starts).toBe(0)
    expect(store.dialog).toEqual({ serverId: CLOUD, resource, title: 'Release plan' })
  })

  test('a machine that is not connected cannot publish, and the dialog says so', async () => {
    connections.registerPrimary('local', {
      publicationList: async () => { throw new Error('offline') },
      publicationStart: async () => { throw new Error('must not be asked') },
    })
    offlineServerIds.add('local')
    const { store } = await newStore()

    await store.open(target)
    await settle()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })

    await store.publish()
    expect(store.dialog?.publication?.status).toEqual({ kind: 'offline' })
  })

  test('with no organization selected, Share explains instead of opening', async () => {
    window.activeOrganizationId = null
    window.activeOrganizationName = null
    connections.registerPrimary('local', { publicationList: async () => [] })
    const { store } = await newStore()

    await store.open(target)

    expect(store.dialog).toBeNull()
    expect(toastCalls).toEqual(['error:Select an organization before sharing.'])
  })
})


describe('sharing a Local work', () => {
  const work: ShareResource = { kind: 'work', id: 'w1' }
  const workTarget = { serverId: 'local', resource: work, title: 'Release plan' }
  const transfer = { work: { id: 'w1' }, previousRevisionId: null, revisions: [], annotations: null, fingerprint: 'fp-1' }
  const workList: ShareList = { ...cloudList, resource: work }

  /** The machine gives the work and removes it; the cloud stores the upload. Every call is recorded. */
  function machineAndCloud(options: { upload?: () => Promise<unknown>; remove?: () => Promise<void> } = {}) {
    const calls: string[] = []
    connections.registerPrimary('local', {
      publicationList: async () => [],
      publicationStart: async () => { calls.push('publicationStart'); throw new Error('a work is not published by the machine') },
      workExportForCloud: async (workId: string) => { calls.push(`export:${workId}`); return transfer },
      workRemoveUploaded: async (workId: string, fingerprint: string) => { calls.push(`remove:${workId}:${fingerprint}`); await options.remove?.() },
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

  test('Share reads the work from the machine, uploads that export to the organization, then removes the local copy', async () => {
    // WHY: a work is a cloud copy made with the person's sign-in; the machine only
    // gives and removes it, so the host link plays no part (docs/plans/cloud-sharing.md §3).
    const calls = machineAndCloud()
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export', 'remove:w1:fp-1'])
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

    expect(calls).toEqual(['export:w1', 'upload:the export', 'remove:w1:fp-1'])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: work, title: 'Release plan' })
    expect(directoryReads).toBe(0)
  })

  test('a refused upload keeps the local copy and shows the reason with Retry', async () => {
    // WHY: the local copy goes only after the cloud has it.
    const calls = machineAndCloud({ upload: async () => { throw new Error('This work already belongs to another organization.') } })
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export'])
    expect(published).toEqual([])
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'This work already belongs to another organization.' })
  })

  test('a work that changed after it was read stays on the machine, and Share says so', async () => {
    const calls = machineAndCloud({ remove: async () => { throw new Error('The work changed during the cloud push. Its local copy was kept.') } })
    const { store, published } = await newStore()

    await store.open(workTarget)
    await settle()

    expect(calls).toEqual(['export:w1', 'upload:the export', 'remove:w1:fp-1'])
    expect(published).toEqual([])
    expect(store.dialog?.publication?.status).toEqual({ kind: 'failed', error: 'The work changed during the cloud push. Its local copy was kept.' })
  })

  test('a work can be shared from a machine that is not linked; a session cannot', async () => {
    // WHY: the user's rule: sharing a work needs only a signed-in organization.
    // A session needs its machine linked, because the machine sends its later turns.
    const { store } = await newStore()
    expect(store.canShareFrom('local', 'work')).toBe(true)
    expect(store.canShareFrom('local', 'session')).toBe(false)
    window.activeOrganizationId = null
    expect(store.canShareFrom('local', 'work')).toBe(false)
  })

  test('publish entry points share one upload and report the captured organization after a switch', async () => {
    let releaseUpload: () => void = () => {}
    const uploaded = new Promise<void>((resolve) => { releaseUpload = resolve })
    const calls = machineAndCloud({ upload: async () => { await uploaded; return { workId: 'w1', organizationId: 'org-1' } } })
    const { store } = await newStore()
    const first = store.publishWork('local', 'w1')
    const second = store.publishWork('local', 'w1')
    const followed = store.publishResource({ serverId: 'local', resource: work, organizationId: 'org-1' })
    expect(store.isPublishing('local', work)).toBe(true)
    window.activeOrganizationId = 'org-2'
    window.activeOrganizationName = 'Beta'
    expect(await store.publishResource({ serverId: 'local', resource: work, organizationId: 'org-2' })).toMatchObject({ kind: 'failed' })
    releaseUpload()
    await Promise.all([first, second, followed])
    expect(calls.filter((call) => call.startsWith('upload'))).toHaveLength(1)
    expect(toastCalls).toEqual(['success:Published to Acme'])
    expect(store.isPublishing('local', work)).toBe(false)
  })
})

/** What a copied task link opens: the app's own route, read back the way the web client reads it. */
async function opensTaskOf(url: string): Promise<{ origin: string; taskId?: string; serverId?: string }> {
  const { parseRoute } = await import('@solus/workspace-ui/contexts/workspace/routing/codec')
  const parsed = new URL(url)
  const ref = parseRoute(parsed.hash.slice(1))
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
      taskRemoveUploaded: async (taskId: string, fingerprint: string, works: Array<{ workId: string; fingerprint: string }>) => {
        calls.push(`remove:${taskId}:${fingerprint}:${works.map((work) => `${work.workId}:${work.fingerprint}`).join(',')}`)
      },
    })
    connections.registerHost(CLOUD, {
      workUpload: async (sent: { work: { id: string } }) => { calls.push(`upload-work:${sent.work.id}`); return { workId: sent.work.id, organizationId: 'org-1' } },
      taskUpload: async (sent: { task: { id: string } }) => { calls.push(`upload-task:${sent.task.id}`); return { taskId: sent.task.id, organizationId: 'org-1' } },
    })
    const { store, published } = await newStore()

    await store.copyTaskLink('local', 't1')

    expect(calls).toEqual(['export:t1', 'upload-work:w1', 'upload-task:t1', 'remove:t1:task-fp:w1:work-fp'])
    expect(published).toEqual([['w1', 'org-1', CLOUD]])
    expect(await Promise.all(copied.map(opensTaskOf))).toEqual([{ origin: 'https://app.example.test', taskId: 't1', serverId: CLOUD }])
    expect(store.dialog).toBeNull()
  })

  test('a task already in the organization copies its link with no upload, and a task is never offered Share', async () => {
    const { store } = await newStore()
    await store.copyTaskLink(CLOUD, 't1')
    expect(await Promise.all(copied.map(opensTaskOf))).toEqual([{ origin: 'https://app.example.test', taskId: 't1', serverId: CLOUD }])
    expect(store.canShareFrom('local', 'task')).toBe(false)
    expect(store.canShareFrom(CLOUD, 'task')).toBe(false)
  })

  test('without an account or an organization there is no link, and nothing leaves the machine', async () => {
    const { store } = await newStore()
    account.state = { kind: 'signed-out' }
    expect(store.canCopyTaskLink('local')).toBe(false)
    await store.copyTaskLink('local', 't1')
    account.state = { kind: 'signed-in', consoleUrl: 'https://app.example.test' }
    window.activeOrganizationId = null
    expect(store.canCopyTaskLink('local')).toBe(false)
    expect(store.canCopyTaskLink(CLOUD)).toBe(true)
    await store.copyTaskLink('local', 't1')
    expect(copied).toEqual([])
    expect(toastCalls.every((call) => call.startsWith('error:'))).toBe(true)
  })
})

describe('sharing an Insights report', () => {
  test('Share files the report as a Local work on the machine, then uploads it like any work', async () => {
    // WHY: a report reads the same while the computer that ran the turn is off, so it
    // leaves as a cloud copy; nothing about it needs the host link.
    const calls: string[] = []
    const transfer = { work: { id: 'report-1' }, previousRevisionId: null, revisions: [], annotations: null, fingerprint: 'fp' }
    connections.registerPrimary('local', {
      publicationList: async () => [],
      createWork: async (title: string, type: string, content: string) => { calls.push(`create:${type}:${title}:${content}`); return { id: 'report-1' } },
      workExportForCloud: async (workId: string) => { calls.push(`export:${workId}`); return transfer },
      workRemoveUploaded: async (workId: string) => { calls.push(`remove:${workId}`) },
    })
    connections.registerHost(CLOUD, {
      shareGet: async () => ({ ...cloudList, resource: { kind: 'work', id: 'report-1' } }),
      connectionsGetServerInfo: async () => ({ principal: 'org-member', userId: 'u1', organizationId: 'org-1' }),
      workUpload: async () => { calls.push('upload'); return { workId: 'report-1', organizationId: 'org-1' } },
    })
    const { store } = await newStore()

    await store.shareReport('local', { title: 'Turn report', content: '# Turn report', agentProvider: 'claude-code' })
    await settle()

    expect(calls).toEqual(['create:insights-report:Turn report:# Turn report', 'export:report-1', 'upload', 'remove:report-1'])
    expect(store.dialog).toEqual({ serverId: CLOUD, resource: { kind: 'work', id: 'report-1' }, title: 'Turn report' })
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
      acquireHostAccessToken: unavailable,
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

  test('answers the members as users, converted once, and reads the account plane once per host', async () => {
    // WHY (plans/012 §6): the mention picker, the share dialog and every other people
    // choice read one member list of `User`s; none of them converts the directory again.
    let loads = 0
    const unavailable = async (): Promise<never> => { throw new Error('not in this test') }
    configureUplinkAccountSource({
      listDirectory: unavailable,
      acquireHostAccessToken: unavailable,
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

    const people = await store.directoryFor(CLOUD)

    expect(people?.members).toEqual([
      { id: { kind: 'account', accountId: 'u_ann' }, displayName: 'Ann Lee', email: 'ann@acme.dev', avatarUrl: 'https://img/ann.png' },
    ])
    expect(await store.directoryFor(CLOUD)).toBe(people)
    expect(store.directories.get(CLOUD)).toBe(people)
    expect(loads).toBe(1)
  })
})
