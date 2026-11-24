import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { CODEBASE_ROOTS_MAX, type Codebase, type CodebaseFolderScan, type CodebaseMember, type CodebaseRoot } from '@solus/contracts/codebases'
import type { CodebaseHostAccess, CodebaseHostApi } from '@solus/workspace-ui/contexts/codebases/codebase-host-access'
import { CodebaseRootRefused } from '@solus/client-core/codebases'

// Each test gives the store its own hosts. The live access reads the connection
// stores of the app, which a unit test does not load.
mock.module('@solus/workspace-ui/contexts/codebases/codebase-host-access', () => ({ liveCodebaseHostAccess: null }))

let CodebasesStore: typeof import('@solus/workspace-ui/contexts/codebases/codebases.store.svelte')['CodebasesStore']
beforeAll(async () => {
  ;({ CodebasesStore } = await import('@solus/workspace-ui/contexts/codebases/codebases.store.svelte'))
})

/**
 * The client side of codebases (docs/plans/codebases.md decision 6 and §9):
 * each host keeps the full record, and this store moves the newest copy to
 * each host that does not have it.
 */

function root(installationId: string, path: string): CodebaseRoot {
  return { installationId, path, name: path.split('/').at(-1)! }
}

/** A folder on a host that no test connects: the second folder of a codebase, which has two or more. */
const ELSEWHERE = root('inst-elsewhere', '/srv/elsewhere')
/** The roots of a codebase whose folders a test does not read. */
const TWO_ROOTS = [root('inst-elsewhere', '/srv/one'), root('inst-elsewhere', '/srv/two')]

function codebase(id: string, updatedAt: number, patch: Partial<Codebase> = {}): Codebase {
  return { id, name: id, roots: TWO_ROOTS, updatedAt, deletedAt: null, ...patch }
}

function member(path: string, rootPath: string, patch: Partial<CodebaseMember> = {}): CodebaseMember {
  return { path, name: path.split('/').at(-1)!, state: 'git', repositoryKey: null, rootPath, discovered: path !== rootPath, hasCommit: true, submodule: false, ...patch }
}

/** A host that keeps codebases by the rule of the real one: the newer copy wins, and a save answers the kept copy. */
class FakeHost {
  readonly kept = new Map<string, Codebase>()
  readonly saves: Codebase[] = []
  lists = 0
  isReady = true
  members: CodebaseMember[] = []
  membersError: string | null = null
  saveError: string | null = null
  scans = new Map<string, CodebaseFolderScan>()

  constructor(readonly serverId: string, readonly installationId: string, copies: Codebase[] = []) {
    for (const copy of copies) this.kept.set(copy.id, copy)
  }

  readonly api: CodebaseHostApi = {
    codebaseList: async () => { this.lists++; return [...this.kept.values()] },
    codebaseSave: async (copy) => {
      if (this.saveError) throw new Error(this.saveError)
      this.saves.push(copy)
      const current = this.kept.get(copy.id)
      if (!current || copy.updatedAt > current.updatedAt) this.kept.set(copy.id, copy)
      return this.kept.get(copy.id)!
    },
    codebaseMembers: async (codebaseId) => {
      if (this.membersError) throw new Error(this.membersError)
      if (!this.kept.has(codebaseId)) throw new Error('This host has no copy of that codebase.')
      return this.members
    },
    codebaseScanFolder: async (path) => this.scans.get(path) ?? { path, state: 'plain', members: [], suggestions: [] },
  }
}

function setup(hosts: FakeHost[], now = 1_000) {
  const clock = { now }
  const readiness = new Set<(serverId: string, isReady: boolean) => void>()
  const access: CodebaseHostAccess = {
    machines: () => hosts.map((host) => ({ serverId: host.serverId, installationId: host.installationId, label: host.serverId, isReady: host.isReady })),
    resolveId: (installationId) => hosts.find((host) => host.installationId === installationId)?.serverId ?? installationId,
    api: (serverId) => hosts.find((host) => host.serverId === serverId)!.api,
    onReadinessChange: (listener) => { readiness.add(listener); return () => readiness.delete(listener) },
    onCodebasesChanged: () => () => {},
  }
  const store = new CodebasesStore(access, () => clock.now)
  const setReady = (host: FakeHost, isReady: boolean) => {
    host.isReady = isReady
    for (const listener of readiness) listener(host.serverId, isReady)
  }
  return { store, clock, setReady }
}

