import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Principal } from '@solus/server/admission/principal'
import { isChat, NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'

// bun has no node:sqlite; the handler modules' import chain reaches the db even
// though these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// A chat (docs/plans/projectless-chat.md) is a session with no project. Each chat
// runs in a folder of its own, `solus-chats/<id>` in the host's data folder (a
// member's: in their member folder), so files from two chats never mix and no
// chat runs inside a Git repository.
// `~` is the home folder; only the explicit new-chat marker starts a chat.

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-chat-folder-')))
const dataDir = join(sandbox, 'data')
const hostRoot = join(sandbox, 'projects')
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = dataDir
process.env.SOLUS_PROJECTS_ROOT = hostRoot

const { ChatUnavailableError, chatFolderFor, makeChatFolder, projectsRootFor } = await import('@solus/server/workspace')
const { resolveHomePath } = await import('@solus/server/platform/paths')
const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
// `SolusServer.handle()` resolves the actor before a handler runs (plans/012 §4).
const { withActor } = await import('./helpers/actors')

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
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
    expect(first).toBe(join(dataDir, 'solus-chats', 'chat-a'))
    expect(second).toBe(join(dataDir, 'solus-chats', 'chat-b'))
    expect(existsSync(first) && existsSync(second)).toBe(true)
  })

  test('the owner\'s chats are outside the projects folder; a member\'s stay in their member folder', () => {
    expect(isInside(hostRoot, chatFolderFor('chat-d', OWNER, hostRoot))).toBe(false)
    const alice = chatFolderFor('chat-c', member('alice'), hostRoot)
    expect(alice).toBe(join(projectsRootFor(member('alice'), hostRoot), 'solus-chats', 'chat-c'))
    expect(isInside(dataDir, alice)).toBe(false)
  })

  test('a chat id that could walk the filesystem is refused', () => {
    expect(() => chatFolderFor('../escape', OWNER, hostRoot)).toThrow()
    expect(() => chatFolderFor('a/b', OWNER, hostRoot)).toThrow()
  })

  test('a chat home that is a Git repository runs no chats, and the error names it', () => {
    const repo = join(sandbox, 'repo-home')
    mkdirSync(join(repo, '.git'), { recursive: true })
    expect(() => makeChatFolder(repo, 'chat-e')).toThrow(ChatUnavailableError)
    expect(() => makeChatFolder(repo, 'chat-e')).toThrow(repo)
  })

  test('a repository in a parent folder, such as dotfiles in ~, does not turn chats off', () => {
    const parentRepo = join(sandbox, 'dotfiles-home')
    mkdirSync(join(parentRepo, '.git'), { recursive: true })
    expect(makeChatFolder(join(parentRepo, '.solus'), 'chat-f')).toBe(join(parentRepo, '.solus', 'solus-chats', 'chat-f'))
  })

  test('removing the repository turns chats back on without a restart', () => {
    const home = join(sandbox, 'was-a-repo')
    mkdirSync(join(home, '.git'), { recursive: true })
    expect(() => makeChatFolder(home, 'chat-g')).toThrow(ChatUnavailableError)
    rmSync(join(home, '.git'), { recursive: true })
    expect(existsSync(makeChatFolder(home, 'chat-g'))).toBe(true)
  })
})

