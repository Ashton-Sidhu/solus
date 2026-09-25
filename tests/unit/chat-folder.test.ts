import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Principal } from '@solus/server/server/principal'

// bun has no node:sqlite; the handler modules' import chain reaches the db even
// though these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// Scratchpad (work "Just chat vs the Solus workspace model" §0, §10): a session
// with no project runs in the caller's chat folder. Each member of an
// organization has their own, inside their member folder; the owner keeps the
// old `my-workspace` folder so old sessions still resume. A bare `~` from a
// client means that folder, never the home folder. A chat starts private.

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-chat-folder-')))
const dataDir = join(sandbox, 'data')
const hostRoot = join(sandbox, 'projects')
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = dataDir
process.env.SOLUS_PROJECTS_ROOT = hostRoot

const { chatFolderCapability, chatFolderFor, resolveUnknownFolder } = await import('@solus/server/server/handlers/setup-handlers')
const { isChatFolder, WORKSPACE_DIR } = await import('@solus/server/workspace')
const { resolveHomePath } = await import('@solus/server/platform/paths')
const { registerSessionHandlers } = await import('@solus/server/server/handlers/session-handlers')

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const member = (userId: string, hostKind: 'personal' | 'managed' = 'managed'): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind, displayName: userId, deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})

function isInside(folder: string, path: string): boolean {
  const inside = relative(folder, path)
  return inside === '' || (!inside.startsWith('..') && !inside.startsWith('/'))
}

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousProjectsRoot === undefined) delete process.env.SOLUS_PROJECTS_ROOT
  else process.env.SOLUS_PROJECTS_ROOT = previousProjectsRoot
})

describe('chat folder', () => {
  test('two members get two chat folders in their member folders, outside the data folder', () => {
    const alice = chatFolderFor(member('alice'), hostRoot)
    const bob = chatFolderFor(member('bob'), hostRoot)
    expect(alice).toBe(join(hostRoot, 'alice', '.chat'))
    expect(bob).toBe(join(hostRoot, 'bob', '.chat'))
    expect(existsSync(alice) && existsSync(bob)).toBe(true)
    expect(isInside(dataDir, alice) || isInside(dataDir, bob)).toBe(false)
  })

  test('a member of a personal host shared with an organization also gets their own chat folder', () => {
    expect(chatFolderFor(member('carol', 'personal'), hostRoot)).toBe(join(hostRoot, 'carol', '.chat'))
  })

  test('the owner keeps the old chat folder, so old sessions still resume', () => {
    expect(WORKSPACE_DIR).toBe(join(dataDir, 'my-workspace'))
    expect(chatFolderFor(OWNER, hostRoot)).toBe(WORKSPACE_DIR)
    expect(chatFolderFor({ kind: 'remote-owner', userId: 'u', deviceId: 'd', expiresAt: 0, deviceLabel: 'Web' }, hostRoot)).toBe(WORKSPACE_DIR)
    expect(chatFolderFor(undefined, hostRoot)).toBe(WORKSPACE_DIR)
  })

  test('recognizes every chat folder, and nothing else, without a caller', () => {
    expect(isChatFolder(WORKSPACE_DIR, hostRoot)).toBe(true)
    expect(isChatFolder(join(WORKSPACE_DIR, 'notes'), hostRoot)).toBe(true)
    expect(isChatFolder(join(hostRoot, 'alice', '.chat'), hostRoot)).toBe(true)
    expect(isChatFolder(join(hostRoot, 'alice', '.chat', 'draft'), hostRoot)).toBe(true)
    expect(isChatFolder(join(hostRoot, 'alice', 'solus'), hostRoot)).toBe(false)
    expect(isChatFolder(join(hostRoot, '.chat'), hostRoot)).toBe(false)
    expect(isChatFolder(join(sandbox, 'elsewhere', 'x', '.chat'), hostRoot)).toBe(false)
  })

  test('capabilities leave out a chat folder that is inside a Git work tree', () => {
    const plainRoot = join(sandbox, 'plain-host')
    expect(chatFolderCapability(member('dan'), plainRoot)).toEqual({ workspacePath: join(plainRoot, 'dan', '.chat') })

    const repoRoot = join(sandbox, 'repo-host')
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    expect(chatFolderCapability(member('dan'), repoRoot)).toEqual({})
  })
})

