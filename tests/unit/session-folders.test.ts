import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Codebase, SessionFolder } from '@solus/contracts/codebases'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { git } from '@solus/server/git/exec'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/codebases.md §6: the server owns the folders of a session. The
// provider gets a folder only when it is a member of the session's codebase on
// this host or a folder attached to the session, so each rule here decides
// what an agent can read and write.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let codebases: typeof import('@solus/server/data/codebases/codebases')
let records: typeof import('@solus/server/data/sessions/session-records')
let database: typeof import('@solus/server/db')
let HOST_ACTOR: Actor
let ANY_ORGANIZATION: typeof import('@solus/server/admission/principal')['ANY_ORGANIZATION']
let installationId: string
const previousDataDir = process.env.SOLUS_DATA_DIR

// Discovery asks Git about each repository; with no caller, it acts as the host.
actAsHostForTests()

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-folders-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  runtimeModule = await import('@solus/server/execution/session-runtime')
  codebases = await import('@solus/server/data/codebases/codebases')
  records = await import('@solus/server/data/sessions/session-records')
  database = await import('@solus/server/db')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  ;({ ANY_ORGANIZATION } = await import('@solus/server/admission/principal'))
  installationId = (await import('@solus/server/admission/auth')).getInstallationId()

  // ~/shop is a plain folder that holds two repositories; ~/libs/ui is a repository of its own.
  for (const repository of ['shop/api', 'shop/web', 'libs/ui']) {
    mkdirSync(join(root, repository), { recursive: true })
    git(['init', '-b', 'main'], join(root, repository))
  }
  mkdirSync(join(root, 'notes'))
  mkdirSync(join(root, 'scratch'))
  writeFileSync(join(root, 'a-file.txt'), 'not a folder')
})

