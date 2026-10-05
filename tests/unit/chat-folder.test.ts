import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Principal } from '@solus/server/admission/principal'
import { chatFolderIn, isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'

// bun has no node:sqlite; the handler modules' import chain reaches the db even
// though these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A chat (docs/plans/projectless-chat.md) is a session with no project. Each chat
// runs in a folder of its own, `.solus-chats/<id>` in the caller's projects root,
// so files from two chats never mix and no chat runs in the host's data folder.
// `~` is the home folder; only the explicit new-chat marker starts a chat.

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-chat-folder-')))
const dataDir = join(sandbox, 'data')
const hostRoot = join(sandbox, 'projects')
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = dataDir
process.env.SOLUS_PROJECTS_ROOT = hostRoot

const { chatFolderFor, projectsRootFor } = await import('@solus/server/transport/handlers/setup-handlers')
const { ChatUnavailableError } = await import('@solus/server/workspace')
const { resolveHomePath } = await import('@solus/server/platform/paths')
const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
// `SolusServer.handle()` resolves the actor before a handler runs (plans/012 §4).
const { withActor } = await import('./helpers/actors')

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
  test('each chat gets its own folder, so the files of two chats never mix', () => {
    const first = chatFolderFor('chat-a', OWNER, hostRoot)
    const second = chatFolderFor('chat-b', OWNER, hostRoot)
    expect(first).toBe(join(hostRoot, '.solus-chats', 'chat-a'))
    expect(second).toBe(join(hostRoot, '.solus-chats', 'chat-b'))
    expect(existsSync(first) && existsSync(second)).toBe(true)
  })

  test('the owner and a member use one rule: their own projects root, never the data folder', () => {
    const alice = chatFolderFor('chat-c', member('alice'), hostRoot)
    expect(alice).toBe(chatFolderIn(projectsRootFor(member('alice'), hostRoot), 'chat-c'))
    expect(isInside(projectsRootFor(member('alice'), hostRoot), alice)).toBe(true)
    expect(isInside(dataDir, alice)).toBe(false)
    expect(isInside(dataDir, chatFolderFor('chat-d', OWNER, hostRoot))).toBe(false)
  })

  test('a chat id that could walk the filesystem is refused', () => {
    expect(() => chatFolderFor('../escape', OWNER, hostRoot)).toThrow()
    expect(() => chatFolderFor('a/b', OWNER, hostRoot)).toThrow()
  })

  test('a projects root inside a Git work tree runs no chats', () => {
    const repoRoot = join(sandbox, 'repo-host')
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    expect(() => chatFolderFor('chat-e', OWNER, repoRoot)).toThrow(ChatUnavailableError)
  })
})

describe('isChat', () => {
  test('names a new chat, a chat folder, and the folder that holds them', () => {
    expect(isChat(NEW_CHAT_DIRECTORY)).toBe(true)
    expect(isChat(join(hostRoot, '.solus-chats', 'chat-a'))).toBe(true)
    expect(isChat(join(hostRoot, '.solus-chats', 'chat-a') + '/')).toBe(true)
    expect(isChat(join(hostRoot, '.solus-chats'))).toBe(true)
  })

  test('the home folder and a project are not chats', () => {
    expect(isChat('~')).toBe(false)
    expect(isChat('')).toBe(false)
    expect(isChat(join(hostRoot, 'solus'))).toBe(false)
    expect(isChat(join(hostRoot, '.solus-chats', 'chat-a', 'notes'))).toBe(false)
  })
})

describe('~ is the home folder', () => {
  test('a bare ~ and ~/x expand in the home folder', () => {
    expect(resolveHomePath('~')).toBe(homedir())
    expect(resolveHomePath('~/code')).toBe(join(homedir(), 'code'))
  })

  test('a new chat that reaches a process unresolved is refused, not run somewhere else', () => {
    expect(() => resolveHomePath(NEW_CHAT_DIRECTORY)).toThrow()
  })
})

describe('starting a chat', () => {
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
    const sessionRuntime = {
      isKnownSession: () => false,
      watchSession: (input: { sessionId: string }) => ({ sessionId: input.sessionId }),
      submitPrompt: async (ctx: IpcContext) => {
        prompted.push(ctx)
        return { disposition: 'started' }
      },
      bindRuntimeSession: () => null,
      busyWorkingTree: () => null,
    }
    registerSessionHandlers(
      { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx))) } as never,
      { sessionRuntime: sessionRuntime as never, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code', shares: shares as never },
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

  test('the folder a client names for its chat is made before the agent runs there', async () => {
    const folder = chatFolderIn(projectsRootFor(OWNER), 'chat-named')
    const chat = await startSession('chat-named', folder, OWNER)
    expect(chat.session.workingDirectory).toBe(folder)
    expect(chat.session.projectPath).toBe(folder)
    expect(existsSync(folder)).toBe(true)
  })

  test('a new chat with no folder gets one named by its session', async () => {
    const chat = await startSession('chat-new', NEW_CHAT_DIRECTORY, OWNER)
    expect(chat.session.workingDirectory).toBe(chatFolderIn(projectsRootFor(OWNER), 'chat-new'))
  })

  test('a bare ~ starts a session in the home folder path, not a chat', async () => {
    const session = await startSession('home-1', '~', OWNER)
    expect(session.session.workingDirectory).toBe('~')
  })

  test('a chat on an organization space gets no organization grant; a project session does', async () => {
    const alice = member('alice')

    await startSession('chat-1', NEW_CHAT_DIRECTORY, alice)
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
    const folder = chatFolderIn(projectsRootFor(member('alice')), 'chat-2')
    const ctx = { session: { sessionId: 'chat-2', agentSessionId: 'thread-2', workingDirectory: folder, projectPath: '' }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('bindRuntimeSession')!([ctx], { clientId: 'ws:chat-2', principal: member('alice') })
    expect(shareCalls).toEqual(['claim chat-2 private'])
  })
})