/** Let the sends that a load started finish. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('codebases across hosts', () => {
  // WHY: each host keeps the full record. A host with an older copy must get
  // the newer one, one time: a save answers the kept copy, so a second read
  // finds nothing to send.
  test('the host with the older copy gets one save, and a second load sends nothing', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { name: 'Shop' })])
    const server = new FakeHost('build', 'inst-build', [codebase('shop', 10, { name: 'Old shop' })])
    const { store } = setup([mac, server])

    await store.load('local')
    await store.load('build')
    await settle()

    expect(store.codebases.map((entry) => entry.name)).toEqual(['Shop'])
    expect(server.saves).toEqual([codebase('shop', 20, { name: 'Shop' })])
    expect(mac.saves).toEqual([])

    await store.load('local')
    await store.load('build')
    await settle()
    expect(server.saves).toHaveLength(1)
    expect(mac.saves).toEqual([])
  })

  // WHY: a delete is a tombstone so that it moves. A host that still has the
  // live copy must not bring the codebase back.
  test('a tombstone on one host removes the codebase and goes to the other host', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 30, { deletedAt: 30 })])
    const server = new FakeHost('build', 'inst-build', [codebase('shop', 10), codebase('docs', 5)])
    const { store } = setup([mac, server])

    await store.load('local')
    await store.load('build')
    await settle()

    expect(store.codebases.map((entry) => entry.id)).toEqual(['docs'])
    expect(store.codebaseOf('shop')).toBeUndefined()
    expect(server.kept.get('shop')?.deletedAt).toBe(30)
    expect(mac.kept.get('docs')).toEqual(codebase('docs', 5))
  })

  // WHY: a host that is away when the person changes a codebase must not stay
  // behind. It gets the copies when it is ready again.
  test('a host that becomes ready later gets the copies', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20)])
    const server = new FakeHost('build', 'inst-build')
    server.isReady = false
    const { store, setReady } = setup([mac, server])
    const stop = store.watch()
    await settle()

    expect(server.lists).toBe(0)
    await store.rename('shop', 'Shop')
    expect(server.saves).toEqual([])

    setReady(server, true)
    await settle()
    expect(server.kept.get('shop')?.name).toBe('Shop')
    expect(server.saves).toHaveLength(1)
    stop()
  })

  // WHY: a host that refuses a copy (an older version, a different
  // organization) must not be asked again on each read of a different host.
  test('a host that refuses a copy is asked one time until it is read again', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20)])
    const server = new FakeHost('build', 'inst-build')
    server.saveError = 'refused'
    let attempts = 0
    const save = server.api.codebaseSave
    server.api.codebaseSave = async (copy) => { attempts++; return save(copy) }
    const { store } = setup([mac, server])

    await store.load('build')
    await store.load('local')
    await settle()
    await store.load('local')
    await settle()
    expect(attempts).toBe(1)

    await store.load('build')
    await settle()
    expect(attempts).toBe(2)
  })
})

describe('codebase commands', () => {
  // WHY: a root names its host by installation id, the one id all clients
  // share, and its path is the absolute path the host resolved. `~/shop` and
  // a client's `local` are not usable on a different client or host.
  test('addRoot stores the installation id and the resolved path of the scan', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20)])
    mac.scans.set('~/shop', { path: '/Users/me/shop', state: 'plain', members: [], suggestions: [] })
    const { store } = setup([mac])
    await store.load('local')

    const saved = await store.addRoot('shop', { serverId: 'local', path: '~/shop' })

    expect(saved.roots).toEqual([...TWO_ROOTS, { installationId: 'inst-mac', path: '/Users/me/shop', name: 'shop' }])
    expect(mac.kept.get('shop')?.roots).toEqual(saved.roots)
  })

  test('addRoot refuses a folder that is already a root, also in a different spelling', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots: [root('inst-mac', '/Users/me/shop'), ELSEWHERE] })])
    mac.scans.set('~/shop/', { path: '/Users/me/shop/', state: 'plain', members: [], suggestions: [] })
    const { store } = setup([mac])
    await store.load('local')

    const refused = await store.addRoot('shop', { serverId: 'local', path: '~/shop/' }).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(CodebaseRootRefused)
    expect((refused as CodebaseRootRefused).refusal).toBe('duplicate')
    expect(mac.saves).toEqual([])
  })

  test('addRoot refuses when the codebase has the maximum number of roots, and a folder that does not exist', async () => {
    const full = Array.from({ length: CODEBASE_ROOTS_MAX }, (_, index) => root('inst-mac', `/code/r${index}`))
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots: full }), codebase('docs', 20)])
    mac.scans.set('/gone', { path: '/gone', state: 'missing', members: [], suggestions: [] })
    const { store } = setup([mac])
    await store.load('local')

    const limit = await store.addRoot('shop', { serverId: 'local', path: '/code/new' }).catch((error: unknown) => error)
    const missing = await store.addRoot('docs', { serverId: 'local', path: '/gone' }).catch((error: unknown) => error)

    expect((limit as CodebaseRootRefused).refusal).toBe('limit')
    expect((missing as CodebaseRootRefused).refusal).toBe('missing')
    expect(mac.saves).toEqual([])
  })

  // WHY: the newest `updatedAt` wins on each host. A change must be newer than
  // the copy it replaces, also when a host with a faster clock wrote that copy.
  test('each command raises updatedAt above the current copy', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 5_000, { roots: [root('inst-mac', '/code/shop'), ELSEWHERE] })])
    const { store, clock } = setup([mac], 1_000)
    await store.load('local')

    expect((await store.rename('shop', 'Shop')).updatedAt).toBe(5_001)
    expect((await store.addRoot('shop', { serverId: 'local', path: '/code/web' })).updatedAt).toBe(5_002)
    clock.now = 9_000
    expect((await store.removeRoot('shop', root('inst-mac', '/code/web'))).updatedAt).toBe(9_000)
    await store.delete('shop')
    expect(mac.kept.get('shop')).toMatchObject({ updatedAt: 9_001, deletedAt: 9_001 })
    expect(store.codebases).toEqual([])
  })

  test('create scans each root and sends the codebase to each ready host', async () => {
    const mac = new FakeHost('local', 'inst-mac')
    const server = new FakeHost('build', 'inst-build')
    const { store } = setup([mac, server])
    await store.load('local')
    await store.load('build')

    const created = await store.create('  Shop ', [{ serverId: 'local', path: '/code/shop' }, { serverId: 'build', path: '/srv/infra' }])

    expect(created).toMatchObject({ name: 'Shop', updatedAt: 1_000, deletedAt: null })
    expect(created.roots).toEqual([root('inst-mac', '/code/shop'), root('inst-build', '/srv/infra')])
    expect(mac.kept.get(created.id)).toEqual(created)
    expect(server.kept.get(created.id)).toEqual(created)
    expect(store.codebasesOfFolder('build', '/srv/infra/modules').map((entry) => entry.id)).toEqual([created.id])
    expect(store.codebasesOfFolder('local', '/srv/infra')).toEqual([])
  })

  // WHY: one folder is a project, and a project is never also a codebase (decision 14).
  // A codebase of one folder had the name of its project, so the project picker showed one thing two times.
  test('create refuses one project, and a copy with one project is not a codebase', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('old', 20, { roots: [root('inst-mac', '/code/old')] })])
    const { store } = setup([mac])
    await store.load('local')

    // The scan of the fake host finds no repository inside: one folder is a project.
    await expect(store.create('Shop', [{ serverId: 'local', path: '/code/shop' }])).rejects.toThrow(/One folder is a project/)
    expect(mac.saves).toEqual([])
    // The copy of a host that kept a codebase of one project is not listed, and holds no folder.
    expect(store.codebases).toEqual([])
    expect(store.codebaseOf('old')).toBeUndefined()
    expect(store.codebasesOfFolder('local', '/code/old')).toEqual([])
  })

  test('create makes a codebase of one container: the root gets the mark from the scan of its host', async () => {
    // WHY: decision 14. A folder with no repository of its own that holds two repositories is a codebase by itself.
    const mac = new FakeHost('local', 'inst-mac')
    mac.scans.set('~/shop', {
      path: '/code/shop', state: 'plain', suggestions: [],
      members: [member('/code/shop', '/code/shop', { state: 'plain' }), member('/code/shop/api', '/code/shop'), member('/code/shop/web', '/code/shop')],
    })
    const { store } = setup([mac])
    await store.load('local')

    const created = await store.create('shop', [{ serverId: 'local', path: '~/shop' }])

    expect(created.roots).toEqual([{ installationId: 'inst-mac', path: '/code/shop', name: 'shop', container: true }])
    expect(store.codebases).toEqual([created])
    // The project lists of the client ask this rule: the container is not a project, and a folder inside it is.
    expect(store.isContainerRoot('local', '/code/shop')).toBe(true)
    expect(store.isContainerRoot('local', '/code/shop/api')).toBe(false)
    expect(store.isContainerRoot('build', '/code/shop')).toBe(false)
  })

  test('a folder that holds one repository is added with no container mark', async () => {
    const mac = new FakeHost('local', 'inst-mac')
    mac.scans.set('/code/one', { path: '/code/one', state: 'plain', suggestions: [], members: [member('/code/one', '/code/one', { state: 'plain' }), member('/code/one/api', '/code/one')] })
    const { store } = setup([mac])
    await store.load('local')

    const created = await store.create('Pair', [{ serverId: 'local', path: '/code/one' }, { serverId: 'local', path: '/code/ui' }])
    expect(created.roots.some((each) => each.container)).toBe(false)
    expect(store.isContainerRoot('local', '/code/one')).toBe(false)
  })

  test('removeRoot refuses when the folders that stay are no codebase, and the text says to delete the codebase', async () => {
    const roots = [root('inst-mac', '/code/shop'), root('inst-mac', '/code/ui'), ELSEWHERE]
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots })])
    const { store } = setup([mac])
    await store.load('local')

    expect((await store.removeRoot('shop', roots[1]!)).roots).toEqual([roots[0]!, ELSEWHERE])
    const refused = await store.removeRoot('shop', roots[0]!).catch((error: unknown) => error)
    expect((refused as CodebaseRootRefused).refusal).toBe('too-few')
    expect((refused as CodebaseRootRefused).message).toContain('delete the codebase')
    expect(store.codebaseOf('shop')?.roots).toHaveLength(2)
  })

  test('a container root can stay alone: the other root of two can be removed, and the container cannot', async () => {
    const container: CodebaseRoot = { ...root('inst-mac', '/code/shop'), container: true }
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots: [container, ELSEWHERE] })])
    const { store } = setup([mac])
    await store.load('local')

    const refused = await store.removeRoot('shop', container).catch((error: unknown) => error)
    expect((refused as CodebaseRootRefused).refusal).toBe('too-few')
    expect((await store.removeRoot('shop', ELSEWHERE)).roots).toEqual([container])
    expect(store.codebases.map((each) => each.id)).toEqual(['shop'])
  })

  // WHY: a container root gives the repositories inside it, and a project root is one folder: a root inside a root adds nothing.
  test('addRoot refuses a folder inside a root, and a folder that holds a root, on the same host only', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots: [root('inst-mac', '/code/shop'), ELSEWHERE] })])
    const server = new FakeHost('build', 'inst-build')
    const { store } = setup([mac, server])
    await store.load('local')
    await store.load('build')

    for (const path of ['/code/shop/api', '/code']) {
      const refused = await store.addRoot('shop', { serverId: 'local', path }).catch((error: unknown) => error)
      expect((refused as CodebaseRootRefused).refusal).toBe('nested')
    }
    // The same path on a different host is a different folder.
    expect((await store.addRoot('shop', { serverId: 'build', path: '/code/shop/api' })).roots).toHaveLength(3)
  })

  // WHY: the list must not show a change that no host keeps.
  test('a change that no host saves is not kept, and the error goes to the caller', async () => {
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { name: 'Shop' })])
    const { store } = setup([mac])
    await store.load('local')
    mac.saveError = 'The disk is full.'

    await expect(store.rename('shop', 'Store')).rejects.toThrow('The disk is full.')
    expect(store.codebaseOf('shop')?.name).toBe('Shop')
  })
})

describe('codebase members', () => {
  // WHY: a root on a host that this client does not know is part of the
  // codebase for the other clients. It must stay in the record and be shown.
  test('a root on an unknown installation id is kept and marked', async () => {
    const roots = [root('inst-mac', '/code/shop'), root('inst-elsewhere', '/srv/infra')]
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots })])
    const { store } = setup([mac])
    await store.load('local')

    const groups = store.membersOf('shop')
    expect(groups.map((group) => [group.installationId, group.presence, group.serverId])).toEqual([
      ['inst-mac', 'ready', 'local'],
      ['inst-elsewhere', 'unknown', null],
    ])
    expect(groups[1]!.roots.map((entry) => entry.root.path)).toEqual(['/srv/infra'])

    const renamed = await store.rename('shop', 'Shop')
    expect(renamed.roots).toEqual(roots)
  })

  test('members are grouped by root, with the suggestions of the root that are not roots', async () => {
    const roots = [root('inst-mac', '/code/shop'), root('inst-mac', '/code/libs')]
    const mac = new FakeHost('local', 'inst-mac', [codebase('shop', 20, { roots })])
    mac.members = [
      member('/code/shop', '/code/shop', { state: 'plain' }),
      member('/code/shop/api', '/code/shop'),
      member('/code/shop/web', '/code/shop', { hasCommit: false }),
      member('/code/libs', '/code/libs'),
    ]
    mac.scans.set('/code/shop', {
      path: '/code/shop', state: 'plain', members: [],
      suggestions: [{ path: '/code/libs', name: 'libs' }, { path: '/code/tools', name: 'tools' }],
    })
    const { store } = setup([mac])
    await store.load('local')

    await store.refreshMembers('shop')

    const [group] = store.membersOf('shop')
    expect(group).toMatchObject({ state: 'ready', isStale: false, error: null })
    expect(group!.roots[0]!.member?.state).toBe('plain')
    expect(group!.roots[0]!.found.map((found) => found.path)).toEqual(['/code/shop/api', '/code/shop/web'])
    expect(group!.roots[0]!.suggestions).toEqual([{ path: '/code/tools', name: 'tools' }])
    expect(group!.roots[1]!.member?.state).toBe('git')
  })

  // WHY: a host reads its members from the roots of the copy it keeps. A host
  // with no copy would answer an error for a codebase that the person sees.
  test('a host with no copy gets the copy before its members are read', async () => {
    const shop = codebase('shop', 20, { roots: [root('inst-build', '/srv/infra'), ELSEWHERE] })
    const mac = new FakeHost('local', 'inst-mac', [shop])
    const server = new FakeHost('build', 'inst-build')
    server.members = [member('/srv/infra', '/srv/infra')]
    const { store } = setup([mac, server])
    await store.load('local')
    // The list of the second host is read, but the copy is not there yet.
    const stopSaves = server.api.codebaseSave
    const held: Array<() => void> = []
    server.api.codebaseSave = (copy) => new Promise((resolve) => { held.push(() => resolve(stopSaves(copy))) })
    await store.load('build')

    const read = store.refreshMembers('shop')
    await settle()
    expect(store.membersOf('shop')[0]).toMatchObject({ state: 'loading' })
    for (const release of held) release()
    await read

    expect(server.kept.get('shop')).toEqual(shop)
    expect(store.membersOf('shop')[0]).toMatchObject({ state: 'ready', presence: 'ready' })
    expect(store.membersOf('shop')[0]!.roots[0]!.member?.path).toBe('/srv/infra')
  })

  // WHY: the members of a host that is away are still useful, but they are not
  // current. The view must be able to say so, and get a current answer when
  // the host is ready again.
  test('the members of a host that goes away stay with a stale mark, and are read again when it is ready', async () => {
    const shop = codebase('shop', 20, { roots: [root('inst-build', '/srv/infra'), ELSEWHERE] })
    const server = new FakeHost('build', 'inst-build', [shop])
    server.members = [member('/srv/infra', '/srv/infra'), member('/srv/infra/modules', '/srv/infra')]
    const { store, setReady } = setup([server])
    const stop = store.watch()
    await settle()
    const stopMembers = store.watchMembers('shop')
    await settle()
    expect(store.membersOf('shop')[0]).toMatchObject({ state: 'ready', isStale: false, presence: 'ready' })

    setReady(server, false)
    const away = store.membersOf('shop')[0]!
    expect(away).toMatchObject({ presence: 'away', isStale: true })
    expect(away.roots[0]!.found.map((found) => found.path)).toEqual(['/srv/infra/modules'])

    server.members = [member('/srv/infra', '/srv/infra')]
    setReady(server, true)
    await settle()
    const back = store.membersOf('shop')[0]!
    expect(back).toMatchObject({ presence: 'ready', isStale: false, state: 'ready' })
    expect(back.roots[0]!.found).toEqual([])
    stopMembers()
    stop()
  })

  test('a host that cannot read its members keeps the last answer with a stale mark and the error', async () => {
    const shop = codebase('shop', 20, { roots: [root('inst-mac', '/code/shop'), ELSEWHERE] })
    const mac = new FakeHost('local', 'inst-mac', [shop])
    mac.members = [member('/code/shop', '/code/shop')]
    const { store } = setup([mac])
    await store.load('local')
    await store.refreshMembers('shop')

    mac.membersError = 'The disk did not answer.'
    await store.refreshMembers('shop')

    const [group] = store.membersOf('shop')
    expect(group).toMatchObject({ state: 'error', isStale: true, error: 'The disk did not answer.' })
    expect(group!.roots[0]!.member?.path).toBe('/code/shop')
  })
})