describe('bare ~', () => {
  test("means the caller's chat folder; ~/x is still a home path", () => {
    expect(resolveUnknownFolder('~', member('alice'))).toBe(join(hostRoot, 'alice', '.chat'))
    expect(resolveUnknownFolder('~', OWNER)).toBe(WORKSPACE_DIR)
    expect(resolveUnknownFolder('~/code', member('alice'))).toBe('~/code')
    expect(resolveHomePath('~/code')).toBe(join(homedir(), 'code'))
  })

  test('without a caller it is the owner chat folder, never the home folder', () => {
    expect(resolveHomePath('~')).toBe(WORKSPACE_DIR)
    expect(resolveHomePath('')).toBe(WORKSPACE_DIR)
    expect(existsSync(WORKSPACE_DIR)).toBe(true)
  })
})

describe('a chat starts private', () => {
  type Handler = (args: unknown[], ctx: { clientId: string; principal: Principal }) => Promise<unknown>
  type Resource = { kind: string; id: string }
  const handlers = new Map<string, Handler>()
  const prompted: IpcContext[] = []
  /** What the handlers asked of the share list, in order. ShareManager's own tests cover what each call writes. */
  const shareCalls: string[] = []

  beforeAll(() => {
    const shares = {
      claimOwner: async (resource: Resource, _principal: Principal, options: { shareWithOrganization?: boolean } = {}) => {
        shareCalls.push(`claim ${resource.id}${options.shareWithOrganization === false ? ' private' : ''}`)
        return null
      },
      shareWithOrganization: async (resource: Resource) => {
        shareCalls.push(`share ${resource.id}`)
      },
    }
    const controlPlane = {
      isKnownSession: () => false,
      watchSession: (input: { sessionId: string }) => ({ sessionId: input.sessionId }),
      submitPrompt: async (ctx: IpcContext) => {
        prompted.push(ctx)
        return { disposition: 'started' }
      },
      bindRuntimeSession: () => null,
    }
    registerSessionHandlers(
      { register: (name: string, handler: Handler) => handlers.set(name, handler) } as never,
      { controlPlane: controlPlane as never, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code', shares: shares as never },
    )
  })

  afterEach(() => {
    shareCalls.length = 0
  })

  /** What a client does to start a session: watch it, then send the first prompt. */
  async function startSession(sessionId: string, workingDirectory: string, principal: Principal): Promise<IpcContext> {
    const handlerCtx = { clientId: `ws:${sessionId}`, principal }
    await handlers.get('watchSession')!([{ sessionId }], handlerCtx)
    const ctx = { session: { sessionId, workingDirectory, projectPath: workingDirectory }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('prompt')!([ctx, { prompt: 'hello' }], handlerCtx)
    return prompted.at(-1)!
  }

  test('a chat on an organization space gets no organization grant; a project session does', async () => {
    const alice = member('alice')

    const chat = await startSession('chat-1', '~', alice)
    expect(chat.session.workingDirectory).toBe(join(hostRoot, 'alice', '.chat'))
    expect(chat.session.projectPath).toBe(join(hostRoot, 'alice', '.chat'))
    expect(shareCalls).toEqual(['claim chat-1 private'])

    shareCalls.length = 0
    await startSession('project-1', join(hostRoot, 'alice', 'solus'), alice)
    expect(shareCalls).toEqual(['claim project-1 private', 'share project-1'])
  })

  test('only the first prompt decides: a later one only claims, which changes nothing for an owned session', async () => {
    const alice = member('alice')
    const project = join(hostRoot, 'alice', 'solus')
    await startSession('project-2', project, alice)
    shareCalls.length = 0
    const ctx = { session: { sessionId: 'project-2', workingDirectory: project, projectPath: project }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('prompt')!([ctx, { prompt: 'again' }], { clientId: 'ws:project-2', principal: alice })
    expect(shareCalls).toEqual(['claim project-2'])
  })

  test('a chat that binds without a watch first also starts private', async () => {
    const ctx = { session: { sessionId: 'chat-2', agentSessionId: 'thread-2', workingDirectory: join(hostRoot, 'alice', '.chat'), projectPath: '' }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('bindRuntimeSession')!([ctx], { clientId: 'ws:chat-2', principal: member('alice') })
    expect(shareCalls).toEqual(['claim chat-2 private'])
  })
})