describe('isChat', () => {
  test('names a new chat, a chat folder, and the folder that holds them', () => {
    expect(isChat(NEW_CHAT_DIRECTORY)).toBe(true)
    expect(isChat(join(dataDir, 'solus-chats', 'chat-a'))).toBe(true)
    expect(isChat(join(dataDir, 'solus-chats', 'chat-a') + '/')).toBe(true)
    expect(isChat(join(dataDir, 'solus-chats'))).toBe(true)
  })

  test('the home folder and a project are not chats', () => {
    expect(isChat('~')).toBe(false)
    expect(isChat('')).toBe(false)
    expect(isChat(join(hostRoot, 'solus'))).toBe(false)
    expect(isChat(join(dataDir, 'solus-chats', 'chat-a', 'notes'))).toBe(false)
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
  /** sessionId → the clients watching it, as the runtime keeps them. */
  const watches = new Map<string, Set<string>>()
  /** A claim waits for this before it lands, so a test can hold one open. */
  let claimGate: Promise<void> = Promise.resolve()

  beforeAll(() => {
    const shares = {
      claimSession: async (sessionId: string, _principal: Principal, options: { shareWithOrganization?: boolean } = {}) => {
        await claimGate
        shareCalls.push(`claim ${sessionId}${options.shareWithOrganization === false ? ' private' : ''}`)
      },
      shareWithOrganization: async (resource: Resource) => {
        shareCalls.push(`share ${resource.id}`)
      },
    }
    const sessionRuntime = {
      isKnownSession: (sessionId: string) => watches.has(sessionId),
      watchers: {
        watches,
        watchSession: (input: { sessionId: string }, clientId: string) => {
          watches.set(input.sessionId, (watches.get(input.sessionId) ?? new Set()).add(clientId))
          return { sessionId: input.sessionId }
        },
        bindRuntimeSession: () => null,
      },
      dispatch: {
        // No organization admission on this host: the folder rule is the subject here.
        admitTurn: async () => {},
        submitPrompt: async (ctx: IpcContext) => {
          prompted.push(ctx)
          return { disposition: 'started' }
        },
      },
    }
    registerSessionHandlers(
      { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx))) } as never,
      { sessionRuntime: sessionRuntime as never, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code', shares: shares as never },
    )
  })

  afterEach(() => {
    shareCalls.length = 0
    claimGate = Promise.resolve()
  })

  /** What a client does to start a session: watch it, then send the first prompt. */
  async function startSession(sessionId: string, workingDirectory: string, principal: Principal): Promise<IpcContext> {
    const handlerCtx = { clientId: `ws:${sessionId}`, principal }
    await handlers.get('watchSession')!([{ sessionId }], handlerCtx)
    const ctx = { session: { sessionId, workingDirectory, projectPath: workingDirectory }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('prompt')!([ctx, { prompt: 'hello' }], handlerCtx)
    return prompted.at(-1)!
  }

  test('a chat whose folder is gone gets it again before the agent runs there', async () => {
    const folder = join(dataDir, 'solus-chats', 'chat-named')
    const chat = await startSession('chat-named', folder, OWNER)
    expect(chat.session.workingDirectory).toBe(folder)
    expect(chat.session.projectPath).toBe(folder)
    expect(existsSync(folder)).toBe(true)
  })

  test('a new chat with no folder gets one named by its session', async () => {
    const chat = await startSession('chat-new', NEW_CHAT_DIRECTORY, OWNER)
    expect(chat.session.workingDirectory).toBe(join(dataDir, 'solus-chats', 'chat-new'))
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

  test('a prompt sent without waiting for its watch reply waits for the watch\'s claim before it shares the session', async () => {
    const alice = member('alice')
    const project = join(hostRoot, 'alice', 'solus')
    const handlerCtx = { clientId: 'ws:project-3', principal: alice }
    let openGate = (): void => {}
    claimGate = new Promise((resolve) => { openGate = resolve })
    // The client sends both at once; the host handles them at the same time.
    const watched = handlers.get('watchSession')!([{ sessionId: 'project-3' }], handlerCtx)
    const ctx = { session: { sessionId: 'project-3', workingDirectory: project, projectPath: project }, settings: {}, statusBar: {} } as IpcContext
    const promptedNow = handlers.get('prompt')!([ctx, { prompt: 'hello' }], handlerCtx)
    await Promise.resolve()
    // Sharing before the owner is named would find no owner and grant nothing.
    expect(shareCalls).toEqual([])
    openGate()
    await Promise.all([watched, promptedNow])
    expect(shareCalls).toEqual(['claim project-3 private', 'share project-3'])
  })

  test('a prompt makes its sender a watcher, so the run\'s events reach it before any watch reply', async () => {
    const project = join(hostRoot, 'solus')
    const ctx = { session: { sessionId: 'project-4', workingDirectory: project, projectPath: project }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('prompt')!([ctx, { prompt: 'hello' }], { clientId: 'ws:phone', principal: OWNER })
    expect([...watches.get('project-4') ?? []]).toEqual(['ws:phone'])
  })

  test('a watch that lands after its prompt does not decide the owner again', async () => {
    const alice = member('alice')
    const handlerCtx = { clientId: 'ws:chat-3', principal: alice }
    const ctx = { session: { sessionId: 'chat-3', workingDirectory: NEW_CHAT_DIRECTORY, projectPath: '' }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('prompt')!([ctx, { prompt: 'hello' }], handlerCtx)
    await handlers.get('watchSession')!([{ sessionId: 'chat-3' }], handlerCtx)
    // The prompt named a chat, so it claimed the session private. The late watch
    // only claims an owned session, which changes nothing, and grants nothing.
    expect(shareCalls).toEqual(['claim chat-3 private', 'claim chat-3'])
  })

  test('a chat that binds without a watch first also starts private', async () => {
    const folder = join(projectsRootFor(member('alice')), 'solus-chats', 'chat-2')
    const ctx = { session: { sessionId: 'chat-2', agentSessionId: 'thread-2', workingDirectory: folder, projectPath: '' }, settings: {}, statusBar: {} } as IpcContext
    await handlers.get('bindRuntimeSession')!([ctx], { clientId: 'ws:chat-2', principal: member('alice') })
    expect(shareCalls).toEqual(['claim chat-2 private'])
  })
})