afterAll(() => {
  database.closeDb()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

const at = (path: string): string => join(root, path)

let nextCodebase = 0
/** A saved codebase with the given roots on this host, and one root on a different host. */
async function savedCodebase(paths: string[]): Promise<Codebase> {
  const codebase: Codebase = {
    id: `codebase-${++nextCodebase}`,
    name: 'shop',
    roots: [
      ...paths.map((path) => ({ installationId, path: at(path), name: '' })),
      { installationId: 'installation-build-server', path: '/srv/infra', name: 'infra' },
    ],
    updatedAt: 1_000,
    deletedAt: null,
  }
  return codebases.saveCodebase('local', 'owner', codebase)
}

/** A runtime, and each `session_folders` list it published for `sessionId`. */
function runtimeFor(sessionId: string): { runtime: Runtime; published: SessionFolder[][]; events: NormalizedEvent[] } {
  const runtime = new runtimeModule.SessionRuntime(new Map())
  const published: SessionFolder[][] = []
  const events: NormalizedEvent[] = []
  runtime.on('event', (id: string, event: NormalizedEvent) => {
    if (id !== sessionId) return
    events.push(event)
    if (event.type === 'session_folders') published.push(event.folders)
  })
  return { runtime, published, events }
}

const paths = (folders: SessionFolder[]): string[] => folders.map((folder) => folder.path)

describe('the folders of a session at a turn start', () => {
  test('a member on this host is a folder, and a root on a different host or a missing root is not', async () => {
    const codebase = await savedCodebase(['shop', 'libs/ui', 'gone'])
    const { runtime, published } = runtimeFor('members')
    try {
      const folders = await runtime.sessionFolders.resolve('members', { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR })

      // `shop/api` is the working directory. `gone` is not on the disk. `/srv/infra` is on a different host.
      expect(folders).toEqual([
        { path: at('libs/ui'), name: 'ui', state: 'git', repositoryPath: at('libs/ui'), source: 'codebase', granted: true },
        { path: at('shop'), name: 'shop', state: 'plain', repositoryPath: at('shop'), source: 'codebase', granted: true },
        { path: at('shop/web'), name: 'web', state: 'git', repositoryPath: at('shop/web'), source: 'codebase', granted: true },
      ])
      expect(published).toEqual([folders])
      expect(runtime.sessionFolders.grantedPaths('members')).toEqual(paths(folders))
      expect(paths(runtime.sessionFolders.checkpointTargets('members'))).toEqual([at('libs/ui'), at('shop/web')])
    } finally {
      runtime.shutdown()
    }
  })

  test('a root that is gone is not a folder, is not granted, and is not in the prompt block', async () => {
    // WHY: a codebase can name a folder that the system deleted (a temporary folder). The turn must still start, and
    // the provider and the agent must not get a folder that is not there.
    mkdirSync(at('vanishes/tool'), { recursive: true })
    git(['init', '-b', 'main'], at('vanishes/tool'))
    const codebase = await savedCodebase(['libs/ui', 'vanishes'])
    const { runtime } = runtimeFor('root-gone')
    try {
      const turn = { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR }
      expect(paths(await runtime.sessionFolders.resolve('root-gone', turn))).toEqual([at('libs/ui'), at('vanishes'), at('vanishes/tool')])

      rmSync(at('vanishes'), { recursive: true })
      expect(paths(await runtime.sessionFolders.resolve('root-gone', turn))).toEqual([at('libs/ui')])
      expect(runtime.sessionFolders.grantedPaths('root-gone')).toEqual([at('libs/ui')])
      expect(runtime.sessionFolders.grantedFolderOf('root-gone', at('vanishes/tool/main.ts'))).toBeNull()
      expect(runtime.sessionFolders.promptFolders('root-gone')?.folders).toEqual([{ name: 'ui', path: at('libs/ui'), state: 'git' }])
      // The record keeps the root: the folder can come back, and only a person removes a root.
      expect((await codebases.getCodebase(ANY_ORGANIZATION, codebase.id))?.roots.map((each) => each.path)).toContain(at('vanishes'))
    } finally {
      runtime.shutdown()
    }
  })

  test('a root in the data folder of Solus is not a folder of the session', async () => {
    // WHY: the data folder holds the database and the secrets of the host. A person can write each path as a root, and the provider must still get no grant there.
    mkdirSync(at('data/exports'), { recursive: true })
    const codebase = await savedCodebase(['libs/ui', 'data/exports'])
    const { runtime } = runtimeFor('root-in-data')
    try {
      const folders = await runtime.sessionFolders.resolve('root-in-data', { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR })
      expect(paths(folders)).toEqual([at('libs/ui')])
      expect(runtime.sessionFolders.grantedPaths('root-in-data')).toEqual([at('libs/ui')])
      expect(runtime.sessionFolders.promptFolders('root-in-data')?.folders).toEqual([{ name: 'ui', path: at('libs/ui'), state: 'git' }])
    } finally {
      runtime.shutdown()
    }
  })

  test('the repositories inside a plain working directory are folders of the project, and the provider gets no grant for them', async () => {
    // WHY: `~/shop` holds the repositories `api` and `web`. Git status, diff, and checkpoints work for each
    // repository only when it is a session folder. The provider reaches them through the working directory.
    // The project covers them (`project`); the codebase adds only what is outside the project folder.
    const codebase = await savedCodebase(['shop', 'libs/ui'])
    const { runtime } = runtimeFor('inside')
    try {
      const folders = await runtime.sessionFolders.resolve('inside', { workingDirectory: at('shop'), codebaseId: codebase.id, actor: HOST_ACTOR })
      expect(folders.map(({ path, source, granted }) => ({ path, source, granted }))).toEqual([
        { path: at('libs/ui'), source: 'codebase', granted: true },
        { path: at('shop/api'), source: 'project', granted: true },
        { path: at('shop/web'), source: 'project', granted: true },
      ])
      expect(paths(runtime.sessionFolders.checkpointTargets('inside'))).toEqual([at('libs/ui'), at('shop/api'), at('shop/web')])
      expect(runtime.sessionFolders.grantedPaths('inside')).toEqual([at('libs/ui')])
      expect(runtime.sessionFolders.grantedFolderOf('inside', at('shop/api/src/main.ts'))).toBeNull()
      expect(runtime.sessionFolders.promptFolders('inside')?.folders.map((folder) => folder.path)).toEqual([at('libs/ui'), at('shop/api'), at('shop/web')])
    } finally {
      runtime.shutdown()
    }
  })

  test('the working directory and the repository it is in are left out', async () => {
    const codebase = await savedCodebase(['shop', 'libs/ui'])
    const worktree = runtimeFor('worktree')
    try {
      // A linked worktree stands in for its repository: the session does not also work in `libs/ui`.
      mkdirSync(at('worktrees/ui-fix'), { recursive: true })
      expect(paths(await worktree.runtime.sessionFolders.resolve('worktree', {
        workingDirectory: at('worktrees/ui-fix'), repositoryRoot: at('libs/ui'), codebaseId: codebase.id, actor: HOST_ACTOR,
      }))).toEqual([at('shop'), at('shop/api'), at('shop/web')])
    } finally {
      worktree.runtime.shutdown()
    }
    const subfolder = runtimeFor('subfolder')
    try {
      // The working directory is a folder inside the repository `shop/api`: that member is the repository it is in.
      mkdirSync(at('shop/api/src'), { recursive: true })
      expect(paths(await subfolder.runtime.sessionFolders.resolve('subfolder', {
        workingDirectory: at('shop/api/src'), repositoryRoot: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR,
      }))).toEqual([at('libs/ui'), at('shop'), at('shop/web')])
    } finally {
      subfolder.runtime.shutdown()
    }
  })

  test('a session with no codebase has no folder and publishes nothing', async () => {
    const { runtime, published } = runtimeFor('plain')
    try {
      expect(await runtime.sessionFolders.resolve('plain', { workingDirectory: at('shop/api'), actor: HOST_ACTOR })).toEqual([])
      expect(published).toEqual([])
      expect(runtime.sessionFolders.promptFolders('plain')).toBeUndefined()
    } finally {
      runtime.shutdown()
    }
  })

  test('an unchanged list publishes no second event', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const { runtime, published } = runtimeFor('unchanged')
    try {
      const turn = { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR }
      await runtime.sessionFolders.resolve('unchanged', turn)
      await runtime.sessionFolders.resolve('unchanged', turn)
      expect(published).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('an attached folder stays across turns, and is dropped while it does not exist', async () => {
    const { runtime, published } = runtimeFor('attached')
    try {
      const turn = { workingDirectory: at('shop/api'), actor: HOST_ACTOR }
      await runtime.sessionFolders.resolve('attached', turn)
      mkdirSync(at('temporary'))
      // A person attached the folder: `sessionAttachFolder` is a request by name.
      await runtime.sessionFolders.attach('attached', at('temporary'), 'attached', HOST_ACTOR, { byName: true })
      expect(paths(await runtime.sessionFolders.resolve('attached', turn))).toEqual([at('temporary')])

      rmSync(at('temporary'), { recursive: true })
      expect(await runtime.sessionFolders.resolve('attached', turn)).toEqual([])
      expect(published.map(paths)).toEqual([[at('temporary')], []])
    } finally {
      runtime.shutdown()
    }
  })

  test('a turn start removes a folder in a temporary directory that no person and no agent asked for', async () => {
    // WHY: before the automatic triggers had their rule, the path of a pasted screenshot attached the temporary
    // directory of the system, and the record of the session keeps it. The next turn must not grant it again.
    // A folder that a person or the agent asked for by its name stays, and so does a folder in a different place.
    for (const folder of ['system-temp/screens', 'system-temp/asked', 'downloads']) mkdirSync(at(folder), { recursive: true })
    await records.upsertOwnSessionRecord({
      sessionId: 'cleans', provider: 'codex', projectPath: '-shop-api', lastActivityAt: 1_000,
      attachedFolders: [
        { path: at('system-temp/screens'), source: 'attached' },
        { path: at('system-temp/asked'), source: 'attached', byName: true },
        { path: at('downloads'), source: 'attached' },
      ],
    })
    const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [at('system-temp')] })
    try {
      const folders = await runtime.sessionFolders.resolve('cleans', { workingDirectory: at('shop/api'), actor: HOST_ACTOR })
      expect(paths(folders)).toEqual([at('downloads'), at('system-temp/asked')])
      expect(runtime.sessionFolders.grantedPaths('cleans')).not.toContain(at('system-temp/screens'))
      // The record lost the folder, so a restart of the host does not bring it back.
      expect((await records.storedSessionFolders('cleans'))?.attachedFolders).toEqual([
        { path: at('system-temp/asked'), source: 'attached', byName: true },
        { path: at('downloads'), source: 'attached' },
      ])
      // The folder that stayed can be detached by the person.
      expect(paths(await runtime.sessionFolders.detach('cleans', at('downloads'), HOST_ACTOR))).toEqual([at('system-temp/asked')])
    } finally {
      runtime.shutdown()
    }
  })

  test('a session keeps the codebase it started with', async () => {
    const first = await savedCodebase(['libs/ui'])
    const second = await savedCodebase(['notes'])
    const { runtime } = runtimeFor('started')
    try {
      // The first turn names the codebase before the session has a record: the start writes it.
      await runtime.sessionFolders.resolve('started', { workingDirectory: at('shop/api'), codebaseId: first.id, actor: HOST_ACTOR })
      expect(runtime.sessionFolders.recordFields('started')).toEqual({ codebaseId: first.id })
      // A later turn of the same session cannot change it.
      expect(paths(await runtime.sessionFolders.resolve('started', { workingDirectory: at('shop/api'), codebaseId: second.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
    } finally {
      runtime.shutdown()
    }

    // After a restart the record decides: a client that names a different codebase changes nothing.
    await records.upsertOwnSessionRecord({ sessionId: 'restarted', provider: 'codex', projectPath: '-repo', lastActivityAt: 1_000, codebaseId: first.id })
    const restarted = runtimeFor('restarted')
    try {
      expect(paths(await restarted.runtime.sessionFolders.resolve('restarted', { workingDirectory: at('shop/api'), codebaseId: second.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
      expect(await restarted.runtime.sessionFolders.codebaseIdOf('restarted')).toBe(first.id)
    } finally {
      restarted.runtime.shutdown()
    }
  })

  // A person can choose a codebase for a run that started with none. The host
  // must take it, or the session never gets its folders.
  test('a session with no codebase takes the codebase that a later turn names', async () => {
    const made = await savedCodebase(['libs/ui'])
    const other = await savedCodebase(['notes'])
    // The session started with no codebase: its record has none.
    await records.upsertOwnSessionRecord({ sessionId: 'late', provider: 'codex', projectPath: '-repo', lastActivityAt: 1_000, startedAt: 1_000 })
    const { runtime, published } = runtimeFor('late')
    try {
      expect(await runtime.sessionFolders.resolve('late', { workingDirectory: at('shop/api'), actor: HOST_ACTOR })).toEqual([])
      expect(await runtime.sessionFolders.codebaseIdForTurn('late', made.id)).toBe(made.id)

      // The turn that names the codebase resolves its folders with it, and the record gets it.
      expect(paths(await runtime.sessionFolders.resolve('late', { workingDirectory: at('shop/api'), codebaseId: made.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
      expect(published.map(paths)).toEqual([[at('libs/ui')]])
      expect((await records.storedSessionFolders('late'))?.codebaseId).toBe(made.id)

      // From then on the session has a codebase: a different id changes nothing.
      expect(await runtime.sessionFolders.codebaseIdForTurn('late', other.id)).toBe(made.id)
      expect(paths(await runtime.sessionFolders.resolve('late', { workingDirectory: at('shop/api'), codebaseId: other.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
      expect((await records.storedSessionFolders('late'))?.codebaseId).toBe(made.id)
    } finally {
      runtime.shutdown()
    }

    // A restart reads the record: the session keeps the codebase it took.
    const restarted = runtimeFor('late')
    try {
      expect(paths(await restarted.runtime.sessionFolders.resolve('late', { workingDirectory: at('shop/api'), codebaseId: other.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
    } finally {
      restarted.runtime.shutdown()
    }
  })

  test('a Git folder of the session reports its checkout with its own cwd', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const { runtime, events } = runtimeFor('git-events')
    try {
      await runtime.sessionFolders.resolve('git-events', { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR })
      // The registration reads the folder; the same read resolves here.
      await runtime.checkouts.refresh(at('libs/ui'))
      const context = events.find((event) => event.type === 'git_context')
      expect(context).toMatchObject({ type: 'git_context', cwd: at('libs/ui'), gitContext: { repoRoot: at('libs/ui'), branch: 'main' } })
      expect(events.filter((event) => event.type === 'git_status').map((event) => event.cwd)).toEqual([at('libs/ui')])
      // The list comes before the checkout of one of its folders: a client needs it to read the event.
      expect(events.findIndex((event) => event.type === 'session_folders')).toBeLessThan(events.indexOf(context!))
    } finally {
      runtime.shutdown()
    }
  })
})

describe('attach and detach', () => {
  test('write the session record and publish the new list', async () => {
    await records.upsertOwnSessionRecord({ sessionId: 'recorded', provider: 'codex', projectPath: '-repo', lastActivityAt: 1_000 })
    const { runtime, published } = runtimeFor('recorded')
    try {
      await runtime.sessionFolders.resolve('recorded', { workingDirectory: at('shop/api'), actor: HOST_ACTOR })
      const attached = await runtime.sessionFolders.attach('recorded', at('notes'), 'attached', HOST_ACTOR)

      expect(attached).toEqual([{ path: at('notes'), name: 'notes', state: 'plain', repositoryPath: at('notes'), source: 'attached', granted: true }])
      // In the middle of a turn the folder is a session folder immediately.
      expect(runtime.sessionFolders.foldersOf('recorded')).toEqual(attached)
      expect(runtime.sessionFolders.grantedPaths('recorded')).toEqual([at('notes')])
      expect((await records.getSessionRecord(ANY_ORGANIZATION, 'recorded'))?.attachedFolders).toEqual([{ path: at('notes'), source: 'attached' }])

      expect(await runtime.sessionFolders.detach('recorded', at('notes'), HOST_ACTOR)).toEqual([])
      expect((await records.getSessionRecord(ANY_ORGANIZATION, 'recorded'))?.attachedFolders).toEqual([])
      expect(published).toEqual([attached, []])
    } finally {
      runtime.shutdown()
    }

    // A reader with no live turn gets the folders from the record.
    await records.setSessionRecordFolders('recorded', { attachedFolders: [{ path: at('scratch'), source: 'created' }] })
    const later = runtimeFor('recorded')
    try {
      expect(paths(await later.runtime.sessionFolders.read('recorded', HOST_ACTOR))).toEqual([at('scratch')])
    } finally {
      later.runtime.shutdown()
    }
  })

  test('attach refuses the working directory, a file, a path in a session folder, and a path the person may not use', async () => {
    const codebase = await savedCodebase(['shop'])
    const { runtime, published } = runtimeFor('refused')
    try {
      await runtime.sessionFolders.resolve('refused', { workingDirectory: at('libs/ui'), codebaseId: codebase.id, actor: HOST_ACTOR })
      const attach = (path: string, actor = HOST_ACTOR) => runtime.sessionFolders.attach('refused', path, 'attached', actor)

      await expect(attach(at('libs/ui'))).rejects.toThrow('is the working directory of the session')
      await expect(attach(at('a-file.txt'))).rejects.toThrow('is not a folder on this host')
      await expect(attach(at('nowhere'))).rejects.toThrow('is not a folder on this host')
      await expect(attach(at('shop/web'))).rejects.toThrow('is already in the session folder')
      // A link guest reaches only the checkout of the session that was shared, as for a working directory.
      const guest: Actor = {
        user: null,
        principal: {
          kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', deviceLabel: 'Guest', expiresAt: Date.now() + 60_000,
          share: { resource: { kind: 'session', id: 'refused' }, role: 'editor', sharedByUserId: 'owner', linkSecretHash: 'hash' },
        },
      }
      await expect(attach(at('notes'), guest)).rejects.toThrow('reaches only the shared session')

      // A member of the codebase cannot be detached from one session: it comes from the codebase.
      await expect(runtime.sessionFolders.detach('refused', at('shop'), HOST_ACTOR)).rejects.toThrow('comes from the codebase')
      expect(published).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })
})

describe('a session that a different host starts', () => {
  test('brings the record of its codebase, which this host saves by the newest-wins rule', async () => {
    // WHY: this host has no copy of a codebase that a person made on the host of the sender.
    const { receiveSessionCodebase } = await import('@solus/server/transport/handlers/codebase-handlers')
    const host = { principal: HOST_ACTOR.principal, actor: HOST_ACTOR }
    const sent: Codebase = {
      id: 'codebase-from-laptop', name: 'shop', updatedAt: 5_000, deletedAt: null,
      roots: [{ installationId, path: at('libs/ui'), name: '' }, { installationId: 'installation-laptop', path: '/Users/me/shop', name: '' }],
    }

    expect(await receiveSessionCodebase(sent, host)).toBe(sent.id)
    expect(await codebases.getCodebase('local', sent.id)).toEqual(sent)
    // An older copy from a host that is behind does not replace the newer one, and the session still gets the id.
    expect(await receiveSessionCodebase({ ...sent, name: 'old name', updatedAt: 1_000 }, host)).toBe(sent.id)
    expect((await codebases.getCodebase('local', sent.id))?.name).toBe('shop')
    expect(await receiveSessionCodebase(undefined, host)).toBeNull()

    // The session that starts with the id has the members on this host.
    const { runtime } = runtimeFor('remote-child')
    try {
      expect(paths(await runtime.sessionFolders.resolve('remote-child', { workingDirectory: at('shop/api'), codebaseId: sent.id, actor: HOST_ACTOR })))
        .toEqual([at('libs/ui')])
    } finally {
      runtime.shutdown()
    }
  })
})

describe('the data of the prompt block', () => {
  test('lists the working directory, the folders here, and the roots on other hosts', async () => {
    const codebase = await savedCodebase(['libs/ui'])
    const { runtime } = runtimeFor('block')
    try {
      await runtime.sessionFolders.resolve('block', { workingDirectory: at('shop/api'), codebaseId: codebase.id, actor: HOST_ACTOR })
      expect(runtime.sessionFolders.promptFolders('block')).toEqual({
        name: 'shop',
        workingDirectory: { name: 'api', path: at('shop/api'), state: 'plain' },
        folders: [{ name: 'ui', path: at('libs/ui'), state: 'git' }],
        // This host does not know a host with that installation id, so the id is its label.
        otherHosts: [{ name: 'infra', path: '/srv/infra', host: 'installation-build-server' }],
      })
    } finally {
      runtime.shutdown()
    }
  })
})
