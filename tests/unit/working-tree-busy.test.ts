import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// Plan 004 item 7: a git action or a new session in a working tree where
// another session runs a turn gets a "busy" answer, so the client can ask the
// person. It is not a lock, and the people in the running session are not asked.

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'solus-busy-tree-')))
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = join(sandbox, 'data')
process.env.SOLUS_PROJECTS_ROOT = join(sandbox, 'projects')

const { WORKING_TREE_BUSY_CODE } = await import('@solus/contracts/types')
// `SolusServer.handle()` resolves the actor before a handler runs (plans/012 §4).
const { withActor } = await import('./helpers/actors')
const { actorFor } = await import('@solus/server/admission/actor')
const { SessionRuntime } = await import('@solus/server/execution/session-runtime')
const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
const { registerWorktreeHandlers } = await import('@solus/server/transport/handlers/worktree-handlers')

const member = (userId: string): Principal => ({
  kind: 'org-member', userId, organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: userId === 'alice' ? 'Alice' : 'Bob', deviceId: `d-${userId}`, expiresAt: 0, deviceLabel: 'Solus cloud',
})
const ALICE = member('alice')
const BOB = member('bob')

const tree = join(sandbox, 'repo')
execFileSync('git', ['init', '-q', '-b', 'main', tree])
execFileSync('git', ['-C', tree, 'commit', '-q', '--allow-empty', '-m', 'base'], {
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
})

/** The runtime state the busy check reads: Alice's turn runs in `tree`, and her client watches it. */
const runtimeState = {
  activeRunRequests: new Map([['alice-session', {
    input: { workingDirectory: tree, gitContext: null },
    actor: actorFor(ALICE),
  }]]),
  sessionCheckoutPaths: new Map([['alice-session', tree]]),
  watches: new Map([['alice-session', new Set(['ws:alice'])]]),
}

type Handler = (args: unknown[], ctx: { clientId: string; principal: Principal }) => Promise<unknown>
const handlers = new Map<string, Handler>()
const started: string[] = []

beforeAll(() => {
  const sessionRuntime = {
    // The real runtime method, over the state above.
    busyWorkingTree: (path: string, asker: never) => SessionRuntime.prototype.busyWorkingTree.call(runtimeState as never, path, asker),
    isKnownSession: () => false,
    watchSession: (input: { sessionId: string }) => ({ sessionId: input.sessionId }),
    submitPrompt: async (ctx: IpcContext) => {
      started.push(ctx.session.sessionId)
      return { disposition: 'started' }
    },
    clientsWatching: () => [],
  }
  const server = { register: (name: string, handler: Handler) => handlers.set(name, (args, ctx) => handler(args, withActor(ctx))) } as never
  registerSessionHandlers(server, { sessionRuntime: sessionRuntime as never, orchestrator: { mayAnswer: () => true }, agentIdFromContext: () => 'claude-code' } as never)
  registerWorktreeHandlers(server, { sessionRuntime: sessionRuntime as never, events: { publish: () => {} } } as never)
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousProjectsRoot === undefined) delete process.env.SOLUS_PROJECTS_ROOT
  else process.env.SOLUS_PROJECTS_ROOT = previousProjectsRoot
})

function ctxFor(sessionId: string, extra: Partial<IpcContext['session']> = {}): IpcContext {
  return { session: { sessionId, agentSessionId: null, workingDirectory: tree, projectPath: tree, gitContext: { branch: 'main', targetBranch: 'main' }, ...extra }, settings: {}, statusBar: {} } as IpcContext
}

async function refusal(run: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await run
    return null
  } catch (error) {
    return error as { code?: string; message: string }
  }
}

describe('a busy working tree', () => {
  test('a new session in the tree gets the busy answer, and starts once the person continues', async () => {
    const bob = { clientId: 'ws:bob', principal: BOB }
    const busy = await refusal(handlers.get('prompt')!([ctxFor('bob-session'), { prompt: 'hi' }], bob))
    expect(busy?.code).toBe(WORKING_TREE_BUSY_CODE)
    expect(busy?.message).toBe('Alice has a session running in this working tree.')
    expect(started).toEqual([])

    await handlers.get('prompt')!([ctxFor('bob-session'), { prompt: 'hi', allowBusyWorkingTree: true }], bob)
    expect(started).toEqual(['bob-session'])
  })

  test('a new session that makes its own worktree shares no tree', async () => {
    started.length = 0
    await handlers.get('prompt')!([ctxFor('bob-worktree', { worktreeBaseBranch: 'main' }), { prompt: 'hi' }], { clientId: 'ws:bob', principal: BOB })
    expect(started).toEqual(['bob-worktree'])
  })

  test('a git action in the tree gets the busy answer before git runs', async () => {
    const busy = await refusal(handlers.get('gitRunAction')!([ctxFor('bob-session'), { actionId: 'a1', action: 'commit' }], { clientId: 'ws:bob', principal: BOB }))
    expect(busy?.code).toBe(WORKING_TREE_BUSY_CODE)
  })

  test('the running session is not busy for itself, nor for the people in it', async () => {
    // Past the busy check, the clean tree has nothing to commit: that is git's answer, not a busy one.
    const own = await refusal(handlers.get('gitRunAction')!([ctxFor('alice-session'), { actionId: 'a2', action: 'commit' }], { clientId: 'ws:bob', principal: BOB }))
    expect(own?.message).toBe('There are no local changes to commit.')
    const watcher = await refusal(handlers.get('gitRunAction')!([ctxFor('other-session'), { actionId: 'a3', action: 'commit' }], { clientId: 'ws:alice', principal: ALICE }))
    expect(watcher?.message).toBe('There are no local changes to commit.')
    started.length = 0
    await handlers.get('prompt')!([ctxFor('alice-second'), { prompt: 'hi' }], { clientId: 'ws:alice-phone', principal: ALICE })
    expect(started).toEqual(['alice-second'])
  })
})
