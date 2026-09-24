import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import type { SetupAdoptProjectResult } from '@solus/contracts/types'
import { safeProjectDirName } from '@solus/contracts/project-folder-name'
import type { HandlerCtx } from '@solus/server/server/server'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

// bun has no node:sqlite; the handlers' import chain reaches the db even though
// these tests never open it (registerProject is injected).
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerSetupHandlers } = await import('@solus/server/server/handlers/setup-handlers')
const { SolusServer } = await import('@solus/server/server/server')

const memberCtx: HandlerCtx = {
  clientId: 'ws:member',
  principal: {
    kind: 'org-member',
    userId: 'user_abc123',
    organizationId: 'org-1',
    organizationRole: 'member',
    teamIds: [],
    hostKind: 'managed',
    displayName: 'Member',
    deviceId: 'device-1',
    expiresAt: Date.now() + 60_000,
    deviceLabel: 'Solus cloud',
  },
}

describe('New project', () => {
  let root: string
  let registered: string[]
  let server: InstanceType<typeof SolusServer>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solus-create-project-test-'))
    registered = []
    server = new SolusServer()
    registerSetupHandlers(server, {
      projectsRoot: () => root,
      registerProject: async (path) => {
        registered.push(path)
        return `local:${path}`
      },
    })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const create = (request: { name: string; parent?: string }, ctx: HandlerCtx = TEST_HANDLER_CTX) =>
    server.handle('setupCreateProject', [request], ctx) as Promise<SetupAdoptProjectResult>

  test('creates a git repository in the projects folder and records it', async () => {
    // WHY: "make me a website" needs a real project, not a chat in My Workspace:
    // a folder of its own, under version control, that the project lists know.
    const result = await create({ name: 'My Website' })

    expect(result.path).toBe(join(root, 'My-Website'))
    expect(existsSync(join(result.path, '.git'))).toBe(true)
    expect(registered).toEqual([result.path])
  })

  test('a cloud member creates in their own folder, which no one else lists', async () => {
    // WHY: a new cloud project stays private until it is published; the member's
    // folder is what keeps it out of every other person's project list.
    const result = await create({ name: 'site' }, memberCtx)

    expect(result.path).toBe(join(root, 'user_abc123', 'site'))
  })

  test('a name already taken is refused and the folder is left alone', async () => {
    // WHY: the user typed the name. Suffixing it would open a folder they did
    // not ask for; overwriting would put an agent in someone else's files.
    mkdirSync(join(root, 'site'))

    await expect(create({ name: 'site' })).rejects.toThrow('already exists')
    expect(readdirSync(join(root, 'site'))).toEqual([])
    expect(registered).toEqual([])
  })

  test('a folder chosen with "Change…" is the parent instead of the projects folder', async () => {
    const parent = join(root, 'elsewhere')

    const result = await create({ name: 'site', parent })

    expect(result.path).toBe(join(parent, 'site'))
  })

  test('an empty name is refused', async () => {
    await expect(create({ name: '   ' })).rejects.toThrow()
  })
})

describe('project folder name', () => {
  test('the client preview and the host agree, and a name never becomes a path', () => {
    // WHY: the dialog shows the path before Create; the host must make that path.
    expect(safeProjectDirName('My Website')).toBe('My-Website')
    for (const name of ['../escape', '..', 'a/b', 'a\\b']) {
      const folder = safeProjectDirName(name)
      expect(folder).not.toMatch(/[\\/]/)
      expect(folder.startsWith('.')).toBe(false)
    }
  })
})
